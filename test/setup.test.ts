import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setupProject } from "../src/setup/setup.js";
import { setupStatus } from "../src/setup/status.js";
import { observeActivation, observationPath } from "../src/setup/observations.js";
import { loadSetup } from "../src/setup/model.js";
import { applyEdit, managedBlock } from "../src/setup/files.js";
import { mcpEdit } from "../src/setup/config.js";
import * as runtime from "../src/setup/runtime.js";
import { runAutomationHook } from "../src/automation/adapters.js";
import { automate } from "../src/automation/runtime.js";
import { workspace } from "../src/automation/evidence.js";
import { recordExecution } from "../src/automation/execution.js";
import { runAutomationCli, isHookCommand } from "../src/automation/cli.js";
import { masonInit, getContext } from "../src/mcp/tools.js";
import { createMcpServer } from "../src/mcp/server.js";
import { commitAll, git, initGitRepo } from "./helpers.js";

let root: string;
async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
async function activateEnvironment(host: "codex" | "claude") {
  const setup = (await loadSetup(root))!;
  vi.stubEnv("MASON_SETUP_ROOT", root);
  vi.stubEnv("MASON_SETUP_HOST", host);
  vi.stubEnv("MASON_SETUP_REVISION", setup.hosts[host]!.revision);
}
async function hook(name: string, session = "ordinary-session") {
  return runAutomationHook("codex", JSON.stringify({ cwd: root, session_id: session, hook_event_name: name, tool_name: "read_file", tool_use_id: "read" }));
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-setup-")));
  await initGitRepo(root);
  await write("src/main.kt", "fun main() = println(\"hello\")\n");
  await write("AGENTS.md", "The `src/main.kt` entry point.\n");
  await commitAll(root, "initial Kotlin project");
  // Unit cases exercise configuration/evidence using actual built binaries but
  // never fetch dependencies. A separate packaged smoke run covers npm + stdio.
  vi.spyOn(runtime, "installRuntime").mockImplementation(async (dir, selected) => {
    const base = path.join(dir, ".mason/runtime", selected.runtime.id);
    const pkg = path.join(base, "node_modules/mason-context");
    await fs.mkdir(path.join(pkg, "dist"), { recursive: true });
    for (const file of Object.keys(selected.runtime.hashes)) await fs.copyFile(path.join(selected.source, file), path.join(pkg, file));
    await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "mason-context", version: selected.runtime.version }));
    await fs.writeFile(path.join(base, "receipt.json"), JSON.stringify(selected.runtime));
    return selected.runtime;
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }, 120000);

