import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automate, automationStatus } from "../src/automation/runtime.js";
import { readInputs, workspace } from "../src/automation/evidence.js";
import { automationFailure, executionStatus, recordExecution } from "../src/automation/execution.js";
import { runAutomationCli } from "../src/automation/cli.js";
import { runAutomationHook } from "../src/automation/adapters.js";
import { masonAutomation } from "../src/mcp/tools.js";
import { CHECKS } from "../src/audit/checks/index.js";
import { withLock } from "../src/automation/store.js";
import { commitAll, initGitRepo } from "./helpers.js";

let root: string;
async function write(file: string, value: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), value);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-auto-reliability-"));
  await initGitRepo(root);
  await write("src/main.js", "export const main = true;");
  await write("CLAUDE.md", "Code in `src/main.js`. Run `npm run test`.\n");
  await write("package.json", '{"scripts":{"test":"node --test"}}');
  await write(".gitignore", ".mason/reports/\nbuild/\n.gradle/\n");
  await commitAll(root, "initial");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("automation reliability", { timeout: 20000 }, () => {
  it("reuses all checks during ignored build churn, including churn inside verification", async () => {
    await automate(root, { event: "session_start" });
    const before = await readInputs(root);
    await write("build/intermediates/generated.js", "generated");
    await write(".gradle/state/cache.bin", "cache");
    expect((await readInputs(root)).fingerprint).toBe(before.fingerprint);
    const cached = await automate(root, { event: "before_tool" });
    expect(cached.report.checks.ran).toEqual([]);
    expect(cached.report.checks.reused).toHaveLength(6);
    await write("package.json", '{"scripts":{"test":"changed"}}');
    const original = CHECKS["dead-command"];
    vi.spyOn(CHECKS, "dead-command").mockImplementation(async ctx => {
      const result = await original(ctx);
      await write("build/intermediates/next.bin", "more output");
      return result;
    });
    expect((await automate(root, { event: "task_end" })).report.status).toBe("verified");
  });

  it("observes explicitly documented ignored files and workspace members", async () => {
    await write("AGENTS.md", "The src directory. An unfinished example:\n```\n");
    await write("CLAUDE.md", "The src directory. Generated entry `build/public.js`. There are 1 workspaces.\n");
    await write("package.json", '{"workspaces":["build/packages/*"]}');
    await write("build/packages/one/package.json", "{}");
    await commitAll(root, "document generated workspace");
    const before = await readInputs(root);
    await write("build/public.js", "entry");
    const file = await readInputs(root);
    expect(file.keys["deleted-reference"]).not.toBe(before.keys["deleted-reference"]);
    expect(file.keys["new-module"]).toBe(before.keys["new-module"]);
    await write("build/packages/two/package.json", "{}");
    const member = await readInputs(root);
    expect(member.keys["stale-count"]).not.toBe(file.keys["stale-count"]);
    const checked = await automate(root, { event: "task_end" });
    expect(checked.report.findings.some(f => f.original.type === "stale-count")).toBe(true);
  });

  it("keeps malformed or symlinked decision stores out of clean cached evidence", async () => {
    await automate(root, { event: "session_start" });
    await write(".mason/decisions/broken.json", "{broken");
    const checked = await automate(root, { event: "task_end" });
    expect(checked.report.status).toBe("incomplete");
    expect(checked.report.checks.skipped.some(s => s.check === "decision-anchor-drift")).toBe(true);
    await fs.rm(path.join(root, ".mason/decisions/broken.json"));
    await fs.symlink(path.join(root, "package.json"), path.join(root, ".mason/decisions/alias.json"));
    await expect(automate(root, { event: "task_end" })).rejects.toThrow("Symlink");
  });

  it("records changing inputs as failed and stops presenting an older verification as current", async () => {
    await automate(root, { event: "session_start" });
    await write("package.json", '{"scripts":{"test":"one"}}');
    const original = CHECKS["dead-command"];
    vi.spyOn(CHECKS, "dead-command").mockImplementation(async ctx => {
      const result = await original(ctx);
      await write("package.json", '{"scripts":{"test":"two"}}');
      return result;
    });
    await expect(automate(root, { event: "task_end" })).rejects.toMatchObject({
      failure: { code: "inputs-changed", retryable: true, receiptRecorded: true },
    });
    const status = await automationStatus(root);
    expect(status.verificationStatus).toBe("unavailable");
    expect(status.execution.status).toBe("failed");
    vi.restoreAllMocks();
    await automate(root, { event: "task_end" });
    const recovered = await automationStatus(root);
    expect(recovered.verificationStatus).toBe("verified");
    expect(recovered.execution.attempts.some(a => a.status === "failed")).toBe(true);
  });

  it("distinguishes a missing completion from a live process without changing the receipt", async () => {
    await automate(root, { event: "session_start" });
    const ws = await workspace(root);
    const file = path.join(root, ws.directory, "execution.json");
    const log = JSON.parse(await fs.readFile(file, "utf8"));
    const last = log.attempts.at(-1);
    last.status = "running";
    delete last.finishedAt;
    await fs.writeFile(file, JSON.stringify(log));
    await write(ws.directory + "/lock", JSON.stringify({ pid: process.pid, host: os.hostname() }));
    expect((await automationStatus(root)).execution.status).toBe("running");
    await fs.rm(path.join(root, ws.directory, "lock"));
    last.host = "different-machine";
    const bytes = JSON.stringify(log);
    await fs.writeFile(file, bytes);
    const status = await automationStatus(root);
    expect(status.execution.status).toBe("unknown");
    expect(status.verificationStatus).toBe("unavailable");
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
    await automate(root, { event: "task_end" });
    expect((await automationStatus(root)).execution.attempts.some(a => a.status === "unknown")).toBe(true);
  });

  it("reports storage exhaustion even when it also prevents a failure receipt", async () => {
    const ws = await workspace(root);
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    await expect(recordExecution(root, ws.directory, "task_end", async () => { throw full; }))
      .rejects.toMatchObject({ failure: { code: "storage-full", receiptRecorded: true } });
    expect((await executionStatus(root, ws.directory)).status).toBe("failed");
    await expect(recordExecution(root, ws.directory, "task_end", async () => {
      vi.spyOn(fs, "open").mockRejectedValue(full);
      throw full;
    })).rejects.toMatchObject({ failure: { code: "storage-full", receiptRecorded: false } });
    vi.restoreAllMocks();
    expect((await executionStatus(root, ws.directory)).status).toBe("unknown");
    expect(automationFailure(new Error("wrapped", { cause: full })).code).toBe("storage-full");
  });

  it("bounds receipt history and reports the size of the omitted history", async () => {
    const ws = await workspace(root);
    for (let i = 0; i < 35; i++) {
      await recordExecution(root, ws.directory, "before_tool", async () => ({ report: { status: "verified", reportPath: "example.json" } }));
    }
    const status = await executionStatus(root, ws.directory);
    expect(status.attempts).toHaveLength(32);
    expect(status.discardedAttempts).toBe(3);
    expect(status.attempts.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not claim success if publishing the completed receipt fails", async () => {
    const ws = await workspace(root);
    await expect(recordExecution(root, ws.directory, "task_end", async () => {
      vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("quota"), { code: "EDQUOT" }));
      return { report: { status: "verified", reportPath: "example.json" } };
    })).rejects.toMatchObject({ failure: { code: "storage-full", receiptRecorded: false } });
  });

  it("cleans up a lock whose owner metadata could not be written", async () => {
    const ws = await workspace(root);
    const open = fs.open.bind(fs);
    const close = vi.fn(async () => {});
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      close.mockImplementation(() => handle.close());
      return { writeFile: async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); }, close } as any;
    });
    await expect(withLock(root, ws.directory, async () => "done")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(close).toHaveBeenCalledOnce();
    await expect(fs.access(path.join(root, ws.directory, "lock"))).rejects.toThrow();
    expect(await withLock(root, ws.directory, async () => "done")).toBe("done");
  });

  it("classifies invalid persisted schemas as evidence failures, preserving their bytes", async () => {
    await automate(root, { event: "session_start" });
    const ws = await workspace(root);
    await write(ws.directory + "/state.json", '{"version":999}');
    await expect(automate(root, { event: "task_end" })).rejects.toMatchObject({ failure: { code: "invalid-evidence" } });
    expect(await fs.readFile(path.join(root, ws.directory, "state.json"), "utf8")).toBe('{"version":999}');
    await write(ws.directory + "/execution.json", '{"version":999}');
    expect(JSON.parse(await masonAutomation(root, "check")).failure.code).toBe("invalid-evidence");
    expect(await fs.readFile(path.join(root, ws.directory, "execution.json"), "utf8")).toBe('{"version":999}');
  });

  it("returns machine-readable CLI/MCP failure and a visible advisory hook failure", async () => {
    await automate(root, { event: "session_start" });
    const ws = await workspace(root);
    await write(ws.directory + "/state.json", "{broken");
    const output: string[] = [];
    expect(await runAutomationCli(["check", "--dir", root, "--json"], "", { out: s => output.push(s), err: s => output.push(s) })).toBe(2);
    expect(JSON.parse(output[0])).toMatchObject({ status: "unavailable", failure: { code: "invalid-evidence" } });
    expect(JSON.parse(await masonAutomation(root, "check"))).toMatchObject({ failure: { code: "invalid-evidence" } });
    const hook = await runAutomationHook("codex", JSON.stringify({ cwd: root, session_id: "test", hook_event_name: "Stop" }));
    expect(hook?.systemMessage).toContain("[invalid-evidence]");
    const hookOutput: string[] = [];
    expect(await runAutomationCli(["hook", "--host", "codex"], "{broken", { out: s => hookOutput.push(s), err: s => hookOutput.push(s) })).toBe(0);
    expect(JSON.parse(hookOutput[0]).systemMessage).toContain("[invalid-input]");
  });
});
