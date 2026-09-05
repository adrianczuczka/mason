import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { computeReview, defaultBase } from "./review.js";
import type { ReviewReport } from "./review.js";

export const USAGE = `Usage: mason-review [--dir <path>] [--base <ref>] [--json] [--evidence <manifest>] [--require-evidence]

Reviews the current branch's diff against what git history and the Mason
decision store know:
  - co-change partners the diff forgot: files that historically change
    together with a changed file (>=60% of its commits, >=4 shared) but are
    absent from this diff
  - recorded decisions whose anchor files the diff touches (informational)
Deterministic: no LLM call, no network – safe for CI.

Options:
  --dir <path>   Project root (default: current directory)
  --base <ref>   Base ref to diff against via merge-base (default: origin/HEAD,
                 origin/main, origin/master, or main – first that resolves)
  --json         Full report as JSON (additive-only schema)
  --evidence <manifest>  Import a CI evidence manifest (repeatable; paths inside --dir)
  --require-evidence    Require current, complete passing evidence; needs --evidence
  --help         Show this help

Exit codes:
  0  no missing co-change partners (touched decisions alone do not fail)
  1  missing co-change partners found
  2  error (base unresolvable, not a git repository, bad arguments)

Evidence is advisory unless --require-evidence is set. With that flag, current
failed checks also exit 1; missing, skipped, stale, or incomplete evidence exits 2.
No check command from an imported report is executed.`;

export interface ReviewCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

interface ParsedArgs {
  dir: string;
  base: string | undefined;
  json: boolean;
  help: boolean;
  evidence: string[];
  requireEvidence: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dir: process.cwd(),
    base: undefined,
    json: false,
    help: false,
    evidence: [], requireEvidence: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dir") {
      const value = argv[++i];
      if (!value) throw new Error("--dir requires a path argument");
      parsed.dir = value;
    } else if (arg === "--base") {
      const value = argv[++i];
      if (!value) throw new Error("--base requires a ref argument");
      parsed.base = value;
    } else if (arg === "--evidence") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--evidence requires a manifest path");
      parsed.evidence.push(value);
    } else if (arg === "--require-evidence") {
      parsed.requireEvidence = true;
    } else if (!arg.startsWith("-") && parsed.dir === process.cwd()) {
      parsed.dir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (parsed.requireEvidence && !parsed.evidence.length) throw new Error("--require-evidence requires at least one --evidence manifest");
  return parsed;
}

const display = (value: string, limit = 500) => stripVTControlCharacters(value).replace(/[\r\n\t]/g, " ").slice(0, limit);

function evidenceSummary(report: ReviewReport): string[] {
  const evidence = report.evidence;
  if (!evidence) return [];
  const lines = [`Imported CI evidence: ${evidence.status} (commit ${evidence.headHash.slice(0, 12)}; committed scope).`];
  for (const diagnostic of evidence.diagnostics) lines.push(`  Evidence unavailable: ${display(diagnostic)}`);
  for (const check of evidence.checks) {
    lines.push(`  [${check.kind}] ${display(check.id)}: ${check.outcome}, ${check.freshness} (${display(check.tool)})`);
    lines.push(`    command: ${display(check.command)}; tested commit: ${check.commit ?? "unknown"}`);
    lines.push(`    source: ${display(check.source ?? check.manifest)}; report: ${display(check.report?.path ?? "none")}`);
    if (Object.keys(check.counts).length) lines.push(`    counts: ${JSON.stringify(check.counts)}`);
    for (const diagnostic of check.diagnostics.slice(0, 5)) lines.push(`    note: ${display(diagnostic)}`);
    for (const finding of check.findings.slice(0, 10)) {
      const locations = finding.locations.map(l => `${l.file}${l.line ? `:${l.line}` : ""}`).join(", ") || "no resolved file location";
      lines.push(`    [${finding.state}/${finding.severity}] ${display(finding.ruleId ?? finding.id)} ${display(locations)}: ${display(finding.message)}`);
      if (finding.relatedChangedFiles.length) lines.push(`      changed files: ${finding.relatedChangedFiles.map(f => `${display(f.file)} (${f.relationship}${f.confidence ? `, ${f.confidence}` : ""})`).join(", ")}`);
      for (const decision of finding.acceptedDecisions) lines.push(`      related accepted decision: ${display(decision.id)}; owner ${display(decision.owner ?? "unknown")}; freshness ${decision.freshness}${decision.reviewRequired ? "; needs review" : ""}`);
    }
    if (check.totalFindings > 10 || check.truncated || check.diagnostics.length > 5) lines.push(`    Output abbreviated (${check.totalFindings} findings); inspect --json and the original artifact for full evidence.`);
  }
  if (!evidence.workingTree.available) lines.push("  Working-tree state unavailable; imported evidence only describes the recorded commit.");
  else if (evidence.workingTree.changedFiles.length) lines.push(`  ${evidence.workingTree.changedFiles.length} uncommitted paths are outside this evidence's scope.`);
  lines.push("  Related decisions are associations, not proven violations. Passing imported checks do not establish complete coverage.");
  return lines;
}

