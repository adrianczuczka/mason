import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { computeAudit } from "../src/audit/audit.js";
import { pathExists } from "../src/audit/scope.js";
import { readAuditInput } from "../src/audit/inputs.js";
import { readInputs, workspace } from "../src/automation/evidence.js";
import { setupProject } from "../src/setup/setup.js";
import { setupStatus } from "../src/setup/status.js";
import { teardownProject } from "../src/setup/teardown.js";
import { loadSetup } from "../src/setup/model.js";
import { readObservation } from "../src/setup/observations.js";
import { managedHookCommand } from "../src/automation/adapters.js";
import * as launcher from "../src/setup/launcher.js";
import { commitAll, git, initGitRepo } from "./helpers.js";

const binary = path.resolve("dist/mason.js");
const version = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version as string;
let temp: string, root: string, outside: string;
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-adoption-workflows-")));
  root = path.join(temp, "project"); outside = path.join(temp, "outside");
  await fs.mkdir(root); await fs.mkdir(outside); await fs.mkdir(path.join(root, "src"));
  await initGitRepo(root);
  await fs.writeFile(path.join(root, "src/main.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "AGENTS.md"), "Entry point: `src/main.ts`.\n");
  await commitAll(root, "initial");
  vi.stubGlobal("PKG_VERSION", "test");
  vi.spyOn(launcher, "installedCommand").mockResolvedValue({ available: true, version: "test", message: null });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await fs.rm(temp, { recursive: true, force: true }); });

const env = () => Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("MASON_SETUP_") && key !== "CLAUDE_PROJECT_DIR")) as Record<string, string>;
function hook(payloadCwd: string, launchCwd: string, host = "claude", extra: Record<string, unknown> = {}, managed = true) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...(managed ? ["--setup-host", host] : []), "auto", "hook", "--host", host],
      { cwd: launchCwd, env: { ...env(), CLAUDE_PROJECT_DIR: root } });
    let output = "", stderr = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(output) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify({ cwd: payloadCwd, session_id: "ordinary-task", hook_event_name: "PreToolUse", tool_name: "Read", ...extra }));
  });
}

