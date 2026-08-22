import path from "node:path";
import { computeReview, defaultBase } from "./review.js";
import type { ReviewReport } from "./review.js";

export const USAGE = `Usage: mason-review [--dir <path>] [--base <ref>] [--json]

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
  --help         Show this help

Exit codes:
  0  no missing co-change partners (touched decisions alone do not fail)
  1  missing co-change partners found
  2  error (base unresolvable, not a git repository, bad arguments)`;

export interface ReviewCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

interface ParsedArgs {
  dir: string;
  base: string | undefined;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dir: process.cwd(),
    base: undefined,
    json: false,
    help: false,
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
    } else if (!arg.startsWith("-") && parsed.dir === process.cwd()) {
      parsed.dir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export function formatReviewSummary(report: ReviewReport): string {
  const lines: string[] = [];
  lines.push(
    `Diff vs ${report.base} (merge-base ${report.mergeBase.slice(0, 7)}): ${report.changedFiles.length} changed file${report.changedFiles.length === 1 ? "" : "s"}.`
  );
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
    lines.push("Recorded decisions touched by this diff (constraints – verify the diff respects them):");
    for (const d of report.touchedDecisions) {
      lines.push(
        `  [decision] ${d.title} (${d.category}; via ${d.touchedFiles.join(", ")})`
      );
    }
  }

  lines.push(
    report.missingPartners.length === 0
      ? "No missing co-change partners."
      : `${report.missingPartners.length} possible omission${report.missingPartners.length === 1 ? "" : "s"}.`
  );
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

  const report = await computeReview(rootDir, base);
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
  }
  return report.missingPartners.length > 0 ? 1 : 0;
}
