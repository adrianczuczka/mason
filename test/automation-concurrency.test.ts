import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { automate, automationStatus } from "../src/automation/runtime.js";
import { runAutomationHook } from "../src/automation/adapters.js";
import { executionStatus, recordExecution } from "../src/automation/execution.js";
import { withLock } from "../src/automation/store.js";
import * as evidence from "../src/automation/evidence.js";
import { CHECKS } from "../src/audit/checks/index.js";
import { initGitRepo, commitAll } from "./helpers.js";

let root: string;
const sessionId = "parallel-tools";
const input = (name: string, id: string, tool = "mcp__jira__jira_search") => ({
  cwd: root, session_id: sessionId, hook_event_name: name, tool_name: tool, tool_use_id: id,
});
const hook = (name: string, id: string, tool?: string) => runAutomationHook("claude", JSON.stringify(input(name, id, tool)));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
async function state() {
  const ws = await evidence.workspace(root);
  return JSON.parse(await fs.readFile(path.join(root, ws.directory, "state.json"), "utf8"));
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-concurrency-"));
  await initGitRepo(root);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/main.js"), "export const main = true;");
  await fs.writeFile(path.join(root, "CLAUDE.md"), "The src directory. Entry: `src/main.js`. Run `npm run test`.\n");
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(root, ".gitignore"), ".mason/reports/\n");
  await commitAll(root, "initial");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("shares a slow check across parallel MCP hooks while read observations remain independent", async () => {
  await automate(root, { event: "session_start", host: "claude", sessionId });
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"node --test","build":"tsc"}}');
  const entered = deferred(), release = deferred();
  const original = CHECKS["dead-command"];
  const check = vi.spyOn(CHECKS, "dead-command").mockImplementation(async ctx => {
    entered.resolve(); await release.promise; return original(ctx);
  });
  const ids = Array.from({ length: 8 }, (_, i) => `jira-${i}`);
  const calls = Promise.all(ids.map(id => hook("PreToolUse", id)));
  try {
    await entered.promise;
    // This must finish while the expensive check is still held at the barrier.
    await expect(hook("PreToolUse", "read", "Read")).resolves.toBeNull();
    await expect(hook("PostToolUse", "read", "Read")).resolves.toBeNull();
    expect((await state()).fingerprint).not.toBe((await evidence.readInputs(root)).fingerprint);
    // Exceed the old five-second state-lock timeout before releasing the check.
    await new Promise(resolve => setTimeout(resolve, 5100));
  } finally { release.resolve(); }
  expect((await calls).some(r => JSON.stringify(r).includes("unavailable"))).toBe(false);
  expect(check).toHaveBeenCalledTimes(1);
  const before = await state();
  const session = before.sessions[evidence.hash(["claude", sessionId])];
  expect(Object.keys(session.pending).sort()).toEqual(ids);
  expect(session.events.before_tool.count).toBe(9);
  await Promise.all(ids.map(id => hook("PostToolUse", id)));
  const after = await state();
  expect(after.baselines).toEqual(before.baselines);
  expect(after.sessions[evidence.hash(["claude", sessionId])]).toMatchObject({ pending: {}, coverageGaps: [], events: { after_tool: { count: 9 } } });
  const receipts = await executionStatus(root, (await evidence.workspace(root)).directory);
  expect(receipts.attempts).toHaveLength(17);
  expect(receipts.attempts.every(a => a.status === "completed")).toBe(true);
}, 25000);