describe("adoption workflows", { timeout: 30000 }, () => {
  it("treats paths below a regular file as missing and invalidates cached evidence when they become real", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "Reference: [helper](src/main.ts/helper.ts).\n");
    await commitAll(root, "claim a child of a file");
    expect(await pathExists(root, "src/main.ts/helper.ts")).toBe(false);
    expect(await readAuditInput(root, "src/main.ts/helper.ts")).toBeNull();
    const before = await readInputs(root);
    expect((await computeAudit(root))!.advisories.some(f => f.type === "deleted-reference")).toBe(true);
    await fs.rm(path.join(root, "src/main.ts")); await fs.mkdir(path.join(root, "src/main.ts"));
    await fs.writeFile(path.join(root, "src/main.ts/helper.ts"), "export {};\n");
    expect((await readInputs(root)).keys["deleted-reference"]).not.toBe(before.keys["deleted-reference"]);
    expect((await computeAudit(root))!.advisories.filter(f => f.type === "deleted-reference")).toEqual([]);
    await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(pathExists(root, "linked/missing.ts")).rejects.toThrow("symbolic link");
  });

  it("sets up a linked worktree with Git metadata references and preserves an explicit skipped result", async () => {
    await fs.appendFile(path.join(root, "AGENTS.md"), "\nGit administration: `.git/worktrees/`.\n");
    await commitAll(root, "document Git metadata");
    const worktree = path.join(temp, "worktree");
    await git(["worktree", "add", "-b", "linked", worktree], root);
    const result = await setupProject(worktree, { host: "claude" });
    expect(result.status).toBe("configured");
    expect(result.findings.audit.skippedChecks).toEqual(expect.arrayContaining([expect.objectContaining({ check: "deleted-reference", reason: expect.stringContaining("Git metadata") })]));
    expect(result.findings.audit.issues).toEqual([]);
    expect(result.findings.audit.advisories.filter(f => f.type === "deleted-reference")).toEqual([]);
    await expect(readInputs(worktree)).resolves.toHaveProperty("fingerprint");
    await commitAll(worktree, "configure worktree");
    expect((await setupProject(worktree, { host: "claude" })).changedFiles).toEqual([]);
    expect(await git(["status", "--porcelain"], worktree)).toBe("");
  });

  it.each(["claude", "codex"] as const)("serves useful %s MCP context in a fresh clone with actionable inactive setup and no automatic writes", async host => {
    await setupProject(root, { host }); await commitAll(root, "configure integration");
    const clone = path.join(temp, "clone"); await git(["clone", root, clone], temp);
    const client = new Client({ name: "fresh-clone", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [binary, "--setup-host", host, "mcp"], cwd: clone, env: env(), stderr: "pipe" }));
      expect(client.getInstructions()).toContain(`mason setup --host ${host}`);
      expect(client.getInstructions()).toContain("automatic hooks are inactive");
      const context = await client.callTool({ name: "get_context", arguments: { dir: clone, task: "explain the entry point", files: ["src/main.ts"] } });
      expect(context.isError).not.toBe(true);
      expect(JSON.stringify(context)).toContain("src/main.ts");
      expect(JSON.stringify(context)).toContain("automatic hooks are inactive");
      const status = await client.callTool({ name: "mason_automation", arguments: { dir: clone, action: "status" } });
      expect(JSON.stringify(status)).toContain("not-configured");
    } finally { await client.close(); }
    expect(await hook(clone, clone, host)).toBe("");
    await expect(fs.access(path.join(clone, ".mason"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(["status", "--porcelain"], clone)).toBe("");
    expect((await teardownProject(clone, { host })).status).toBe("complete");
    if (host === "claude") expect(JSON.parse(await fs.readFile(path.join(clone, ".mcp.json"), "utf8")).mcpServers?.mason).toBeUndefined();
  });

  it("uses payload checkout and an unambiguous project fallback while preserving pre-edit evidence", async () => {
    const setup = await setupProject(root, { host: "claude" });
    const baseline = JSON.parse(await fs.readFile(path.join(root, setup.initialReportPath), "utf8")).baselinePaths[0];
    const original = await fs.readFile(path.join(root, baseline));
    expect(await hook(path.join(root, "src"), outside)).toBe("");
    expect(await hook(outside, outside, "claude", { tool_name: "Bash", tool_use_id: "rename" })).not.toContain("unavailable");
    await fs.rename(path.join(root, "src/main.ts"), path.join(root, "src/renamed.ts"));
    const checked = await hook(outside, outside, "claude", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "rename" });
    expect(checked).toContain("src/main.ts");
    expect(checked).not.toContain("not a git repository");
    expect(await fs.readFile(path.join(root, baseline))).toEqual(original);
    const ws = await workspace(root), revision = (await loadSetup(root))!.hosts.claude!.revision;
    const observation = await readObservation(root, ws.directory, "claude", revision, version);
    expect(Object.values(observation!.sessions)[0].events).toEqual(["before_tool", "after_tool"]);
  });

  it("updates the MCP reminder after explicit setup without inventing activation", async () => {
    const client = new Client({ name: "setup-in-session", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [binary, "--setup-host", "claude", "mcp"], cwd: root, env: env(), stderr: "pipe" }));
      expect(client.getInstructions()).toContain("automatic hooks are inactive");
      await setupProject(root, { host: "claude" });
      const context = await client.callTool({ name: "get_context", arguments: { dir: root, task: "explain main", files: ["src/main.ts"] } });
      expect(context.isError).not.toBe(true);
      expect(JSON.stringify(context)).toContain("setup is now present");
      expect(JSON.stringify(context)).toContain("Restart the assistant");
      expect(JSON.stringify(context)).not.toContain("automatic hooks are inactive");
      expect((await setupStatus(root)).hosts.claude.contextCalls).toBe(0);
    } finally { await client.close(); }
  });

  it("does not let unmanaged hooks adopt an unrelated launch checkout when history is unavailable", async () => {
    await setupProject(root, { host: "claude" });
    const ws = await workspace(root), statePath = path.join(root, ws.directory, "state.json");
    const before = await fs.readFile(statePath);
    expect(await hook(outside, root, "claude", { hook_event_name: "Stop" }, false)).toContain("unavailable");
    expect(await fs.readFile(statePath)).toEqual(before);
    await expect(fs.access(path.join(outside, ".mason"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps lost host-project history unavailable instead of falling back to another Git repository", async () => {
    await setupProject(root, { host: "claude" });
    const unrelated = path.join(temp, "unrelated"); await fs.mkdir(unrelated); await initGitRepo(unrelated);
    await fs.rename(path.join(root, ".git"), path.join(temp, "retained-git"));
    expect(await hook(outside, unrelated)).toContain("no longer a Git repository");
    await expect(fs.access(path.join(unrelated, ".mason"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gates setup on the payload worktree and refuses to guess between checkouts outside Git", async () => {
    await setupProject(root, { host: "claude" }); await commitAll(root, "configure original");
    const worktree = path.join(temp, "worktree"); await git(["worktree", "add", "-b", "linked", worktree], root);
    expect(await hook(worktree, root)).toBe("");
    await expect(fs.access(path.join(worktree, ".mason"))).rejects.toMatchObject({ code: "ENOENT" });
    await setupProject(worktree, { host: "claude" });
    expect(await hook(worktree, root)).toBe("");
    const ws = await workspace(worktree), revision = (await loadSetup(worktree))!.hosts.claude!.revision;
    expect(await readObservation(worktree, ws.directory, "claude", revision, version)).not.toBeNull();
    const mainWs = await workspace(root), mainRevision = (await loadSetup(root))!.hosts.claude!.revision;
    expect(await readObservation(root, mainWs.directory, "claude", mainRevision, version)).toBeNull();
    expect(await hook(outside, root)).toContain("active checkout is unknown");
    expect(await readObservation(root, mainWs.directory, "claude", mainRevision, version)).toBeNull();
    const unrelated = path.join(temp, "unrelated"); await fs.mkdir(unrelated); await initGitRepo(unrelated);
    expect(await hook(unrelated, root)).toBe("");
    await expect(fs.access(path.join(unrelated, ".mason"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["", "# existing\r\n.mason/\r\n"])("shares only the knowledge allowlist and repeats setup without tracked churn (%j)", async ignore => {
    await fs.writeFile(path.join(root, ".gitignore"), ignore);
    await setupProject(root, { host: "claude" });
    for (const name of ["cache/probe", "scratch.json", "local/setup.json", "reports/evidence.json"]) {
      expect(await git(["check-ignore", "--no-index", ".mason/" + name], root)).toBe(".mason/" + name);
    }
    for (const name of ["decisions/proposal.json", "reviews/advisories/review.json", "config.json", "snapshot.json"]) {
      await expect(git(["check-ignore", "--no-index", ".mason/" + name], root)).rejects.toMatchObject({ code: 1 });
    }
    const config = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(config.mcpServers.mason.type).toBe("stdio");
    await commitAll(root, "commit setup");
    expect((await setupProject(root, { host: "claude" })).changedFiles).toEqual([]);
    expect(await git(["status", "--porcelain"], root)).toBe("");
  });

  it("distinguishes compatible older hooks from disabled, narrowed, or wrong-platform hooks without rewriting them", async () => {
    await setupProject(root, { host: "claude" });
    const file = path.join(root, ".claude/settings.json");
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    for (const groups of Object.values(config.hooks) as any[]) for (const group of groups) for (const handler of group.hooks) handler.command = "mason --setup-host claude auto hook --host claude";
    const text = JSON.stringify(config); await fs.writeFile(file, text);
    const compatible = (await setupStatus(root)).hosts.claude;
    expect(compatible.hookConfiguration).toBe("compatible"); expect(compatible.status).toBe("pending");
    expect(compatible.updates).toHaveLength(1); expect(await fs.readFile(file, "utf8")).toBe(text);
    config.disableAllHooks = true; await fs.writeFile(file, JSON.stringify(config));
    expect((await setupStatus(root)).hosts.claude.hookConfiguration).toBe("disabled-or-changed");
    delete config.disableAllHooks; config.hooks.PreToolUse[0].matcher = "Edit"; await fs.writeFile(file, JSON.stringify(config));
    expect((await setupStatus(root)).hosts.claude.hookConfiguration).toBe("disabled-or-changed");
    config.hooks.PreToolUse[0].matcher = ".*";
    config.hooks.Stop[0].hooks[0].command = managedHookCommand("claude", process.platform === "win32" ? "linux" : "win32");
    await fs.writeFile(file, JSON.stringify(config));
    expect((await setupStatus(root)).hosts.claude.hookConfiguration).toBe("disabled-or-changed");
  });
});
