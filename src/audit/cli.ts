import path from "node:path";
import { computeAudit } from "./audit.js";
import { ALL_CHECKS } from "./types.js";
import { prepareRepair, verifyRepair, formatRepairSummary, repairExitCode } from "./repair.js";
import type { AuditIssue, AuditReport, CheckName } from "./types.js";

export const USAGE = `Usage: mason-audit [--dir <path>] [--json | --fix-prompt] [--checks <list>]

Audits the repo's AI context files (CLAUDE.md, .claude/CLAUDE.md, AGENTS.md)
against repo reality: referenced paths that no longer exist, undocumented
modules, stale counts, dead npm scripts, and manifests newer than the doc.
Deterministic: no LLM call, no network – safe for CI. Works on any repo with
a context file; no Mason setup required.

Options:
  --dir <path>     Project root to audit (default: current directory)
  --json           Print the full audit report as JSON (additive-only schema)
  --fix-prompt     When issues exist, print a work order for ANY coding agent
                   (Claude, Codex, Gemini, ...) – pipe it to your agent CLI to
                   repair the findings. Includes advisories that require review.
  --prepare-repair Save the original audit under .mason/reports/repairs/ before edits
  --verify-repair <path>
                   Compare against that saved baseline, using its original checks
  --checks <list>  Comma-separated subset of checks to run (default: all):
                   ${ALL_CHECKS.join(", ")}
  --help           Show this help

Exit codes:
  0  no issues (advisories may still be present)
  1  provable issues found
  2  error (no context file, not a git repository, bad arguments)

With --verify-repair: 0 verified by the original checks; 1 issues remain;
2 incomplete (unverified findings, skipped checks, or advisories needing review).
Preparation writes only a baseline; verification and ordinary audits are read-only.`;

export interface AuditCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

