import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import fg from "fast-glob";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupProject } from "../src/setup/setup.js";
import { teardownProject } from "../src/setup/teardown.js";
import { setupStatus } from "../src/setup/status.js";
import { loadSetup, SETUP_PATH } from "../src/setup/model.js";
import { OWNERSHIP_PATH } from "../src/setup/ownership.js";
import * as launcher from "../src/setup/launcher.js";
import * as files from "../src/setup/files.js";
import * as storage from "../src/utils/storage.js";
import { installAutomation, AUTOMATION_PATH } from "../src/automation/install.js";
import { runAutomationCli } from "../src/automation/cli.js";
import { workspace } from "../src/automation/evidence.js";
import { commitAll, git, initGitRepo } from "./helpers.js";

let root: string;
const read = (file: string) => fs.readFile(path.join(root, file), "utf8");
const exists = (file: string) => fs.access(path.join(root, file)).then(() => true, () => false);
async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
async function tree(pattern = "**/*") {
  const paths = (await fg(pattern, { cwd: root, dot: true, ignore: [".git/**"] })).sort();
  return Object.fromEntries(await Promise.all(paths.map(async file => [file, await read(file)])));
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-teardown-")));
  await initGitRepo(root);
  await write("src/main.ts", "export const main = true;\n");
  await commitAll(root, "initial project");
  vi.spyOn(launcher, "installedCommand").mockResolvedValue({ available: true, version: "test", message: null });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

describe("project teardown", { timeout: 20000 }, () => {
  it.each(["codex", "claude"] as const)("disconnects %s, retains knowledge/evidence, and supports setup again", async host => {
    await setupProject(root, { host });
    await setupProject(root, { host }); // Ownership must survive idempotent setup.
    await write(".mason/config.json", '{"features":{"confluence":true}}\n');
    await write(".mason/decisions/lesson.json", '{"lesson":"retain exact bytes"}\n');
    await write(".mason/snapshot.json", '{"navigation":"retain exact bytes"}\n');
    await write(".mason/local/project.json", '{"version":1,"initializedAt":"today"}\n');
    const retained = await tree(".mason/{config.json,snapshot.json,decisions/**,reports/**}");
    const ignore = await read(".gitignore");
    const result = await teardownProject(path.join(root, "src"));
    expect(result.status).toBe("complete");
    for (const file of ["AGENTS.md", "CLAUDE.md", SETUP_PATH, AUTOMATION_PATH, OWNERSHIP_PATH, ".mason/local/project.json",
      ".codex/config.toml", ".codex/hooks.json", ".mcp.json", ".claude/settings.json"]) expect(await exists(file), file).toBe(false);
    for (const [file, bytes] of Object.entries(retained)) {
      if (/\/setup-(codex|claude)\.json$/.test(file)) expect(await exists(file)).toBe(false);
      else expect(await read(file)).toBe(bytes);
    }
    expect(await read(".gitignore")).toBe(ignore);
    expect((await setupStatus(root)).status).toBe("not-configured");
    expect((await teardownProject(root)).changes).toEqual([]);
    expect((await setupProject(root, { host })).status).toBe("configured");
    for (const [file, bytes] of Object.entries(retained)) if (file.includes("/repairs/")) expect(await read(file)).toBe(bytes);
  });

  it("previews exact changes without modifying files or creating state in an untouched repo", async () => {
    const original = await tree();
    expect((await teardownProject(root, { dryRun: true })).changes).toEqual([]);
    expect(await tree()).toEqual(original);
    expect(await exists(".mason")).toBe(false);
    await setupProject(root, { host: "codex" });
    const before = await tree();
    const preview = await teardownProject(root, { dryRun: true });
    expect(preview.changes.length).toBeGreaterThan(0);
    expect(await tree()).toEqual(before);
    expect((await teardownProject(root)).changes).toEqual(preview.changes);
  });

  it("keeps shared instructions and the other host, then removes them after the last host", async () => {
    await setupProject(root, { host: "claude" });
    await setupProject(root, { host: "codex" });
    const instructions = await read("AGENTS.md"), pointer = await read("CLAUDE.md"), mcp = await read(".mcp.json"), hooks = await read(".claude/settings.json");
    const claude = (await loadSetup(root))!.hosts.claude;
    vi.stubEnv("MASON_SETUP_HOST", "claude"); // Default teardown must not inherit setup's host preference.
    expect((await teardownProject(root, { host: "codex" })).status).toBe("complete");
    expect(await read("AGENTS.md")).toBe(instructions);
    expect(await read("CLAUDE.md")).toBe(pointer);
    expect(await read(".mcp.json")).toBe(mcp);
    expect(await read(".claude/settings.json")).toBe(hooks);
    expect((await loadSetup(root))!.hosts).toEqual({ claude });
    expect((await setupStatus(root)).hosts.claude.status).toBe("pending");
    expect((await teardownProject(root)).status).toBe("complete");
    expect(await exists("CLAUDE.md")).toBe(false);
    expect(await exists("AGENTS.md")).toBe(false);
  });

  it("preserves user settings, mixed hook groups and instruction bytes outside Mason blocks", async () => {
    const prefix = "User conventions\r\n", suffix = "\r\nNew instructions: keep these.\r\n";
    await write("AGENTS.md", prefix);
    const toml = '# user comment\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n';
    await write(".codex/config.toml", toml);
    await write(".mcp.json", JSON.stringify({ mcpServers: { other: { command: "other" } }, setting: 7 }));
    await setupProject(root, { host: "codex" });
    await setupProject(root, { host: "claude" });
    await fs.appendFile(path.join(root, "AGENTS.md"), suffix);
    const config = JSON.parse(await read(".codex/hooks.json"));
    config.userSetting = true;
    config.hooks.PreToolUse[0].hooks.push({ type: "command", command: "another-tool" });
    const originalGroup = { ...config.hooks.PreToolUse[0], hooks: [{ type: "command", command: "another-tool" }] };
    await write(".codex/hooks.json", JSON.stringify(config));
    await fs.appendFile(path.join(root, ".codex/config.toml"), '\n# Added after setup\n[features]\nexample = true\n');
    expect((await teardownProject(root)).status).toBe("complete");
    expect(await read("AGENTS.md")).toBe(prefix + "\r\n" + suffix);
    const remaining = await read(".codex/config.toml");
    expect(remaining.startsWith(toml)).toBe(true);
    expect(remaining).toContain("# Added after setup");
    expect(parse(remaining)).toEqual({ model: "example", mcp_servers: { other: { command: "other" } }, features: { example: true } });
    expect(JSON.parse(await read(".mcp.json"))).toEqual({ mcpServers: { other: { command: "other" } }, setting: 7 });
    expect(JSON.parse(await read(".codex/hooks.json"))).toEqual({ userSetting: true, hooks: { PreToolUse: [originalGroup] } });
  });

  it("leaves preexisting empty files in place", async () => {
    await write("AGENTS.md", "");
    await write(".mcp.json", "{}");
    await write(".claude/settings.json", "{}");
    await setupProject(root, { host: "claude" });
    await teardownProject(root);
    for (const file of ["AGENTS.md", ".mcp.json", ".claude/settings.json"]) expect(await exists(file)).toBe(true);
    expect(await read("AGENTS.md")).toBe("");
  });

  it("retains an edited MCP entry and can resume after manual cleanup", async () => {
    await setupProject(root, { host: "claude" });
    const mcp = JSON.parse(await read(".mcp.json"));
    mcp.mcpServers.mason.command = "custom-wrapper";
    await write(".mcp.json", JSON.stringify(mcp));
    const before = await read(".mcp.json");
    const result = await teardownProject(root);
    expect(result.status).toBe("incomplete");
    expect(result.diagnostics[0].path).toBe(".mcp.json");
    expect(await read(".mcp.json")).toBe(before);
    expect(await exists(SETUP_PATH)).toBe(true);
    expect(await exists("AGENTS.md")).toBe(true);
    await fs.rm(path.join(root, ".mcp.json"));
    expect((await teardownProject(root)).status).toBe("complete");
    expect((await setupStatus(root)).status).toBe("not-configured");
  });

  it.each(["edited", "duplicate"])("retains all instruction files when one block is %s", async variant => {
    await setupProject(root, { host: "claude" });
    const agents = await read("AGENTS.md");
    const text = await read("CLAUDE.md");
    await write("CLAUDE.md", variant === "edited" ? text.replace("Mason project knowledge", "My special context") : text + text);
    const result = await teardownProject(root);
    expect(result.status).toBe("incomplete");
    expect(result.diagnostics.some(d => d.path === "CLAUDE.md")).toBe(true);
    expect(await read("AGENTS.md")).toBe(agents);
    expect(await exists(OWNERSHIP_PATH)).toBe(true);
  });

  it("retains edited hook commands and removes recorded custom commands without executing them", async () => {
    await installAutomation(root, "codex", "never-execute-this");
    expect((await teardownProject(root)).status).toBe("complete");
    expect(await exists(".codex/hooks.json")).toBe(false);
    await setupProject(root, { host: "codex" });
    const config = JSON.parse(await read(".codex/hooks.json"));
    config.hooks.Stop[0].hooks[0].command += " --user-option";
    await write(".codex/hooks.json", JSON.stringify(config));
    const result = await teardownProject(root);
    expect(result.status).toBe("incomplete");
    expect(JSON.parse(await read(".codex/hooks.json")).hooks.Stop[0].hooks[0].command).toContain("--user-option");
  });

  it("reports a renamed hook even when its new command does not mention Mason", async () => {
    await setupProject(root, { host: "codex" });
    const config = JSON.parse(await read(".codex/hooks.json"));
    config.hooks.Stop[0].hooks[0].command = "custom-wrapper";
    await write(".codex/hooks.json", JSON.stringify(config));
    const result = await teardownProject(root);
    expect(result.status).toBe("incomplete");
    expect(result.diagnostics.some(d => d.message.includes("new or edited handler"))).toBe(true);
    expect(JSON.parse(await read(".codex/hooks.json")).hooks.Stop[0].hooks[0].command).toBe("custom-wrapper");
  });

  it("retains command ownership across interrupted custom-hook upgrades", async () => {
    await installAutomation(root, "codex", "first-wrapper");
    const apply = files.applyEdit;
    const spy = vi.spyOn(files, "applyEdit").mockImplementation(async (dir, edit) => {
      if (edit.path === ".codex/hooks.json") throw new Error("interrupted custom install");
      return apply(dir, edit);
    });
    await expect(installAutomation(root, "codex", "second-wrapper")).rejects.toThrow("interrupted custom install");
    spy.mockRestore();
    const result = await teardownProject(root);
    expect(result.status).toBe("complete");
    expect(await exists(".codex/hooks.json")).toBe(false);
  });

  it("resumes repeated custom-hook interruptions on either side of the configuration write", async () => {
    await installAutomation(root, "codex", "first-wrapper");
    const save = storage.writeStoreJson;
    const receiptFailure = vi.spyOn(storage, "writeStoreJson").mockImplementation(async (dir, file, value) => {
      if (file === AUTOMATION_PATH) throw new Error("interrupted receipt");
      return save(dir, file, value);
    });
    await expect(installAutomation(root, "codex", "second-wrapper")).rejects.toThrow("interrupted receipt");
    receiptFailure.mockRestore();
    const apply = files.applyEdit;
    const configFailure = vi.spyOn(files, "applyEdit").mockImplementation(async (dir, edit) => {
      if (edit.path === ".codex/hooks.json") throw new Error("interrupted config");
      return apply(dir, edit);
    });
    await expect(installAutomation(root, "codex", "third-wrapper")).rejects.toThrow("interrupted config");
    configFailure.mockRestore();
    await installAutomation(root, "codex", "fourth-wrapper");
    const config = JSON.parse(await read(".codex/hooks.json"));
    expect(config.hooks.Stop).toHaveLength(1);
    expect(config.hooks.Stop[0].hooks[0].command).toContain("fourth-wrapper");
    expect((await teardownProject(root)).status).toBe("complete");
    expect(await exists(".codex/hooks.json")).toBe(false);
  });

  it("allows manually removed Mason handlers beside unchanged preexisting hooks", async () => {
    await write(".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-tool" }] }] } }));
    await setupProject(root, { host: "codex" });
    const config = JSON.parse(await read(".codex/hooks.json"));
    config.hooks.Stop.pop();
    await write(".codex/hooks.json", JSON.stringify(config));
    expect((await teardownProject(root)).status).toBe("complete");
    expect(JSON.parse(await read(".codex/hooks.json")).hooks.Stop[0].hooks[0].command).toBe("existing-tool");
  });

  it("does not treat a renamed MCP table inside Mason markers as successful removal", async () => {
    await setupProject(root, { host: "codex" });
    const edited = (await read(".codex/config.toml")).replace("mcp_servers.mason", "mcp_servers.custom");
    await write(".codex/config.toml", edited);
    expect((await teardownProject(root)).status).toBe("incomplete");
    expect(await read(".codex/config.toml")).toBe(edited);
  });

  it("uses clear markers/commands without receipts, but does not infer file creation", async () => {
    await setupProject(root, { host: "codex" });
    await fs.rm(path.join(root, ".mason/local"), { recursive: true });
    expect((await teardownProject(root)).status).toBe("complete");
    expect(await read("AGENTS.md")).toBe("");
    expect(JSON.parse(await read(".codex/hooks.json"))).toEqual({});
    expect(parse(await read(".codex/config.toml"))).toEqual({});
    expect((await teardownProject(root)).changes).toEqual([]);
  });

  it("retains shared guidance for an unrecorded second host", async () => {
    await setupProject(root, { host: "codex" });
    await write(".mcp.json", JSON.stringify({ mcpServers: { mason: launcher.mcpCommand("claude") } }));
    const original = await read("AGENTS.md");
    expect((await teardownProject(root, { host: "codex" })).sharedInstructionsRetained).toBe(true);
    expect(await read("AGENTS.md")).toBe(original);
  });

  it("preserves shared instructions belonging to another host's interrupted setup", async () => {
    const apply = files.applyEdit;
    const spy = vi.spyOn(files, "applyEdit").mockImplementation(async (dir, edit) => {
      if (edit.path === ".codex/config.toml") throw new Error("interrupted setup");
      return apply(dir, edit);
    });
    await expect(setupProject(root, { host: "codex" })).rejects.toThrow("interrupted setup");
    spy.mockRestore();
    const instructions = await read("AGENTS.md");
    const result = await teardownProject(root, { host: "claude" });
    expect(result.changes).toEqual([]);
    expect(result.sharedInstructionsRetained).toBe(true);
    expect(await read("AGENTS.md")).toBe(instructions);
    expect((await teardownProject(root, { host: "codex" })).status).toBe("complete");
  });

  it("removes setup receipts across branches without deleting branch repair evidence", async () => {
    await setupProject(root, { host: "codex" });
    const first = await workspace(root);
    await git(["checkout", "-b", "another-branch"], root);
    await setupProject(root, { host: "codex" });
    const second = await workspace(root);
    expect(first.directory).not.toBe(second.directory);
    const evidence = await tree(".mason/reports/repairs/**");
    await teardownProject(root);
    expect(await tree(".mason/reports/repairs/**")).toEqual(evidence);
    expect(await exists(first.directory + "/setup-codex.json")).toBe(false);
    expect(await exists(second.directory + "/setup-codex.json")).toBe(false);
  });

  it("recovers teardown after setup was interrupted before its configuration commit", async () => {
    const apply = files.applyEdit;
    const spy = vi.spyOn(files, "applyEdit").mockImplementation(async (dir, edit) => {
      if (edit.path === ".codex/config.toml") throw new Error("interrupted setup");
      return apply(dir, edit);
    });
    await expect(setupProject(root, { host: "codex" })).rejects.toThrow("interrupted setup");
    expect(await exists(OWNERSHIP_PATH)).toBe(true);
    spy.mockRestore();
    expect((await teardownProject(root)).status).toBe("complete");
    expect(await exists("AGENTS.md")).toBe(false);
    expect((await setupStatus(root)).status).toBe("not-configured");
  });

  it("resumes interrupted removal and retains ownership until cleanup finishes", async () => {
    await setupProject(root, { host: "codex" });
    const apply = files.applyEdit;
    const spy = vi.spyOn(files, "applyEdit").mockImplementation(async (dir, edit) => {
      if (edit.path === "AGENTS.md") throw new Error("interrupted teardown");
      return apply(dir, edit);
    });
    await expect(teardownProject(root)).rejects.toThrow("interrupted teardown");
    expect(await exists(".codex/config.toml")).toBe(false);
    expect(await exists(OWNERSHIP_PATH)).toBe(true);
    spy.mockRestore();
    expect((await teardownProject(root)).status).toBe("complete");
    expect((await teardownProject(root)).changes).toEqual([]);
  });

  it("rejects a concurrent user edit before deleting a generated file", async () => {
    await setupProject(root, { host: "codex" });
    const apply = files.applyEdit;
    const spy = vi.spyOn(files, "applyEdit").mockImplementation(async (dir, edit) => {
      if (edit.path === ".codex/config.toml") await write(edit.path, '# Concurrent user edit\n');
      return apply(dir, edit);
    });
    await expect(teardownProject(root)).rejects.toThrow("changed during update");
    expect(await read(".codex/config.toml")).toBe('# Concurrent user edit\n');
    spy.mockRestore();
    expect(await exists(OWNERSHIP_PATH)).toBe(true);
  });

  it("retains malformed configs, rejects invalid ownership, and refuses symlinks", async () => {
    await setupProject(root, { host: "codex" });
    await write(".codex/hooks.json", "invalid JSON");
    expect((await teardownProject(root)).status).toBe("incomplete");
    expect(await read(".codex/hooks.json")).toBe("invalid JSON");
    await write(OWNERSHIP_PATH, "invalid ownership");
    const before = await tree();
    await expect(teardownProject(root)).rejects.toThrow();
    expect(await tree()).toEqual(before);
    await fs.rm(path.join(root, OWNERSHIP_PATH));
    await fs.rm(path.join(root, ".codex/hooks.json"));
    await fs.symlink(path.join(root, "src/main.ts"), path.join(root, ".codex/hooks.json"));
    const result = await teardownProject(root);
    expect(result.status).toBe("incomplete");
    expect(result.diagnostics.some(d => d.message.includes("Symlink"))).toBe(true);
    expect(await read("src/main.ts")).toBe("export const main = true;\n");
  });

  it("routes the unified CLI and reports invalid flags and incomplete dry runs with exit 2", async () => {
    const executable = path.resolve("dist/mason.js");
    const cli = JSON.parse(execFileSync(process.execPath, [executable, "teardown", "--dir", path.join(root, "src"), "--dry-run", "--json"], { encoding: "utf8" }));
    expect(cli).toMatchObject({ action: "teardown", status: "complete", dryRun: true, root });
    const output: string[] = [], io = { out: (s: string) => output.push(s), err: (s: string) => output.push(s) };
    for (const args of [["teardown", "--host", "other"], ["teardown", "--command", "anything"], ["setup", "--dry-run"]]) {
      expect(await runAutomationCli([...args, "--dir", root, "--json"], "", io)).toBe(2);
    }
    await write(".mcp.json", '{"mcpServers":{"mason":{"command":"custom"}}}');
    expect(await runAutomationCli(["teardown", "--dir", root, "--dry-run", "--json"], "", io)).toBe(2);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ action: "teardown", status: "incomplete", dryRun: true });
    expect(await read(".mcp.json")).toContain("custom");
  });
});
