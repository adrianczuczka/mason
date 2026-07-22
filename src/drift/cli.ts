import path from "node:path";
import { computeDrift } from "./drift.js";
import type { DriftReport } from "./drift.js";
import { computeDecisionDrift } from "../decisions/drift.js";
import type { DecisionDriftReport } from "../decisions/drift.js";

export const USAGE = `Usage: mason-drift [--dir <path>] [--json]

Checks the Mason concept map (.mason/snapshot.json) against git HEAD.
Deterministic: no LLM call, no network — safe for CI.

Options:
  --dir <path>   Project root to check (default: current directory)
  --json         Print the full drift report as JSON
  --help         Show this help

Exit codes:
  0  concept map is up to date
  1  concept map is stale
  2  error (no snapshot, not a git repository, bad arguments)`;

export interface DriftCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

interface ParsedArgs {
  dir: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { dir: process.cwd(), json: false, help: false };
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
    } else if (!arg.startsWith("-") && parsed.dir === process.cwd()) {
      parsed.dir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export function formatDriftSummary(report: DriftReport): string {
  if (!report.stale) {
    return `Concept map is up to date (HEAD ${report.headHash.slice(0, 7)}).`;
  }

  const lines: string[] = [];
  const behind =
    report.commitsBehind !== null
      ? `${report.commitsBehind} commit${report.commitsBehind === 1 ? "" : "s"} behind HEAD`
      : "an unknown number of commits behind HEAD";
  lines.push(`Concept map is STALE — ${behind}.`);

  if (!report.historyAvailable) {
    lines.push(
      "The snapshot's base commit is unreachable (shallow clone or rewritten history); per-feature drift could not be computed."
    );
  }

  const staleFeatures = Object.keys(report.staleFeatures);
  const staleFlows = Object.keys(report.staleFlows);
  if (staleFeatures.length > 0) {
    lines.push(
      `Stale features (${staleFeatures.length}/${report.totalFeatures}): ${staleFeatures.join(", ")}`
    );
  }
  if (staleFlows.length > 0) {
    lines.push(
      `Stale flows (${staleFlows.length}/${report.totalFlows}): ${staleFlows.join(", ")}`
    );
  }
  if (report.unmappedFiles.length > 0) {
    lines.push(
      `Unmapped new files (${report.unmappedFiles.length}): ${report.unmappedFiles.join(", ")}`
    );
  }
  if (report.ghostFiles.length > 0) {
    lines.push(
      `Ghost files — mapped but deleted (${report.ghostFiles.length}): ${report.ghostFiles.join(", ")}`
    );
  }
  lines.push(`Recommendation: ${report.recommendation}`);
  return lines.join("\n");
}

export async function runDriftCli(
  argv: string[],
  io: DriftCliIo = {
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
  const report = await computeDrift(rootDir);

  if (!report) {
    io.err(
      `No Mason snapshot found at ${path.join(rootDir, ".mason", "snapshot.json")}. Build one via the Mason MCP server first.`
    );
    return 2;
  }

  if (report.headHash === "unknown") {
    io.err(
      `Could not determine git HEAD in ${rootDir} — not a git repository, or git is unavailable.`
    );
    return 2;
  }

  // Additive: decision staleness never changes exit codes — `stale` and the
  // 0/1/2 contract keep meaning MAP staleness for existing CI consumers.
  const decisionDrift = await computeDecisionDrift(rootDir);

  if (args.json) {
    const output: DriftReport & { decisions?: DecisionDriftReport } = report;
    if (decisionDrift.totalDecisions > 0) {
      output.decisions = decisionDrift;
    }
    io.out(JSON.stringify(output, null, 2));
  } else {
    const lines = [formatDriftSummary(report)];
    const staleIds = Object.keys(decisionDrift.staleDecisions);
    if (staleIds.length > 0) {
      lines.push(
        `Decisions needing verification (${staleIds.length}/${decisionDrift.totalDecisions}): ${staleIds.join(", ")}`
      );
    }
    io.out(lines.join("\n"));
  }
  return report.stale ? 1 : 0;
}
