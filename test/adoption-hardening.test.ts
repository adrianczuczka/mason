import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hookConfig, runAutomationHook, knownManagedHookCommands } from "../src/automation/adapters.js";
import { automate, automationStatus } from "../src/automation/runtime.js";
import { workspace } from "../src/automation/evidence.js";
import { planAutomationInstall } from "../src/automation/install.js";
import { setupStatus } from "../src/setup/status.js";
import { setupProject } from "../src/setup/setup.js";
import { loadSetup } from "../src/setup/model.js";
import { readObservation } from "../src/setup/observations.js";
import * as launcher from "../src/setup/launcher.js";
import { commitAll, initGitRepo } from "./helpers.js";

const exec = promisify(execFile);
const binary = path.resolve("dist/mason.js");
const networkGuard = path.resolve("test/support/deny-network.mjs");
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-adoption-hardening-")));
  await initGitRepo(root);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/main.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "AGENTS.md"), "Entry point: `src/main.ts`.\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".mason/\n");
  await commitAll(root, "initial");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });

it.each(["claude", "codex"] as const)("keeps generated %s hooks quiet when Mason is absent", async host => {
  const empty = path.join(root, "empty-bin"); await fs.mkdir(empty);
  const windows = process.platform === "win32";
  const env = { ...process.env, PATH: windows ? [path.join(process.env.SystemRoot!, "System32"), path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0")].join(path.delimiter) : empty };
  const command = hookConfig(host, `mason --setup-host ${host} auto`).hooks.SessionStart[0].hooks[0].command;
  const output = await exec(windows ? "cmd.exe" : "/bin/sh", windows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], { cwd: root, env, windowsVerbatimArguments: windows });
  expect(output.stdout).toBe(""); expect(output.stderr).toBe("");
});

it.each(["claude", "codex"] as const)("keeps installed %s hooks inactive without setup, but reports corrupt setup", async host => {
  const args = [binary, "--setup-host", host, "auto", "hook", "--host", host];
  const quiet = await exec(process.execPath, args, { cwd: root });
  expect(quiet.stdout).toBe(""); expect(quiet.stderr).toBe("");
  expect((await setupStatus(root)).status).toBe("not-configured");
  await expect(fs.stat(path.join(root, ".mason"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(exec(process.execPath, [binary, "--setup-host", host, "mcp"], { cwd: root })).rejects.toMatchObject({ code: 2 });
  await fs.mkdir(path.join(root, ".mason/local"), { recursive: true });
  await fs.writeFile(path.join(root, ".mason/local/setup.json"), "{");
  expect(JSON.parse((await exec(process.execPath, args, { cwd: root })).stdout).systemMessage).toContain("Verification was not established");
});

it("replaces known generated hook variants in a clone while preserving custom hooks", async () => {
  await fs.mkdir(path.join(root, ".claude"));
  const variants = knownManagedHookCommands("claude");
  await fs.writeFile(path.join(root, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [...variants, "echo custom"].map(command => ({ type: "command", command })) }] } }));
  const plan = await planAutomationInstall(root, "claude", "mason --setup-host claude auto");
  expect(plan.config.hooks.Stop.flatMap(group => group.hooks.map(handler => handler.command))).toEqual(["echo custom", plan.newCommand]);
});

it("observes known read tools without advancing audit evidence, then checks shell and unknown tools", async () => {
  const sessionId = "reads";
  await automate(root, { event: "session_start", host: "claude", sessionId });
  const ws = await workspace(root);
  const before = JSON.parse(await fs.readFile(path.join(root, ws.directory, "state.json"), "utf8"));
  const execution = await fs.readFile(path.join(root, ws.directory, "execution.json"), "utf8");
  await fs.rename(path.join(root, "src/main.ts"), path.join(root, "src/renamed.ts"));
  for (const event of ["PreToolUse", "PostToolUse"]) expect(await runAutomationHook("claude", JSON.stringify({ cwd: root, session_id: sessionId, hook_event_name: event, tool_name: "Read", tool_use_id: "read" }))).toBeNull();
  const after = JSON.parse(await fs.readFile(path.join(root, ws.directory, "state.json"), "utf8"));
  expect(after.fingerprint).toBe(before.fingerprint); expect(after.latest).toBe(before.latest);
  expect(await fs.readFile(path.join(root, ws.directory, "execution.json"), "utf8")).toBe(execution);
  expect((await automationStatus(root)).status).toBe("changed");
  const shell = await runAutomationHook("claude", JSON.stringify({ cwd: root, session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "shell" }));
  expect(JSON.stringify(shell)).toContain("src/main.ts");
  await fs.writeFile(path.join(root, "AGENTS.md"), "Entry point: `src/wrong.ts`.\n");
  const unknown = await runAutomationHook("claude", JSON.stringify({ cwd: root, session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "mcp__custom__edit", tool_use_id: "unknown" }));
  expect(JSON.stringify(unknown)).toContain("src/wrong.ts");
}, 20000);