describe("unified setup", { timeout: 20000 }, () => {
  it("sets up with over 100,000 ignored generated paths and retains evidence for a later source change", async () => {
    await write(".gitignore", "artifacts/\n.mason/reports/\n");
    await commitAll(root, "ignore generated artifacts");
    const initial = await automate(root, { event: "session_start" });
    const baseline = initial.report.baselinePaths[0];
    const original = await fs.readFile(path.join(root, baseline));
    const artifacts = path.join(root, "artifacts");
    await fs.mkdir(artifacts);
    // Real files exercise Git pruning and the complete setup path, including
    // the second capture after instruction/configuration edits.
    const count = 100001;
    await Promise.all(Array.from({ length: 64 }, async (_, worker) => {
      for (let index = worker; index < count; index += 64) {
        await fs.writeFile(path.join(artifacts, `generated-${index}.ts`), "");
      }
    }));
    expect((await fs.readdir(artifacts)).length).toBe(count);
    const result = await setupProject(root, { host: "codex" });
    expect(result.status).toBe("configured");
    expect(result.findings.audit.issues).toEqual([]);
    const configured = await automate(root, { event: "task_end" });
    expect(configured.report.baselinePaths).toContain(baseline);
    await write("new-feature/main.kt", "fun feature() = true\n");
    const changed = await automate(root, { event: "task_end" });
    expect(changed.report.findings.some(f => f.original.type === "new-module" && f.status === "unresolved")).toBe(true);
    await fs.appendFile(path.join(root, "AGENTS.md"), "\nThe new-feature directory contains the added capability.\n");
    await commitAll(root, "document the new feature and commit setup metadata");
    const verified = await automate(root, { event: "task_end" });
    expect(verified.report.status).toBe("verified");
    expect(verified.report.baselinePaths).toEqual(changed.report.baselinePaths);
    expect(await fs.readFile(path.join(root, baseline))).toEqual(original);
  }, 120000);

  it.each(["codex", "claude"] as const)("sets up %s in a non-npm repo and retains original evidence before instruction edits", async host => {
    const original = "The `src/missing.kt` entry point.\n";
    await write("AGENTS.md", original);
    await commitAll(root, "outdated instructions");
    const result = await setupProject(root, { host });
    expect(result.status).toBe("configured");
    expect(result.activation.status).toBe("pending");
    if (host === "claude") expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toContain("\n@AGENTS.md\n");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toContain(original);
    await expect(fs.access(path.join(root, "package.json"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".mason/decisions"))).rejects.toThrow();
    const before = JSON.parse(await fs.readFile(path.join(root, result.initialReportPath), "utf8"));
    expect(before.findings.some(f => f.original.type === "deleted-reference")).toBe(true);
    expect(before.baselinePaths.length).toBeGreaterThan(0);
    const baseline = JSON.parse(await fs.readFile(path.join(root, before.baselinePaths[0]), "utf8"));
    expect(baseline.report.docs[0].dirty).toBe(false);
    expect((await git(["status", "--porcelain"], root))).not.toContain("runtime/");
    expect(await git(["check-ignore", ".mason/reports/example.json"], root)).toBe(".mason/reports/example.json");
    expect(await git(["check-ignore", ".mason/runtime/example"], root)).toBe(".mason/runtime/example");
  });

  it("repeats setup without duplicate instructions, hooks, baseline replacement, or activation reset", async () => {
    await write("CLAUDE.md", "Keep these project conventions exactly.\r\n");
    const first = await setupProject(root, { host: "codex" });
    const config = JSON.stringify(await loadSetup(root));
    const before = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    const second = await setupProject(root, { host: "codex" });
    expect(second.changedFiles).toEqual([]);
    expect(JSON.stringify(await loadSetup(root))).toBe(config);
    expect(second.initialReportPath).toBe(first.initialReportPath);
    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(before);
    expect(before.startsWith("Keep these project conventions exactly.\r\n")).toBe(true);
    const hooks = JSON.parse(await fs.readFile(path.join(root, ".codex/hooks.json"), "utf8"));
    expect(hooks.hooks.Stop).toHaveLength(1);
  });

  it("creates Codex-readable AGENTS.md while keeping existing Claude project conventions", async () => {
    await fs.rm(path.join(root, "AGENTS.md"));
    await write(".claude/CLAUDE.md", "Existing conventions: use the src directory.\n");
    const first = await setupProject(root, { host: "codex" });
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toContain(".claude/CLAUDE.md");
    expect(await fs.readFile(path.join(root, ".claude/CLAUDE.md"), "utf8")).toContain("Existing conventions: use the src directory.\n");
    expect(await fs.readFile(path.join(root, ".claude/CLAUDE.md"), "utf8")).toContain("\n@../AGENTS.md\n");
    expect((await setupProject(root, { host: "codex" })).changedFiles).toEqual([]);
    expect(first.activation.hosts.codex.instructions).toBe("current");
  });

  it("adds guidance and a first baseline when no instruction files exist", async () => {
    await fs.rm(path.join(root, "AGENTS.md"));
    await commitAll(root, "remove instructions");
    const result = await setupProject(root, { host: "codex" });
    expect(result.findings.audit.status).toBe("no-context-files");
    const after = await automate(root, { event: "task_end" });
    expect(after.report.baselinePaths.length).toBeGreaterThan(0);
    expect((await setupStatus(root)).hosts.codex.observedEvents).toEqual([]);
  });

  it("preserves unrelated TOML bytes, JSON settings, and existing hooks", async () => {
    const toml = '# comment\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n';
    await write(".codex/config.toml", toml);
    const originalHook = { hooks: [{ type: "command", command: "existing-tool" }], matcher: "Edit" };
    await write(".codex/hooks.json", JSON.stringify({ setting: 7, hooks: { PreToolUse: [originalHook] } }));
    await setupProject(root, { host: "codex" });
    const config = await fs.readFile(path.join(root, ".codex/config.toml"), "utf8");
    expect(config.startsWith(toml)).toBe(true);
    expect(parse(config).mcp_servers.other.command).toBe("other");
    const hooks = JSON.parse(await fs.readFile(path.join(root, ".codex/hooks.json"), "utf8"));
    expect(hooks.setting).toBe(7);
    expect(hooks.hooks.PreToolUse[0]).toEqual(originalHook);
  });

  it("migrates an existing explicit Mason MCP table while preserving other settings", async () => {
    await write(".codex/config.toml", '# before\nmodel = "test"\n[mcp_servers.mason]\ncommand = "old"\nargs = []\nenabled = false\ntool_timeout_sec = 80\n[mcp_servers.mason.env]\nPROJECT_OPTION = "keep"\n[mcp_servers.other]\ncommand = "keep"\n');
    const edit = await mcpEdit(root, "codex");
    const parsed = parse(edit.after);
    expect(parsed.model).toBe("test");
    expect(parsed.mcp_servers.other.command).toBe("keep");
    expect(parsed.mcp_servers.mason.command).toBe("node");
    expect(parsed.mcp_servers.mason.enabled).toBe(false);
    expect(parsed.mcp_servers.mason.tool_timeout_sec).toBe(80);
    expect(parsed.mcp_servers.mason.env).toEqual({ PROJECT_OPTION: "keep" });
    expect(edit.after).toContain('[mcp_servers.other]\ncommand = "keep"\n');
    const result = await setupProject(root, { host: "codex" });
    expect(result.activation.hosts.codex.status).toBe("attention");
    expect((await setupProject(root, { host: "codex" })).changedFiles).toEqual([]);
  });

  it("preserves Claude server options and replaces only its transport details", async () => {
    await write(".mcp.json", JSON.stringify({ mcpServers: { mason: { type: "http", url: "https://example.invalid", env: { OPTION: "keep" } }, other: { command: "other" } } }));
    const result = await setupProject(root, { host: "claude" });
    const config = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(config.mcpServers.mason.env).toEqual({ OPTION: "keep" });
    expect(config.mcpServers.mason.url).toBeUndefined();
    expect(config.mcpServers.mason.type).toBeUndefined();
    expect(config.mcpServers.other).toEqual({ command: "other" });
    expect(result.activation.hosts.claude.mcp).toBe("configured");
  });

  it("replaces obsolete secondary Mason guidance without changing surrounding conventions", async () => {
    await write("CLAUDE.md", "Before\r\n<!-- mason:start -->\r\nObsolete commands\r\n<!-- mason:end -->\r\nAfter\r\n");
    await setupProject(root, { host: "claude" });
    const text = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(text).toContain("\n@AGENTS.md\r\n");
    expect(text).not.toContain("Obsolete commands");
    expect(text.startsWith("Before\r\n")).toBe(true);
    expect(text.endsWith("\r\nAfter\r\n")).toBe(true);
    expect((await setupProject(root, { host: "claude" })).changedFiles).toEqual([]);
  });

  it("adds a native Claude import beside a prose mention and preserves an existing import-only file", async () => {
    const original = "Project information is also in AGENTS.md.\n";
    await write("CLAUDE.md", original);
    await setupProject(root, { host: "claude" });
    const text = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("\n@AGENTS.md\n");
    await write("CLAUDE.md", "@AGENTS.md\r\n");
    await setupProject(root, { host: "claude" });
    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\r\n");
  });

  it.each([
    [".codex/config.toml", "[broken"],
    [".codex/hooks.json", "{broken"],
    ["AGENTS.md", "original\n<!-- mason:start -->unfinished"],
  ])("rejects malformed %s before runtime installation or shared file edits", async (file, value) => {
    await write(file, value);
    const docs = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    await expect(setupProject(root, { host: "codex" })).rejects.toThrow();
    expect(runtime.installRuntime).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe(value);
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(docs);
  });

  it("resumes a failed runtime install with the original pre-edit audit intact", async () => {
    const install = vi.mocked(runtime.installRuntime).getMockImplementation()!;
    vi.mocked(runtime.installRuntime).mockRejectedValueOnce(new Error("network unavailable"));
    const before = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    await expect(setupProject(root, { host: "codex" })).rejects.toThrow("network unavailable");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(before);
    expect((await setupStatus(root)).status).toBe("incomplete");
    vi.mocked(runtime.installRuntime).mockImplementation(install);
    const done = await setupProject(root, { host: "codex" });
    const original = JSON.parse(await fs.readFile(path.join(root, done.initialReportPath), "utf8"));
    expect(original.baselinePaths).toHaveLength(1);
    expect(done.activation.status).toBe("pending");
  });

  it("refuses concurrent file edits and symlinked setup files", async () => {
    const edit = { path: "AGENTS.md", before: await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), after: "replacement" };
    await write("AGENTS.md", "new concurrent content");
    await expect(applyEdit(root, edit)).rejects.toThrow("changed during");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("new concurrent content");
    await fs.mkdir(path.join(root, ".codex"));
    await fs.symlink(path.join(root, "AGENTS.md"), path.join(root, ".codex/config.toml"));
    await expect(setupProject(root, { host: "codex" })).rejects.toThrow("Symlink");
  });

  it("keeps reports private and decisions shareable under an existing blanket Mason ignore", async () => {
    await write(".gitignore", "# existing\r\n.mason/\r\n");
    await setupProject(root, { host: "codex" });
    expect(await git(["check-ignore", ".mason/reports/test.json"], root)).toBe(".mason/reports/test.json");
    const visible = await git(["check-ignore", "--verbose", ".mason/decisions/test.json"], root);
    expect(visible).toContain("!/.mason/decisions/**");
    expect((await setupProject(root, { host: "codex" })).changedFiles).toEqual([]);
  });

  it("uses the same setup engine through MCP mode and CLI, keeping inspection read-only", async () => {
    expect(JSON.parse(await masonInit(root)).mode).toBe("quickstart");
    await expect(fs.access(path.join(root, ".mason"))).rejects.toThrow();
    const setup = JSON.parse(await masonInit(root, { mode: "setup", host: "codex" }));
    expect(setup.status).toBe("configured");
    const lines: string[] = [];
    expect(await runAutomationCli(["setup", "--dir", root, "--host", "codex", "--json"], "", { out: s => lines.push(s), err: s => lines.push(s) })).toBe(0);
    expect(JSON.parse(lines[0]).changedFiles).toEqual([]);
  });

  it("requires a host when detection is ambiguous and preserves explicit disabled settings", async () => {
    await expect(setupProject(root)).rejects.toThrow("--host");
    await write(".codex/config.toml", "[features]\nhooks = false\n");
    const result = await setupProject(root);
    expect(result.host).toBe("codex");
    expect(result.activation.hosts.codex.status).toBe("attention");
    expect(parse(await fs.readFile(path.join(root, ".codex/config.toml"), "utf8")).features.hooks).toBe(false);
  });

  it("requires actual MCP and hook observations and isolates sessions and installation revisions", async () => {
    await setupProject(root, { host: "codex" });
    await activateEnvironment("codex");
    await commitAll(root, "configure Mason");
    await getContext(root, "Read source", ["src/main.kt"]);
    expect((await setupStatus(root)).hosts.codex.contextCalls).toBe(0);
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"]) await hook(event, "one");
    for (const event of ["PostToolUse", "Stop"]) await hook(event, "two");
    expect((await setupStatus(root)).hosts.codex.status).toBe("pending");
    for (const event of ["PostToolUse", "Stop"]) await hook(event, "one");
    expect((await setupStatus(root)).hosts.codex.status).toBe("pending");
    vi.stubGlobal("PKG_VERSION", "test");
    const server = createMcpServer();
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      await client.callTool({ name: "get_context", arguments: { dir: root, task: "Explain the project", files: ["src/main.kt"] } });
    } finally { await client.close(); await server.close(); }
    expect((await setupStatus(root)).hosts.codex.status).toBe("active");
    const ws = await workspace(root);
    const observed = await fs.readFile(path.join(root, observationPath(ws.directory, "codex", (await loadSetup(root))!.hosts.codex!.revision)), "utf8");
    expect(observed).not.toContain("Explain the project");
    expect(observed).not.toContain("src/main.kt");
    await write(".codex/hooks.json", "{}");
    expect((await setupStatus(root)).hosts.codex.status).toBe("attention");
    await setupProject(root, { host: "codex" });
    expect((await setupStatus(root)).hosts.codex.status).toBe("pending");
    expect(await observeActivation(root, "context")).toContain("restart");
    await git(["switch", "-c", "other"], root);
    expect((await setupStatus(root)).hosts.codex.status).not.toBe("active");
  }, 60000);

  it("reports a failed latest attempt instead of an older passing verification", async () => {
    await setupProject(root, { host: "codex" });
    await commitAll(root, "configure Mason");
    await automate(root, { event: "task_end" });
    expect((await setupStatus(root)).hosts.codex.verificationStatus).toBe("verified");
    const ws = await workspace(root);
    await expect(recordExecution(root, ws.directory, "task_end", async () => { throw new Error("capture failed"); })).rejects.toThrow("capture failed");
    expect((await setupStatus(root)).hosts.codex).toMatchObject({ status: "attention", verificationStatus: "unavailable" });
    await automate(root, { event: "task_end" });
    expect((await setupStatus(root)).hosts.codex).toMatchObject({ status: "pending", verificationStatus: "verified" });
  });

  it("reports missing or changed runtimes and changed inputs without reusing a passing verification", async () => {
    const result = await setupProject(root, { host: "codex" });
    await commitAll(root, "configure Mason");
    await automate(root, { event: "task_end" });
    expect((await setupStatus(root)).hosts.codex.verificationStatus).toBe("verified");
    await write("AGENTS.md", (await fs.readFile(path.join(root, "AGENTS.md"), "utf8")) + "Extra project instructions.\n");
    expect((await setupStatus(root)).hosts.codex.verificationStatus).toBe("unavailable");
    await write(`.mason/runtime/${result.runtime.id}/node_modules/mason-context/dist/mason-mcp.js`, "changed binary");
    expect((await setupStatus(root)).hosts.codex).toMatchObject({ status: "attention", runtime: "missing-or-changed" });
    await fs.rm(path.join(root, `.mason/runtime/${result.runtime.id}`), { recursive: true });
    expect((await setupStatus(root)).hosts.codex.runtime).toBe("missing-or-changed");
    await setupProject(root, { host: "codex" });
    expect((await setupStatus(root)).hosts.codex.runtime).toBe("installed");
  });

  it("does not read hook stdin for a directory called hook or a help request", () => {
    expect(isHookCommand(["--dir", "hook", "status"])).toBe(false);
    expect(isHookCommand(["hook", "--help"])).toBe(false);
    expect(isHookCommand(["hook", "--host", "codex"])).toBe(true);
  });

  it("keeps the marked block idempotent without changing surrounding CRLF bytes", () => {
    const before = "before\r\n<!-- mason:start -->\r\nold\r\n<!-- mason:end -->\r\nafter\r\n";
    const after = managedBlock(before, "<!-- mason:start -->", "<!-- mason:end -->", "new\nbody");
    expect(after).toBe("before\r\n<!-- mason:start -->\r\nnew\r\nbody\r\n<!-- mason:end -->\r\nafter\r\n");
    expect(managedBlock(after, "<!-- mason:start -->", "<!-- mason:end -->", "new\nbody")).toBe(after);
  });
});
