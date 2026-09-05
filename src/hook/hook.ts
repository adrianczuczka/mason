import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadDecisionStore } from "../decisions/decisions.js";
import { decisionProvenance } from "../decisions/provenance.js";
import { anchorMatches } from "../utils/paths.js";
import { createHash } from "node:crypto";
import type { Freshness } from "../context/trust.js";
import type { DecisionRecord } from "../decisions/decisions.js";
import { computeDecisionDrift } from "../decisions/drift.js";

/** More than a few constraints per fire is noise, not context. */
const MAX_INJECTED_DECISIONS = 3;
/** Walk-up bound when locating the Mason root from an edited file. */
const MAX_WALK_UP = 30;

const SUPPORTED_TOOLS = new Set(["Read", "Edit", "Write"]);

export interface HookStdin {
  session_id?: string;
  agent_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
}

export interface HookEnv {
  /** Override for tests; defaults to os.tmpdir(). */
  stateDir?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the nearest ancestor holding a .mason/decisions store. Stops at the
 * first .git boundary — a repo without Mason must stay silent, not borrow a
 * parent directory's decisions.
 */
async function findMasonRoot(startDir: string): Promise<string | null> {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (await exists(path.join(dir, ".mason", "decisions"))) return dir;
    if (await exists(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function anchorsCover(record: DecisionRecord, relPath: string): boolean {
  return record.files.some(anchor => anchorMatches(anchor, relPath));
}

function exactAnchor(record: DecisionRecord, relPath: string): boolean {
  return record.files.some((a) => a.replace(/\/+$/, "") === relPath);
}

function stateKey(input: HookStdin): string {
  const raw = `${input.session_id ?? "nosession"}${input.agent_id ? `-${input.agent_id}` : ""}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120) || "nosession";
}

async function loadInjected(stateFile: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, "utf-8"));
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function formatContext(
  relPath: string,
  records: DecisionRecord[],
  freshness: Record<string, Freshness>
): string {
  const lines: string[] = [];
  lines.push(
    `Mason: recorded knowledge anchored to ${relPath}. Accepted records are constraints subject to freshness; proposals are suggestions and legacy unreviewed records need confirmation. Retired or superseded records are no longer active. Do not modify decision records in .mason/decisions/.`
  );
  for (const record of records) {
    const provenance = decisionProvenance(record, freshness[record.id] ?? "unknown");
    const label = record.status === "active" ? provenance.approval : record.status;
    const stale = freshness[record.id] === "current" ? "" : freshness[record.id] === "changed"
      ? " [recorded against changed files – verify against current code before relying on it]"
      : " [freshness unknown – verify against current code before relying on it]";
    lines.push(
      `- [${label}] [${record.category}] ${record.title}: ${record.body} (anchors: ${record.files.join(", ")}; owner: ${provenance.owner ?? "unknown"}; sources: ${provenance.sources.slice(0, 2).map(s => s.reference).join(", ") || "unrecorded"})${stale}`
    );
  }
  return lines.join("\n");
}

/**
 * The push half of Mason's memory: when an agent touches a file that a
 * decision record anchors, the record is injected into the session via the
 * PostToolUse hook contract — deterministically, without relying on the
 * model deciding to ask. Returns the hook's stdout JSON, or null for
 * "stay silent" (no store, no match, already injected, malformed input —
 * a hook must never disrupt the session).
 */
export async function runHook(
  stdinText: string,
  env: HookEnv = {}
): Promise<string | null> {
  let input: HookStdin;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return null;
  }

  if (!input || typeof input !== "object") return null;
  if (input.tool_name && !SUPPORTED_TOOLS.has(input.tool_name)) return null;
  const filePath = input.tool_input?.file_path;
  if (!filePath || typeof filePath !== "string") return null;

  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(input.cwd ?? process.cwd(), filePath);
  const root = await findMasonRoot(path.dirname(absPath));
  if (!root) return null;
  const relPath = path.relative(root, absPath).split(path.sep).join("/");
  if (relPath.startsWith("..")) return null;

  const { records } = await loadDecisionStore(root);
  const matched = records.filter(r => anchorsCover(r, relPath));
  if (matched.length === 0) return null;

  const stateDir = env.stateDir ?? os.tmpdir();
  const stateFile = path.join(stateDir, `mason-hook-${createHash("sha256").update(root).digest("hex").slice(0, 12)}-${stateKey(input)}.json`);
  const injected = await loadInjected(stateFile);
  const recordKey = (record: DecisionRecord) => `${record.id}:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
  // Re-inject revised/accepted records and withdraw previously injected records
  // that were retired during this session. Untouched archived records stay dark.
  const fresh = matched.filter(r => !injected.has(recordKey(r)) &&
    (r.status === "active" || [...injected].some(key => key === r.id || key.startsWith(`${r.id}:`))));
  if (fresh.length === 0) return null;

  // Exact-file anchors outrank directory-prefix ones; newest knowledge wins ties.
  fresh.sort((a, b) => {
    const withdrawn = Number(b.status !== "active") - Number(a.status !== "active");
    if (withdrawn) return withdrawn;
    const exactDiff =
      Number(exactAnchor(b, relPath)) - Number(exactAnchor(a, relPath));
    if (exactDiff !== 0) return exactDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const selected = fresh.slice(0, MAX_INJECTED_DECISIONS);

  const drift = await computeDecisionDrift(root, selected);
  const freshness = drift.freshness ?? {};

  for (const record of selected) injected.add(recordKey(record));
  try {
    await fs.writeFile(stateFile, JSON.stringify([...injected]), "utf-8");
  } catch {
    // Dedupe state is a convenience; losing it must not block injection.
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: formatContext(relPath, selected, freshness),
    },
  });
}
