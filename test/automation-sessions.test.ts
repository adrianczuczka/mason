import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initGitRepo, commitAll } from "./helpers.js";
import { runAutomationHook, hookConfig } from "../src/automation/adapters.js";
import { automationStatus } from "../src/automation/runtime.js";
import { workspace } from "../src/automation/evidence.js";
import { parseState, pruneSessions, serializeState, type State } from "../src/automation/store.js";
import { boundPending, PENDING_LIMIT } from "../src/automation/pending-tools.js";
import { upsertDecision } from "../src/decisions/decisions.js";
import { inspectIntegration } from "../src/setup/config.js";
import { hookCommand } from "../src/setup/launcher.js";

let root: string;
const hook = (name: string, session: string, extra = {}) =>
  runAutomationHook(
    "claude",
    JSON.stringify({ cwd: root, session_id: session, hook_event_name: name, ...extra }),
  );
const bash = (id: string) => ({ tool_name: "Bash", tool_use_id: id });
async function statePath() {
  const ws = await workspace(root);
  return path.join(root, ws.directory, "state.json");
}
async function readState(): Promise<State> {
  return parseState(JSON.parse(await fs.readFile(await statePath(), "utf8")));
}
const session = (lastUsed: string, pending = 0) => ({
  host: "claude" as const,
  lastUsed,
  notifiedDiagnostics: [],
  pending: Object.fromEntries(Array.from({ length: pending }, (_, i) => [`tool-${i}`, "f"])),
  coverageGaps: [],
  events: {},
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-sessions-"));
  await initGitRepo(root);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, ".gitignore"), ".mason/reports/\n");
  await fs.writeFile(path.join(root, "src/client.ts"), "export const retries = 1;\n");
  await commitAll(root, "initial");
  await upsertDecision(root, {
    title: "Bound retries",
    body: "Retries must remain bounded.",
    category: "decision",
    files: ["src"],
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("automation session store", { timeout: 60000 }, () => {
  it("pairs failed tool calls and clears calls that never complete when the turn ends", async () => {
    await hook("PreToolUse", "s1", bash("failed"));
    await hook("PostToolUseFailure", "s1", { ...bash("failed"), error: "exit 1" });
    let state = await readState();
    const [current] = Object.values(state.sessions);
    expect(current.pending).toEqual({});
    expect(current.coverageGaps).toEqual([]);

    // A denied or interrupted call reports no post-tool event at all.
    await hook("PreToolUse", "s1", bash("denied"));
    expect((await automationStatus(root)).unfinishedToolCalls).toBe(1);
    await hook("Stop", "s1");
    state = await readState();
    expect(Object.values(state.sessions)[0]).toMatchObject({
      pending: {},
      stopReview: { pending: {} },
    });
    expect(await automationStatus(root)).toMatchObject({
      unfinishedToolCalls: 0,
      oldestUnfinishedSessionUsedAt: null,
    });
  });

  it("never locks out a new session because older sessions left calls unfinished", async () => {
    await hook("SessionStart", "seed");
    const state = await readState();
    const old = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 128; i++) state.sessions[`leaked-${i}`] = session(old, 3);
    await fs.writeFile(await statePath(), JSON.stringify(state));

    expect((await hook("SessionStart", "fresh"))?.systemMessage).toBeUndefined();
    const after = await readState();
    expect(Object.keys(after.sessions)).toHaveLength(32);
    expect(Object.values(after.sessions).some((s) => s.lastUsed > old)).toBe(true);
  });

  it("recovers an existing state file over the 10 MiB store limit", async () => {
    await hook("SessionStart", "seed");
    const state = await readState();
    const capture = { anchors: ["src"], files: {}, complete: true };
    const old = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 12; i++)
      state.sessions[`big-${i}`] = {
        ...session(old),
        stopReview: {
          pending: {
            tool: { head: "h", evidence: { d: { digest: "x".repeat(1024 * 1024), capture } } },
          },
          edited: {},
          delivered: {},
        },
      };
    await fs.writeFile(await statePath(), JSON.stringify(state, null, 2));
    expect((await fs.stat(await statePath())).size).toBeGreaterThan(10 * 1024 * 1024);

    expect((await hook("SessionStart", "fresh"))?.systemMessage).toBeUndefined();
    expect((await fs.stat(await statePath())).size).toBeLessThan(10 * 1024 * 1024);
  });

  it("expires calls in idle sessions and evicts the least recently used, never the active one", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    const state = { sessions: {} } as State;
    state.sessions.idle = session("2026-10-19T12:00:00Z", 2);
    state.sessions.active = session("2026-10-01T00:00:00Z", 1);
    for (let i = 0; i < 4; i++)
      state.sessions[`recent-${i}`] = session(`2026-10-21T11:0${i}:00Z`, 1);
    pruneSessions(state, now, "active", 3);
    expect(Object.keys(state.sessions).sort()).toEqual(["active", "recent-2", "recent-3"]);
    expect(state.sessions.active.pending).toEqual({});
    expect(state.sessions["recent-3"].pending).toEqual({ "tool-0": "f" });

    const pending: Record<string, string> = {};
    for (let i = 0; i < PENDING_LIMIT + 5; i++) {
      boundPending(pending);
      pending[`call-${i}`] = "f";
    }
    expect(Object.keys(pending)).toHaveLength(PENDING_LIMIT);
    expect(Object.keys(pending)[0]).toBe("call-5");
    expect(() => serializeState(state, "active")).not.toThrow();
  });

  it("keeps older Claude hook configuration without the failure hook compatible", async () => {
    const generated = hookConfig("claude", hookCommand("claude")).hooks;
    expect(Object.keys(generated)).toContain("PostToolUseFailure");
    expect(Object.keys(hookConfig("codex", hookCommand("codex")).hooks)).not.toContain(
      "PostToolUseFailure",
    );
    const older = Object.fromEntries(
      Object.entries(generated).filter(([event]) => event !== "PostToolUseFailure"),
    );
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".claude/settings.json"),
      JSON.stringify({ hooks: older }, null, 2),
    );
    expect(await inspectIntegration(root, "claude")).toMatchObject({
      hooksCompatible: true,
      hooksCurrent: false,
    });
  });
});