it("preserves separate process receipts and pre/post pairs during a hook burst", async () => {
  const invoke = (name: string, id: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/mason-auto.js"), "hook", "--host", "claude"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 && !stderr ? resolve(stdout) : reject(new Error(`${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(input(name, id)));
  });
  const ids = Array.from({ length: 6 }, (_, i) => `process-${i}`);
  const before = await Promise.all(ids.map(id => invoke("PreToolUse", id)));
  expect(before.join("\n")).not.toContain("unavailable");
  expect(Object.keys((await state()).sessions[evidence.hash(["claude", sessionId])].pending).sort()).toEqual(ids);
  const after = await Promise.all(ids.map(id => invoke("PostToolUse", id)));
  expect(after.join("\n")).not.toContain("unavailable");
  const saved = await state();
  expect(saved.baselines).toHaveLength(1);
  expect(saved.sessions[evidence.hash(["claude", sessionId])]).toMatchObject({ pending: {}, coverageGaps: [], events: { before_tool: { count: 6 }, after_tool: { count: 6 } } });
  const execution = await executionStatus(root, (await evidence.workspace(root)).directory);
  expect(execution.attempts).toHaveLength(12);
  expect(new Set(execution.attempts.map(a => a.pid)).size).toBe(12);
  expect(execution.attempts.every(a => a.status === "completed")).toBe(true);
}, 25000);

it("records failures independently of the state lock and warns once until recovery", async () => {
  const ws = await evidence.workspace(root);
  const busy = new Error("Automation is busy or its lock needs inspection: controlled test lock");
  await withLock(root, ws.directory, async () => {
    await expect(recordExecution(root, ws.directory, "before_tool", async () => { throw busy; }))
      .rejects.toMatchObject({ failure: { code: "busy", receiptRecorded: true } });
  });
  const original = evidence.readInputs;
  const inputs = vi.spyOn(evidence, "readInputs").mockRejectedValue(busy);
  const failures = await Promise.all([0, 1, 2].map(i => hook("PreToolUse", `failure-${i}`)));
  expect(failures.filter(Boolean)).toHaveLength(1);
  expect(JSON.stringify(failures)).toContain("unavailable [busy]");
  const failed = await automationStatus(root);
  expect(failed.status).toBe("unavailable");
  expect(Object.values(failed.notifications.sessions)).toEqual([expect.objectContaining({ count: 3, code: "busy" })]);
  inputs.mockImplementation(original);
  await automate(root, { event: "session_start", host: "claude", sessionId });
  inputs.mockRejectedValue(busy);
  expect(await hook("PreToolUse", "failure-after-recovery")).not.toBeNull();
}, 15000);

it("does not let an overlapping success hide another invocation's failure", async () => {
  const ws = await evidence.workspace(root), entered = deferred(), release = deferred();
  const success = recordExecution(root, ws.directory, "before_tool", async () => {
    entered.resolve(); await release.promise; return { report: { status: "verified", reportPath: "test.json" } };
  });
  try {
    await entered.promise;
    await expect(recordExecution(root, ws.directory, "before_tool", async () => { throw new Error("failed check"); })).rejects.toThrow("failed check");
    expect((await executionStatus(root, ws.directory)).status).toBe("running");
  } finally { release.resolve(); }
  await success;
  expect((await executionStatus(root, ws.directory)).status).toBe("failed");
  await recordExecution(root, ws.directory, "task_end", async () => ({ report: { status: "verified", reportPath: "test.json" } }));
  expect((await executionStatus(root, ws.directory)).status).toBe("completed");
});

it("checks changed inputs independently and prevents an older analysis from publishing over them", async () => {
  await automate(root, { event: "session_start", host: "claude", sessionId });
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"one"}}');
  const entered = deferred(), release = deferred();
  const original = CHECKS["dead-command"];
  let first = true;
  vi.spyOn(CHECKS, "dead-command").mockImplementation(async ctx => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return original(ctx);
  });
  const older = automate(root, { event: "before_tool", host: "claude", sessionId, toolId: "old", mutating: true }).then(() => null, error => error);
  let latest: string;
  try {
    await entered.promise;
    await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"two"}}');
    const newer = await automate(root, { event: "before_tool", host: "claude", sessionId, toolId: "new", mutating: true });
    expect(newer.report.status).toBe("verified");
    latest = newer.report.reportPath;
  } finally { release.resolve(); }
  expect(await older).toMatchObject({ failure: { code: "inputs-changed", receiptRecorded: true } });
  const saved = await state();
  expect(saved.latest).toBe(latest!);
  expect(Object.keys(saved.sessions[evidence.hash(["claude", sessionId])].pending)).toEqual(["new"]);
  expect((await automationStatus(root)).verificationStatus).toBe("unavailable");
}, 15000);