interface ParsedArgs {
  dir: string;
  json: boolean;
  fixPrompt: boolean;
  help: boolean;
  checks: CheckName[] | undefined;
  prepareRepair: boolean;
  baseline?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dir: process.cwd(),
    json: false,
    fixPrompt: false,
    help: false,
    checks: undefined,
    prepareRepair: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--fix-prompt") {
      parsed.fixPrompt = true;
    } else if (arg === "--prepare-repair") {
      parsed.prepareRepair = true;
    } else if (arg === "--verify-repair") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--verify-repair requires a baseline path");
      parsed.baseline = value;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dir") {
      const value = argv[++i];
      if (!value) throw new Error("--dir requires a path argument");
      parsed.dir = value;
    } else if (arg === "--checks") {
      const value = argv[++i];
      if (!value) throw new Error("--checks requires a comma-separated list");
      const names = value.split(",").map((n) => n.trim()).filter(Boolean);
      if (!names.length) throw new Error("--checks requires at least one check");
      for (const name of names) {
        if (!ALL_CHECKS.includes(name as CheckName)) {
          throw new Error(
            `Unknown check: ${name} (valid: ${ALL_CHECKS.join(", ")})`
          );
        }
      }
      parsed.checks = names as CheckName[];
    } else if (!arg.startsWith("-") && parsed.dir === process.cwd()) {
      parsed.dir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function issueLine(issue: AuditIssue): string {
  const where =
    issue.anchor.line !== null ? `line ${issue.anchor.line}` : "doc-level";
  const likely = issue.confidence === "likely" ? " (likely)" : "";
  return `  [${issue.type}]${likely} ${where}: ${issue.message}`;
}

export function formatAuditSummary(report: AuditReport): string {
  const lines: string[] = [];
  const reviewCount = report.advisories.length + (report.suppressedAdvisories?.length ?? 0);

  for (const doc of report.docs) {
    const docIssues = report.issues.filter((i) => i.anchor.doc === doc.path);
    const committed = doc.lastCommit
      ? `last committed ${doc.lastCommit.date.slice(0, 10)}, ${doc.lastCommit.hash.slice(0, 7)}`
      : "untracked";
    if (docIssues.length === 0) {
      lines.push(`${doc.path} – clean (${committed})`);
      continue;
    }
    lines.push(
      `${doc.path} – ${docIssues.length} issue${docIssues.length === 1 ? "" : "s"} (${committed})`
    );
    for (const issue of docIssues) lines.push(issueLine(issue));
  }

  // Issues anchored outside the docs list (defensive; new-module anchors to
  // the primary doc, so this should stay empty).
  const docPaths = new Set(report.docs.map((d) => d.path));
  for (const issue of report.issues) {
    if (!docPaths.has(issue.anchor.doc)) lines.push(issueLine(issue));
  }

  if (report.advisories.length > 0) {
    lines.push("Advisories (do not affect the exit code):");
    for (const advisory of report.advisories) {
      lines.push(`  [${advisory.type}] ${advisory.anchor.doc}: ${advisory.message}`);
    }
  }
  if (report.skippedChecks.length > 0) {
    for (const skip of report.skippedChecks) {
      lines.push(`  [skipped] ${skip.check}: ${skip.reason}`);
    }
  }

  for (const advisory of report.suppressedAdvisories ?? []) {
    lines.push(`  [suppressed; unresolved] ${advisory.type} ${advisory.anchor.doc}: ${advisory.message}`);
  }

  lines.push(
    report.clean
      ? reviewCount || report.skippedChecks.length
        ? `No audit issues detected (${report.docs.length} docs audited); ${reviewCount} advisories remain for review, ${report.skippedChecks.length} checks skipped.`
        : `Context files are clean (${report.docs.length} doc${report.docs.length === 1 ? "" : "s"} audited).`
      : `${report.issues.length} issue${report.issues.length === 1 ? "" : "s"} across ${report.docs.length} doc${report.docs.length === 1 ? "" : "s"}.`
  );
  return lines.join("\n");
}

/**
 * Provider-neutral work order: any coding agent can execute it. The evidence
 * is deterministic; the agent's job is judgment scoped to exactly these
 * claims – never a free-form doc rewrite.
 */
export function formatFixPrompt(report: AuditReport, baselinePath?: string): string {
  const flaggedDocs = [...new Set(report.issues.map((i) => i.anchor.doc))];
  const lines: string[] = [];
  lines.push(
    "Review the flagged context claims using the evidence below. Make minimal repairs within the user's authorized scope. A setup-only or audit-only request does not authorize rewriting existing documentation."
  );
  lines.push("");
  lines.push("RULES:");
  lines.push(baselinePath
    ? `- Preserve the original repair baseline: ${JSON.stringify(baselinePath)}. Do not replace it after editing.`
    : "- Before the first edit, call mason_repair with action: prepare, or run mason-audit --prepare-repair --json with the same --dir and --checks. Keep the returned baselinePath through verification.");
  lines.push(
    `- Edit ONLY these files: ${flaggedDocs.join(", ") || "none (advisory review only)"}. Bring the docs into agreement with verified source evidence; do not change source code or configs to silence findings.`
  );
  lines.push(
    "- Keep diffs minimal: change the smallest span that makes each claim true."
  );
  lines.push(
    "- Never invent content. Every replacement must be grounded in the evidence below or in files you read from this repository."
  );
  lines.push("- Inspect likely findings before editing: heuristic evidence may describe an intentional omission or an example.");
  lines.push(
    "- deleted-reference: if evidence shows renamedTo, update the path; otherwise remove the reference, or rephrase to past tense if the sentence is about history. Deleted paths inside directory trees: delete the tree line."
  );
  lines.push(
    "- stale-count: replace the number with the actual count from the evidence."
  );
  lines.push(
    "- dead-command: replace with the correct script from availableScripts if an obvious rename exists; otherwise remove the command mention."
  );
  lines.push(
    "- new-module: add a one-line factual mention of the directory where sibling modules are described; read the directory's files first and describe only what you verified."
  );
  lines.push(
    "- ADVISORIES require a separate assessment of the cited commits or decision evidence. Report any review you perform and what remains unknown. Their disappearance after edits or a commit does not establish review or approval."
  );
  lines.push("");
  lines.push("AUDIT REPORT (current context files and repository evidence, including local edits):");
  lines.push(
    JSON.stringify(
      { root: report.root, checks: report.checksRun, issues: report.issues, advisories: report.advisories,
        suppressedAdvisories: report.suppressedAdvisories, skippedChecks: report.skippedChecks },
      null,
      2
    )
  );
  lines.push("");
  lines.push(
    "After edits, call mason_repair with action: verify and the original baselinePath, or mason-audit --verify-repair <baselinePath> --dir <project>. Repeat against the same baseline after any final documentation commit. Summarize resolved, unresolved, review-required, unverified, and new findings with their evidence. Do not report a suppressed or unavailable check as fixed. This audit covers the listed context files; independently discovered README or application issues need their own validation."
  );
  return lines.join("\n");
}

export async function runAuditCli(
  argv: string[],
  io: AuditCliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
    if (args.json && args.fixPrompt) {
      throw new Error("--json and --fix-prompt are mutually exclusive");
    }
    if (args.baseline && (args.prepareRepair || args.checks || args.fixPrompt)) {
      throw new Error("--verify-repair cannot be combined with --prepare-repair, --checks, or --fix-prompt; verification uses the original scope");
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }

  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  const rootDir = path.resolve(args.dir);
  if (args.baseline || args.prepareRepair) {
    try {
      if (args.baseline) {
        const verification = await verifyRepair(rootDir, args.baseline);
        io.out(args.json ? JSON.stringify(verification, null, 2) : formatRepairSummary(verification));
        return repairExitCode(verification);
      }
      const prepared = await prepareRepair(rootDir, args.checks);
      io.out(args.json ? JSON.stringify({ ...prepared, workOrder: formatFixPrompt(prepared.report, prepared.baselinePath) }, null, 2)
        : args.fixPrompt ? formatFixPrompt(prepared.report, prepared.baselinePath)
        : `Repair baseline: ${prepared.baselinePath}\n${formatAuditSummary(prepared.report)}`);
      return prepared.report.clean ? 0 : 1;
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  const report = await computeAudit(rootDir, { checks: args.checks });

  if (!report) {
    io.err(
      `No CLAUDE.md, .claude/CLAUDE.md, or AGENTS.md found in ${rootDir}.`
    );
    return 2;
  }

  if (!report.gitAvailable) {
    io.err(
      `Could not determine git HEAD in ${rootDir} – not a git repository, or git is unavailable.`
    );
    return 2;
  }

  if (args.fixPrompt) {
    io.out(
      report.clean && !report.advisories.length && !report.suppressedAdvisories?.length
        ? formatAuditSummary(report) : formatFixPrompt(report)
    );
    return report.clean ? 0 : 1;
  }

  if (args.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatAuditSummary(report));
  }
  return report.clean ? 0 : 1;
}
