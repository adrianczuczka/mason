import path from "node:path";
import { computeDrift } from "./drift.js";
import type { DriftReport } from "./drift.js";
import { computeDecisionDrift } from "../decisions/drift.js";
import type { DecisionDriftReport } from "../decisions/drift.js";

export const USAGE = `Usage: mason-drift [--dir <path>] [--json | --refresh-prompt]

Checks the Mason concept map (.mason/snapshot.json) against git HEAD.
Deterministic: no LLM call, no network — safe for CI.

Options:
  --dir <path>       Project root to check (default: current directory)
  --json             Print the full drift report as JSON
  --refresh-prompt   When stale, print refresh instructions for ANY coding
                     assistant with the Mason MCP server connected (Claude,
                     Codex, Gemini, ...) — pipe it to your agent CLI to
                     close the loop. Prints nothing extra when fresh.
  --help             Show this help

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
  refreshPrompt: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dir: process.cwd(),
    json: false,
    refreshPrompt: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--refresh-prompt") {
      parsed.refreshPrompt = true;
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
    const lines = [`Concept map is up to date against committed source (HEAD ${report.headHash.slice(0, 7)}).`];
    if (report.workingTree?.changedFiles.length) lines.push(`Working tree has ${report.workingTree.changedFiles.length} changed files; live context checks report these separately.`);
    if (report.verification?.failed.length) lines.push(`Verification FAILED: ${report.verification.failed.join(", ")}. Correct these entries before relying on them.`);
    return lines.join("\n");
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

/**
 * Provider-neutral refresh instructions: any coding assistant with the
 * Mason MCP server connected can execute them — no Claude/Codex/Gemini
 * assumptions. This is the automation half of "the map maintains itself":
 * CI detects with this binary (free, deterministic), then pipes this
 * prompt to whatever headless agent the team runs.
 */
export function formatRefreshPrompt(
  report: DriftReport,
  decisionDrift: DecisionDriftReport
): string {
  const lines: string[] = [];
  lines.push(
    "The Mason concept map for this project is stale. Refresh it using the Mason MCP tools (server name: mason). Work autonomously; do not ask questions. Modify ONLY the concept map via Mason tools — do not edit source files."
  );
  lines.push("");
  lines.push("DRIFT REPORT (deterministic, computed against git HEAD):");
  lines.push(
    JSON.stringify(
      {
        commitsBehind: report.commitsBehind,
        recommendation: report.recommendation,
        staleFeatures: report.staleFeatures,
        staleFlows: report.staleFlows,
        changedFiles: report.changedFiles,
        unmappedFiles: report.unmappedFiles,
        ghostFiles: report.ghostFiles,
        renames: report.renames,
      },
      null,
      2
    )
  );
  lines.push("");

  const scopedFiles = [...report.changedFiles, ...report.unmappedFiles];
  if (!report.historyAvailable || report.recommendation === "full-rebuild") {
    lines.push(
      "PROCEDURE (full rebuild): run the complete Map-Reduce build. Call generate_snapshot_batch repeatedly (follow nextOffset until null), calling save_partial_snapshot after each batch, then reduce_snapshot, then save_snapshot once with the unified map. Derive features ONLY from files shown in each batch prompt — never invent paths."
    );
  } else {
    lines.push(
      "PROCEDURE (scoped refresh): call generate_snapshot_batch with the files list below — the SAME list on every call — following nextOffset until null, calling save_partial_snapshot after each batch. Then call reduce_snapshot (it merges into the existing map, preserving untouched entries) and save_snapshot once. Use save_snapshot's removeFeatures/removeFlows for features that no longer exist (see ghostFiles/renames). Derive features ONLY from files shown in each batch prompt — never invent paths."
    );
    lines.push("");
    lines.push(`files: ${JSON.stringify(scopedFiles)}`);
  }

  const staleDecisionIds = Object.keys(decisionDrift.staleDecisions);
  if (staleDecisionIds.length > 0) {
    lines.push("");
    lines.push(
      `NOTE: decisions [${staleDecisionIds.join(", ")}] have anchor files that changed. Do NOT modify decision records in this automated run — they encode human knowledge. Mention them in your final summary so the team re-verifies them.`
    );
  }
  const changedProposals = Object.entries(decisionDrift.pendingProposals ?? {}).filter(([, state]) => state.freshness !== "current").map(([id]) => id);
  if (changedProposals.length) lines.push(`NOTE: pending proposals [${changedProposals.join(", ")}] need source review. Their accepted revisions remain operative. Do NOT modify or accept these proposals during automated map refresh.`);

  lines.push("");
  lines.push(
    "Finish by confirming the map was saved and summarizing which entries changed."
  );
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
    if (args.json && args.refreshPrompt) {
      throw new Error("--json and --refresh-prompt are mutually exclusive");
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
  let report: DriftReport | null;
  try { report = await computeDrift(rootDir); } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

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

  if (args.refreshPrompt) {
    io.out(
      report.stale
        ? formatRefreshPrompt(report, decisionDrift)
        : formatDriftSummary(report)
    );
    return report.stale ? 1 : 0;
  }

  if (args.json) {
    const output: DriftReport & { decisions?: DecisionDriftReport } = report;
    if (decisionDrift.totalDecisions > 0 || decisionDrift.diagnostics?.length) {
      output.decisions = decisionDrift;
    }
    io.out(JSON.stringify(output, null, 2));
  } else {
    const lines = [formatDriftSummary(report)];
    for (const diagnostic of decisionDrift.diagnostics ?? []) lines.push(`Invalid decision record ${diagnostic.path}: ${diagnostic.message}`);
    const unknownIds = Object.entries(decisionDrift.freshness ?? {}).filter(([, state]) => state === "unknown").map(([id]) => id);
    if (unknownIds.length) lines.push(`Decision freshness unknown: ${unknownIds.join(", ")}. Verify before relying on them.`);
    const staleIds = Object.keys(decisionDrift.staleDecisions);
    if (staleIds.length > 0) {
      lines.push(
        `Decisions needing verification (${staleIds.length}/${decisionDrift.totalDecisions}): ${staleIds.join(", ")}`
      );
    }
    for (const [id, proposal] of Object.entries(decisionDrift.pendingProposals ?? {})) {
      lines.push(`Pending proposal ${id}: freshness ${proposal.freshness}; the accepted revision remains operative.`);
    }
    io.out(lines.join("\n"));
  }
  return report.stale ? 1 : 0;
}
