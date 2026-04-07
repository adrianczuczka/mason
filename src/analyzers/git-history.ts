import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BaseAnalyzer } from "./base.js";
import type { AnalyzerContext, AnalyzerResult, Finding, Gap } from "../types.js";

const exec = promisify(execFile);

export class GitHistoryAnalyzer extends BaseAnalyzer {
  name = "git-history";

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    if (!context.gitAvailable) {
      return this.createResult([], [], startTime);
    }

    const [staleFindings, staleGaps] = await this.findStaleDirectories(context);
    findings.push(...staleFindings);
    gaps.push(...staleGaps);

    const hotFindings = await this.findHotFiles(context);
    findings.push(...hotFindings);

    const commitFindings = await this.analyzeCommitPatterns(context);
    findings.push(...commitFindings);

    return this.createResult(findings, gaps, startTime);
  }

  private async git(
    args: string[],
    cwd: string
  ): Promise<string> {
    try {
      const { stdout } = await exec("git", args, { cwd, maxBuffer: 10_000_000 });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  private async findStaleDirectories(
    context: AnalyzerContext
  ): Promise<[Finding[], Gap[]]> {
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    // Get top-level directories with their last commit date
    const output = await this.git(
      ["log", "--all", "--format=%ci", "--name-only", "--diff-filter=AMCR", "-n", "500"],
      context.rootDir
    );

    if (!output) return [findings, gaps];

    const dirLastTouch = new Map<string, Date>();
    let currentDate: Date | null = null;

    for (const line of output.split("\n")) {
      if (!line) continue;
      if (/^\d{4}-\d{2}-\d{2}/.test(line)) {
        currentDate = new Date(line);
      } else if (currentDate) {
        const topDir = line.split("/")[0];
        if (
          topDir &&
          !topDir.startsWith(".") &&
          !topDir.includes("node_modules")
        ) {
          const existing = dirLastTouch.get(topDir);
          if (!existing || currentDate > existing) {
            dirLastTouch.set(topDir, currentDate);
          }
        }
      }
    }

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    for (const [dir, lastTouch] of dirLastTouch) {
      if (lastTouch < sixMonthsAgo) {
        const monthsStale = Math.floor(
          (Date.now() - lastTouch.getTime()) / (1000 * 60 * 60 * 24 * 30)
        );
        findings.push(
          this.createFinding({
            category: "risk",
            confidence: 0.7,
            summary: `Directory "${dir}" hasn't been modified in ${monthsStale} months`,
            evidence: [
              { filePath: dir, detail: `Last commit: ${lastTouch.toISOString().split("T")[0]}` },
            ],
            ruleCandidate: `Do not refactor or modify files in "${dir}/" unless explicitly asked — this area has been stable for ${monthsStale} months and may be legacy code.`,
          })
        );
        gaps.push({
          analyzer: this.name,
          question: `Directory "${dir}" hasn't been touched in ${monthsStale} months. Is it deprecated, stable, or legacy?`,
          context: `Last modified: ${lastTouch.toISOString().split("T")[0]}`,
          answerKey: `stale-dir-${dir}`,
        });
      }
    }

    return [findings, gaps];
  }

  private async findHotFiles(context: AnalyzerContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    // Most frequently changed files in the last 3 months
    const output = await this.git(
      ["log", "--since=3 months ago", "--format=", "--name-only"],
      context.rootDir
    );

    if (!output) return findings;

    const fileCounts = new Map<string, number>();
    for (const line of output.split("\n")) {
      if (!line || line.startsWith(".") || line.includes("node_modules")) continue;
      fileCounts.set(line, (fileCounts.get(line) ?? 0) + 1);
    }

    const sorted = [...fileCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sorted.length > 0 && sorted[0][1] >= 5) {
      const hotFiles = sorted.filter(([, count]) => count >= 5);
      if (hotFiles.length > 0) {
        findings.push(
          this.createFinding({
            category: "risk",
            confidence: 0.8,
            summary: `${hotFiles.length} files changed frequently in the last 3 months`,
            evidence: hotFiles.map(([file, count]) => ({
              filePath: file,
              detail: `${count} commits`,
            })),
            ruleCandidate: `These files change frequently and are high-risk for conflicts: ${hotFiles.map(([f]) => f).join(", ")}. Take extra care when modifying them.`,
          })
        );
      }
    }

    return findings;
  }

  private async analyzeCommitPatterns(
    context: AnalyzerContext
  ): Promise<Finding[]> {
    const findings: Finding[] = [];

    const output = await this.git(
      ["log", "--format=%s", "-n", "100"],
      context.rootDir
    );

    if (!output) return findings;

    const messages = output.split("\n").filter(Boolean);

    // Check for conventional commits
    const conventionalPattern = /^(feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\(.+\))?:/;
    const conventionalCount = messages.filter((m) =>
      conventionalPattern.test(m)
    ).length;
    const conventionalRatio = conventionalCount / messages.length;

    if (conventionalRatio > 0.5) {
      findings.push(
        this.createFinding({
          category: "convention",
          confidence: Math.min(conventionalRatio + 0.1, 1),
          summary: `${Math.round(conventionalRatio * 100)}% of recent commits use conventional commit format`,
          evidence: [
            {
              filePath: ".git",
              detail: `${conventionalCount} of ${messages.length} commits match`,
            },
          ],
          ruleCandidate:
            "Use conventional commit format: type(scope): description (e.g., feat(auth): add login endpoint)",
        })
      );
    }

    // Check for ticket/issue references
    const ticketPattern = /[A-Z]+-\d+|#\d+/;
    const ticketCount = messages.filter((m) => ticketPattern.test(m)).length;
    const ticketRatio = ticketCount / messages.length;

    if (ticketRatio > 0.3) {
      findings.push(
        this.createFinding({
          category: "convention",
          confidence: ticketRatio,
          summary: `${Math.round(ticketRatio * 100)}% of commits reference issue/ticket IDs`,
          evidence: [
            {
              filePath: ".git",
              detail: `${ticketCount} of ${messages.length} commits have ticket refs`,
            },
          ],
          ruleCandidate:
            "Include issue/ticket references in commit messages when applicable.",
        })
      );
    }

    return findings;
  }
}
