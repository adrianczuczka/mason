import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadDecisions } from "../decisions/decisions.js";
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
  return record.files.some((anchor) => {
    const a = anchor.replace(/\/+$/, "");
    return a === relPath || relPath.startsWith(`${a}/`);
  });
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
  staleIds: Set<string>
): string {
  const lines: string[] = [];
  lines.push(
    `Mason: recorded team knowledge anchored to ${relPath} — treat as constraints. Do not modify decision records in .mason/decisions/.`
  );
  for (const record of records) {
    const stale = staleIds.has(record.id)
      ? " [recorded against an older commit – verify against current code before relying on it]"
      : "";
    lines.push(
      `- [${record.category}] ${record.title}: ${record.body} (anchors: ${record.files.join(", ")})${stale}`
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

  const records = await loadDecisions(root);
  const matched = records.filter(
    (r) => r.status === "active" && anchorsCover(r, relPath)
  );
  if (matched.length === 0) return null;

  const stateDir = env.stateDir ?? os.tmpdir();
  const stateFile = path.join(stateDir, `mason-hook-${stateKey(input)}.json`);
  const injected = await loadInjected(stateFile);
  const fresh = matched.filter((r) => !injected.has(r.id));
  if (fresh.length === 0) return null;

  // Exact-file anchors outrank directory-prefix ones; newest knowledge wins ties.
  fresh.sort((a, b) => {
    const exactDiff =
      Number(exactAnchor(b, relPath)) - Number(exactAnchor(a, relPath));
    if (exactDiff !== 0) return exactDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const selected = fresh.slice(0, MAX_INJECTED_DECISIONS);

  const drift = await computeDecisionDrift(root, selected);
  const staleIds = new Set(Object.keys(drift.staleDecisions));

  for (const record of selected) injected.add(record.id);
  try {
    await fs.writeFile(stateFile, JSON.stringify([...injected]), "utf-8");
  } catch {
    // Dedupe state is a convenience; losing it must not block injection.
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: formatContext(relPath, selected, staleIds),
    },
  });
}