export function formatReviewSummary(report: ReviewReport): string {
  const lines: string[] = [];
  lines.push(
    `Diff vs ${report.base} (merge-base ${report.mergeBase.slice(0, 7)}): ${report.changedFiles.length} changed file${report.changedFiles.length === 1 ? "" : "s"}.`
  );
  for (const diagnostic of report.diagnostics ?? []) lines.push(`Invalid decision record ${diagnostic.path}: ${diagnostic.message}`);
  if (report.truncated) {
    lines.push(
      `Large diff – co-change analysis limited to the first ${50} files.`
    );
  }
  if (!report.historyAvailable) {
    lines.push(
      "Git history unavailable (shallow clone?) – co-change analysis skipped."
    );
  }

  if (report.missingPartners.length > 0) {
    lines.push("Possible forgotten co-change partners:");
    for (const f of report.missingPartners) {
      lines.push(
        `  [missing-partner] ${f.changedFile} changed without ${f.missingPartner} – they changed together in ${Math.round(f.rate * 100)}% of ${f.changedFile}'s last ${f.fileCommits} commits (${f.sharedCommits} shared)`
      );
    }
  }

  if (report.touchedDecisions.length > 0) {
    lines.push("Recorded decisions touched by this diff (check approval and freshness before relying on them):");
    for (const d of report.touchedDecisions) {
      lines.push(
        `  [decision] ${d.title} (${d.category}; ${d.approval ?? "unreviewed"}; owner ${d.owner ?? "unknown"}; freshness ${d.freshness ?? "unknown"}; via ${d.touchedFiles.join(", ")})`
      );
      if (d.sources?.length) lines.push(`    sources: ${d.sources.map(s => s.reference).join(", ")}`);
      if (d.lastReview) lines.push(`    last review: ${d.lastReview.reviewer} at ${d.lastReview.gitHash.slice(0, 7)}`);
    }
  }

  lines.push(
    report.missingPartners.length === 0
      ? "No missing co-change partners."
      : `${report.missingPartners.length} possible omission${report.missingPartners.length === 1 ? "" : "s"}.`
  );
  lines.push(...evidenceSummary(report));
  return lines.join("\n");
}

export async function runReviewCli(
  argv: string[],
  io: ReviewCliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
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
  const base = args.base ?? (await defaultBase(rootDir));
  if (!base) {
    io.err(
      `Could not find a base ref in ${rootDir} (tried origin/HEAD, origin/main, origin/master, main). Pass one with --base.`
    );
    return 2;
  }

  const report = await computeReview(rootDir, base, args.evidence.length ? { evidence: args.evidence } : {});
  if (!report) {
    io.err(
      `Could not resolve a merge base between ${base} and HEAD in ${rootDir} – not a git repository, unknown ref, or unrelated histories.`
    );
    return 2;
  }

  if (args.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatReviewSummary(report));
    if (args.evidence.length && !args.requireEvidence) io.out("Imported evidence is advisory for exit codes; use --require-evidence to require current passing checks.");
  }
  if (args.requireEvidence && report.evidence?.status !== "passed") return report.evidence?.status === "failed" ? 1 : 2;
  return report.missingPartners.length > 0 ? 1 : 0;
}
