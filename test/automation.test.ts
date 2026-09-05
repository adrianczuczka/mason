import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { automate, automationStatus } from "../src/automation/runtime.js";
import { runAutomationHook } from "../src/automation/adapters.js";
import { installAutomation, installedAutomation } from "../src/automation/install.js";
import { workspace } from "../src/automation/evidence.js";
import { runAutomationCli } from "../src/automation/cli.js";
import { masonAutomation } from "../src/mcp/tools.js";
import { CHECKS } from "../src/audit/checks/index.js";
import { commitAll, git, initGitRepo } from "./helpers.js";

let root: string;
async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
async function seed() {
  await write("old-module/index.js", "export const greeting = 'hello';\n");
  await write("CLAUDE.md", "The `old-module/index.js` module provides a greeting.\n");
  await write("AGENTS.md", "The old-module directory contains the greeting.\n");
  await write("package.json", '{"scripts":{"test":"node --test"}}');
  await write(".gitignore", ".mason/reports/\n");
  await commitAll(root, "initial");
}
const hook = (host: "claude" | "codex", name: string, extra = {}) => runAutomationHook(host, JSON.stringify({
  cwd: root, session_id: host + "-session", hook_event_name: name, ...extra,
}));
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-automation-")); await initGitRepo(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

// Each lifecycle case runs many real Git processes; allow for parallel CI load.
describe("portable automation", { timeout: 20000 }, () => {
  it.each(["claude", "codex"] as const)("captures a %s rename before documentation edits and verifies through the final commit", async host => {
    await seed();
    await hook(host, "SessionStart");
    const tool = { tool_name: "Bash", tool_use_id: "rename", tool_input: { command: "mv old-module greeting-module" } };
    await hook(host, "PreToolUse", tool);
    await fs.rename(path.join(root, "old-module"), path.join(root, "greeting-module"));
    const output = await hook(host, "PostToolUse", tool);
    expect(JSON.stringify(output)).toContain("old-module/index.js");
    const before = await automationStatus(root);
    expect(before.baselinePaths).toHaveLength(2);
    const saved = await Promise.all(before.baselinePaths.map(p => fs.readFile(path.join(root, p), "utf8")));
    const edit = { tool_name: host === "codex" ? "apply_patch" : "Edit", tool_use_id: "docs" };
    await hook(host, "PreToolUse", edit);
    await write("CLAUDE.md", "The `greeting-module/index.js` module provides a greeting.\n");
    await write("AGENTS.md", "The greeting-module directory contains the greeting.\n");
    await hook(host, "PostToolUse", edit);
    // Dirty docs explicitly retain incomplete dependency checks until committed.
    const dirty = await automate(root, { event: "task_end" });
    expect(dirty.report.status).toBe("incomplete");
    expect(dirty.report.counts.unresolved).toBe(0);
    await commitAll(root, "rename module and update documentation");
    const done = await automate(root, { event: "task_end" });
    expect(done.report.status).toBe("verified");
    expect(done.report.counts.resolved).toBeGreaterThan(0);
    expect(await Promise.all(before.baselinePaths.map(p => fs.readFile(path.join(root, p), "utf8")))).toEqual(saved);
  });

  it("resumes a Claude repair in Codex and retains suppressed dependency evidence", async () => {
    await seed();
    await write("package.json", '{"scripts":{"test":"node --test","build":"tsc"}}');
    await commitAll(root, "manifest changes");
    await hook("claude", "SessionStart");
    const original = (await automationStatus(root)).baselinePaths;
    await write("CLAUDE.md", "The `old-module/index.js` module provides a greeting. Updated instructions.\n");
    const resumed = await hook("codex", "SessionStart");
    expect(JSON.stringify(resumed)).toContain("unverified");
    expect((await automationStatus(root)).baselinePaths).toEqual(original);
    await commitAll(root, "update instructions");
    const checked = await automate(root, { event: "task_end" });
    expect(checked.report.status).toBe("incomplete");
    expect(checked.report.findings.some(f => f.original.type === "deps-changed" && f.status === "review-required")).toBe(true);
  });

  it("reuses unchanged checks and invalidates manifest contents even with the same Git status", async () => {
    await seed();
    await automate(root, { event: "session_start" });
    const cached = await automate(root, { event: "before_tool" });
    expect(cached.report.checks.ran).toEqual([]);
    expect(cached.report.checks.reused).toHaveLength(6);
    await write("package.json", '{"scripts":{"test":"node --test","build":"tsc"}}');
    const changed = await automate(root, { event: "after_tool" });
    expect(changed.report.checks.ran).toContain("dead-command");
    expect(changed.report.checks.reused).toContain("deleted-reference");
    await write("package.json", '{"scripts":{"test":"node --test","build":"other"}}');
    expect((await automate(root, { event: "after_tool" })).report.checks.ran).toContain("dead-command");
  });

  it("keeps new source paths and same-length doc edits out of cached clean results", async () => {
    await seed();
    await automate(root, { event: "session_start" });
    await write("new-module/file.js", "export const added = true;");
    expect((await automate(root, { event: "after_tool" })).report.counts.unresolved).toBeGreaterThan(0);
    await write("CLAUDE.md", "The `old-module/wrong.js` module provides a greeting.\n");
    expect((await automate(root, { event: "after_tool" })).report.findings.some(f => f.original.type === "deleted-reference")).toBe(true);
  });

  it("isolates branches and worktrees while returning to the original active repair", async () => {
    await seed();
    const first = await automate(root, { event: "session_start" });
    await git(["switch", "-c", "other"], root);
    const other = await automate(root, { event: "session_start" });
    expect(other.report.baselinePaths).not.toEqual(first.report.baselinePaths);
    await git(["switch", "main"], root);
    expect((await automationStatus(root)).baselinePaths).toEqual(first.report.baselinePaths);
    const worktree = root + "-linked";
    try {
      await git(["worktree", "add", "-b", "linked", worktree], root);
      expect((await automationStatus(worktree)).status).toBe("not-observed");
    } finally { await git(["worktree", "remove", "--force", worktree], root); }
  });

  it.each(["claude", "codex"] as const)("continues %s once for new issues without looping or treating advisories as approval", async host => {
    await seed();
    await hook(host, "SessionStart");
    const tool = { tool_name: "Bash", tool_use_id: "rename" };
    await hook(host, "PreToolUse", tool);
    await fs.rename(path.join(root, "old-module"), path.join(root, "greeting-module"));
    await hook(host, "PostToolUse", tool);
    expect(await hook(host, "Stop")).toMatchObject({ decision: "block" });
    expect(await hook(host, "Stop", { stop_hook_active: true })).toBeNull();
    expect(await hook(host, "Stop")).toBeNull();
  });

  it("reports missing pre-edit observations and unavailable history explicitly", async () => {
    await seed();
    await hook("codex", "PostToolUse", { tool_name: "apply_patch", tool_use_id: "late" });
    const ws = await workspace(root);
    const state = JSON.parse(await fs.readFile(path.join(root, ws.directory, "state.json"), "utf8"));
    const report = JSON.parse(await fs.readFile(path.join(root, state.latest), "utf8"));
    expect(report.capture).toBe("unknown");
    expect(report.status).toBe("incomplete");
    await fs.rm(path.join(root, ".git"), { recursive: true });
    expect(JSON.stringify(await hook("codex", "Stop"))).toContain("unavailable");
  });

  it("does not overwrite corrupt active state or modified original baselines", async () => {
    await seed();
    const first = await automate(root, { event: "session_start" });
    const file = path.join(root, first.report.baselinePaths[0]);
    const baseline = JSON.parse(await fs.readFile(file, "utf8"));
    baseline.createdAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(file, JSON.stringify(baseline));
    await expect(automate(root, { event: "task_end" })).rejects.toThrow("modified");
    const stateFile = path.join(root, (await workspace(root)).directory, "state.json");
    await fs.writeFile(stateFile, "{broken");
    await expect(automate(root, { event: "task_end" })).rejects.toThrow();
    expect(await fs.readFile(stateFile, "utf8")).toBe("{broken");
  });

  it("serializes concurrent captures and rejects a manifest racing verification", async () => {
    await seed();
    const calls = await Promise.all([automate(root, { event: "session_start" }), automate(root, { event: "session_start" })]);
    expect(calls[0].report.baselinePaths).toEqual(calls[1].report.baselinePaths);
    await write("package.json", '{"scripts":{"build":"tsc"}}');
    const original = CHECKS["dead-command"];
    vi.spyOn(CHECKS, "dead-command").mockImplementation(async ctx => {
      const result = await original(ctx);
      await write("package.json", '{"scripts":{"build":"changed"}}');
      return result;
    });
    await expect(automate(root, { event: "task_end" })).rejects.toThrow("changed during automation");
  });

  it("merges both host configs idempotently and reports installation separately from execution", async () => {
    await seed();
    const existing = { permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [
      { type: "command", command: "existing-check" },
      { type: "prompt", prompt: "Check the completion criteria." },
      { type: "agent", prompt: "Review the task evidence." },
    ] }] } };
    await write(".claude/settings.json", JSON.stringify(existing));
    await installAutomation(root, "claude", "node /installed/mason-auto.js");
    const first = await fs.readFile(path.join(root, ".claude/settings.json"), "utf8");
    await installAutomation(root, "claude", "node /installed/mason-auto.js");
    expect(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe(first);
    expect(JSON.parse(first).permissions).toEqual(existing.permissions);
    expect(JSON.parse(first).hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    await installAutomation(root, "claude", "node /updated/mason-auto.js");
    const updated = JSON.parse(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8"));
    expect(updated.hooks.Stop).toHaveLength(2);
    expect(updated.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    expect(updated.hooks.Stop[1].hooks[0].command).toBe("node /updated/mason-auto.js hook --host claude");
    await installAutomation(root, "codex");
    expect(await installedAutomation(root)).toMatchObject({ claude: { status: "configured" }, codex: { status: "configured" } });
    expect((await automationStatus(root)).status).toBe("not-observed");
    await hook("claude", "SessionStart");
    expect((await automationStatus(root)).hosts).toMatchObject({ claude: { observedEvents: ["session_start"] } });
    await write(".codex/hooks.json", "{malformed");
    await expect(installAutomation(root, "codex")).rejects.toThrow();
    expect(await fs.readFile(path.join(root, ".codex/hooks.json"), "utf8")).toBe("{malformed");
  });

  it("exposes read-only status and the same repair through CLI and MCP", async () => {
    await seed();
    expect(JSON.parse(await masonAutomation(root, "status")).status).toBe("not-observed");
    await expect(fs.access(path.join(root, ".mason"))).rejects.toThrow();
    const output: string[] = [];
    expect(await runAutomationCli(["check", "--dir", root, "--json"], "", { out: s => output.push(s), err: s => output.push(s) })).toBe(0);
    expect(JSON.parse(output[0]).status).toBe("verified");
    expect(JSON.parse(await masonAutomation(root, "check")).baselinePaths).toEqual(JSON.parse(output[0]).baselinePaths);
  });

  it("records unavailable docs once and begins capturing when instruction files appear", async () => {
    await write("source.js", "export const source = true;");
    await commitAll(root, "no docs");
    expect(JSON.stringify(await hook("codex", "SessionStart"))).toContain("unavailable");
    expect(await hook("codex", "PreToolUse", { tool_name: "Bash", tool_use_id: "read" })).toBeNull();
    expect((await automationStatus(root)).verificationStatus).toBe("unavailable");
    await write("AGENTS.md", "The `source.js` entry point.\n");
    await commitAll(root, "instructions");
    expect((await automate(root, { event: "task_end" })).report.baselinePaths).toHaveLength(1);
  });

  it("invalidates file/directory type changes and refuses symlink-based cached evidence", async () => {
    await seed();
    await fs.mkdir(path.join(root, "additional/file.js"), { recursive: true });
    await automate(root, { event: "session_start" });
    await fs.rmdir(path.join(root, "additional/file.js"));
    await write("additional/file.js", "export const value = true;");
    expect((await automate(root, { event: "after_tool" })).report.findings.some(f => f.original.type === "new-module")).toBe(true);
    await fs.symlink(path.join(root, "old-module"), path.join(root, "alias"));
    await expect(automate(root, { event: "task_end" })).rejects.toThrow("symbolic link");
  });

  it("recovers a killed writer without overwriting live or malformed locks", async () => {
    await seed();
    const ws = await workspace(root);
    await fs.mkdir(path.join(root, ws.directory), { recursive: true });
    // A process is actually spawned and reaped; no assumption about an unused PID.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid;
    await new Promise(resolve => child.once("close", resolve));
    await write(ws.directory + "/lock", JSON.stringify({ pid, host: os.hostname() }));
    expect((await automate(root, { event: "session_start" })).report.status).toBe("verified");
  });

  it("recomputes a corrupt cache and keeps hook failures visible without a nonzero hook exit", async () => {
    await seed();
    await automate(root, { event: "session_start" });
    await write((await workspace(root)).directory + "/cache.json", "{broken");
    const refreshed = await automate(root, { event: "task_end" });
    expect(refreshed.report.checks.ran).toHaveLength(6);
    expect(refreshed.report.diagnostics.join(" ")).toContain("cache");
    const output: string[] = [];
    expect(await runAutomationCli(["hook", "--host", "unsupported"], "{}", { out: s => output.push(s), err: s => output.push(s) })).toBe(0);
    expect(JSON.parse(output[0]).systemMessage).toContain("unavailable");
  });

  it("retains detached-HEAD repair evidence through commits and rejects an unrelated checkout", async () => {
    await seed();
    const initial = await git(["rev-parse", "HEAD"], root);
    await git(["switch", "--detach"], root);
    const started = await automate(root, { event: "session_start" });
    await fs.rename(path.join(root, "old-module"), path.join(root, "greeting-module"));
    const discovered = await automate(root, { event: "after_tool" });
    await write("CLAUDE.md", "The `greeting-module/index.js` module provides a greeting.\n");
    await write("AGENTS.md", "The greeting-module directory contains the greeting.\n");
    await commitAll(root, "rename in detached checkout");
    const verified = await automate(root, { event: "task_end" });
    expect(verified.report.status).toBe("verified");
    expect(verified.report.baselinePaths).toEqual(discovered.report.baselinePaths);
    expect(verified.report.baselinePaths).toContain(started.report.baselinePaths[0]);
    await git(["switch", "--detach", initial], root);
    await expect(automate(root, { event: "session_start" })).rejects.toThrow("different history");
  });
});