it.each(["claude", "codex"] as const)("records %s read-only activation from a subdirectory", async host => {
  vi.stubGlobal("PKG_VERSION", "test");
  vi.spyOn(launcher, "installedCommand").mockResolvedValue({ available: true, version: "test", message: null });
  await setupProject(root, { host });
  const revision = (await loadSetup(root))!.hosts[host]!.revision;
  vi.stubEnv("MASON_SETUP_ROOT", root); vi.stubEnv("MASON_SETUP_HOST", host); vi.stubEnv("MASON_SETUP_REVISION", revision);
  const ws = await workspace(root);
  for (const name of ["PreToolUse", "PostToolUse"]) {
    expect(await runAutomationHook(host, JSON.stringify({ cwd: path.join(root, "src"), session_id: "subdir", hook_event_name: name, tool_name: host === "claude" ? "Read" : "read_file" }))).toBeNull();
  }
  const observation = await readObservation(root, ws.directory, host, revision);
  expect(Object.values(observation!.sessions)).toEqual([expect.objectContaining({ events: ["before_tool", "after_tool"] })]);
  expect(Object.values(observation!.sessions)[0].verificationStatus).toBeUndefined();
}, 20000);

it("does not repeat malformed hook payload contents in diagnostics", async () => {
  const result = await runAutomationHook("claude", '{"prompt":"PRIVATE-CANARY" invalid}');
  expect(JSON.stringify(result)).not.toContain("PRIVATE-CANARY");
  expect(JSON.stringify(result)).toContain("Hook input is not valid JSON");
});

it("runs core CLI/MCP workflows with network denied and discards raw hook content", async () => {
  const log = path.join(root, "network-attempts.txt");
  const env = { ...process.env, MASON_TEST_NETWORK_LOG: log, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig") };
  // The tripwire must fail even if application code catches a network exception.
  await exec(process.execPath, ["--import", networkGuard, "--input-type=module", "-e", "try { await fetch('https://example.invalid'); } catch {}"], { env });
  expect(await fs.readFile(log, "utf8")).toContain("fetch"); await fs.rm(log);
  // On macOS the OS policy also denies network access in spawned Git processes.
  const runner = process.platform === "darwin"
    ? { command: "/usr/bin/sandbox-exec", args: ["-p", "(version 1)(allow default)(deny network*)", process.execPath] }
    : { command: process.execPath, args: [] };
  for (const args of [["audit", "--json"], ["review", "--base", "HEAD", "--json"], ["check", "--json"], ["status", "--json"]]) {
    const outcome = await exec(runner.command, [...runner.args, "--import", networkGuard, binary, ...args], { cwd: root, env });
    expect(outcome.stdout).toBeTruthy();
  }
  const client = new Client({ name: "network-regression", version: "1" });
  const transport = new StdioClientTransport({ command: runner.command, args: [...runner.args, "--import", networkGuard, path.resolve("dist/mason-mcp.js")], cwd: root, env: env as Record<string, string>, stderr: "pipe" });
  try {
    await client.connect(transport);
    for (const name of ["get_context", "get_impact"]) {
      const result = await client.callTool({ name, arguments: { dir: root, task: "inspect the entry point", files: ["src/main.ts"] } });
      expect(result.isError).not.toBe(true);
    }
  } finally { await client.close(); }
  const sentinel = "HOOK-RAW-CONTENT-MUST-NOT-PERSIST";
  const input = { cwd: root, session_id: "private-input", prompt: sentinel, tool_input: { command: sentinel }, tool_response: sentinel, transcript_path: path.join(root, sentinel) };
  // stdin is exercised through the real CLI, not just normalization in memory.
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(runner.command, [...runner.args, "--import", networkGuard, binary, "auto", "hook", "--host", "claude"], { cwd: root, env });
      let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
      child.on("error", reject); child.on("close", code => {
        try { expect(code).toBe(0); expect(output).not.toContain(sentinel); expect(output).not.toContain("automation unavailable"); resolve(); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ ...input, hook_event_name: event, tool_name: "Bash", tool_use_id: "paired" }));
    });
  }
  for (const file of await fs.readdir(path.join(root, ".mason"), { recursive: true })) {
    const absolute = path.join(root, ".mason", file);
    if ((await fs.stat(absolute)).isFile()) expect(await fs.readFile(absolute, "utf8")).not.toContain(sentinel);
  }
  await expect(fs.stat(log)).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);
