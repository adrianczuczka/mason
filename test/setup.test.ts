import { configureProject } from "./helpers.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configureUsefulness, usefulnessStatus } from "../src/automation/usefulness.js";
import { initializeProject, setupProject, summarizeSetup } from "../src/setup/setup.js";
import { setupStatus } from "../src/setup/status.js";
import { observeActivation, observationPath } from "../src/setup/observations.js";
import { loadSetup } from "../src/setup/model.js";
import { applyEdit, managedBlock } from "../src/setup/files.js";
import { mcpEdit } from "../src/setup/config.js";
import * as launcher from "../src/setup/launcher.js";
import * as setupFiles from "../src/setup/files.js";
import { runAutomationHook } from "../src/automation/adapters.js";
import { automate } from "../src/automation/runtime.js";
import * as automation from "../src/automation/runtime.js";
import * as onboarding from "../src/mcp/onboarding.js";
import { workspace } from "../src/automation/evidence.js";
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
  return runAutomationHook(
    "codex",
    JSON.stringify({
      cwd: root,
      session_id: session,
      hook_event_name: name,
      tool_name: "read_file",
      tool_use_id: "read",
    }),
  );
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-setup-")));
  await initGitRepo(root);
  await write("src/main.kt", 'fun main() = println("hello")\n');
  await write("AGENTS.md", "The `src/main.kt` entry point.\n");
  await commitAll(root, "initial Kotlin project");
  vi.stubGlobal("PKG_VERSION", "test");
  vi.spyOn(launcher, "installedCommand").mockResolvedValue({
    available: true,
    version: "test",
    message: null,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
}, 120000);

describe("unified setup", { timeout: 20000 }, () => {
  it.each(["claude", "codex"] as const)(
    "activates %s in a fresh clone without shared edits",
    async (host) => {
      await configureProject(root, { host });
      await commitAll(root, "prepare team configuration");
      const clone = path.join(root, "clone");
      await git(["clone", root, clone], root);
      try {
        const apply = setupFiles.applyEdit;
        vi.spyOn(setupFiles, "applyEdit").mockImplementation(async (dir, edit) => {
          expect(edit.path.startsWith(".mason/local/")).toBe(true);
          return apply(dir, edit);
        });
        const result = await setupProject(clone, { host });
        expect(result.mode).toBe("activate");
        expect(result.activation.status).toBe("pending");
        expect(await git(["status", "--porcelain"], clone)).toBe("");
        expect((await setupProject(clone, { host })).changedFiles).toEqual([]);
      } finally {
        await fs.rm(clone, { recursive: true, force: true });
      }
    },
  );

  it("refuses missing or stale shared configuration without modifying it or activating", async () => {
    const original = await fs.readFile(path.join(root, "AGENTS.md"));
    await expect(setupProject(root, { host: "codex" })).rejects.toThrow("mason init");
    expect(await fs.readFile(path.join(root, "AGENTS.md"))).toEqual(original);
    expect(await loadSetup(root)).toBeNull();
    await configureProject(root, { host: "codex" });
    await write("AGENTS.md", "Changed project instructions\n");
    const before = await git(["diff"], root);
    const local = await fs.readFile(path.join(root, ".mason/local/setup.json"));
    await expect(setupProject(root, { host: "codex" })).rejects.toThrow("incompatible");
    expect(await git(["diff"], root)).toBe(before);
    expect(await fs.readFile(path.join(root, ".mason/local/setup.json"))).toEqual(local);
  });

  it("refuses to write activation state when local files are tracked", async () => {
    await configureProject(root, { host: "codex" });
    await git(["add", "-f", ".mason/local/setup.json"], root);
    const before = await fs.readFile(path.join(root, ".mason/local/setup.json"));
    await expect(setupProject(root, { host: "codex" })).rejects.toThrow("must be untracked");
    expect(await fs.readFile(path.join(root, ".mason/local/setup.json"))).toEqual(before);
  });

  it("completes setup and retries when optional stats configuration is corrupt", async () => {
    await write(".mason/local/usefulness/config.json", "broken-json");
    for (const host of ["codex", "claude"] as const) {
      const result = await configureProject(root, { host });
      expect(result.status).toBe("configured");
      expect(result).not.toHaveProperty("stats");
      expect(summarizeSetup(result)).not.toContain("stats");
      expect(result.activation.status).not.toBe("attention");
      expect(
        await fs.readFile(path.join(root, ".mason/local/usefulness/config.json"), "utf8"),
      ).toBe("broken-json");
    }
  });

  it("leaves stats disabled by default and preserves explicit preferences across hosts", async () => {
    expect((await usefulnessStatus(root)).enabled).toBe(false);
    await configureProject(root, { host: "codex" });
    expect((await usefulnessStatus(root)).enabled).toBe(false);
    await configureUsefulness(root, true);
    await configureProject(root, { host: "claude" });
    expect((await usefulnessStatus(root)).enabled).toBe(true);
    await configureUsefulness(root, false);
    await configureProject(root, { host: "codex" });
    expect((await usefulnessStatus(root)).enabled).toBe(false);
  });

  it("configures both hosts without running audits, reviewing diffs or creating repair state", async () => {
    const audit = vi
      .spyOn(automation, "automate")
      .mockRejectedValue(new Error("audit unavailable"));
    const inspect = vi
      .spyOn(onboarding, "inspectOnboarding")
      .mockRejectedValue(new Error("review unavailable"));
    for (const host of ["codex", "claude"] as const) {
      const result = await configureProject(root, { host });
      expect(result.status).toBe("configured");
      expect(result).not.toHaveProperty("findings");
      expect(result).not.toHaveProperty("reportPath");
      const receipt = JSON.parse(await fs.readFile(path.join(root, result.receiptPath), "utf8"));
      expect(receipt).not.toHaveProperty("initialReportPath");
    }
    expect(audit).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, ".mason/reports/repairs"))).rejects.toThrow();
  });

  it("preserves legacy receipt pointers and damaged audit artifacts across repeated setup", async () => {
    const first = await configureProject(root, { host: "codex" });
    const receipt = JSON.parse(await fs.readFile(path.join(root, first.receiptPath), "utf8"));
    await write(".mason/reports/old-check.json", "damaged audit artifact");
    receipt.initialReportPath = ".mason/reports/old-check.json";
    receipt.initialBaselinePaths = [".mason/reports/missing-baseline.json"];
    await write(first.receiptPath, JSON.stringify(receipt));
    await configureProject(root, { host: "codex" });
    expect(JSON.parse(await fs.readFile(path.join(root, first.receiptPath), "utf8"))).toMatchObject(
      {
        initialReportPath: receipt.initialReportPath,
        initialBaselinePaths: receipt.initialBaselinePaths,
      },
    );
    expect(await fs.readFile(path.join(root, receipt.initialReportPath), "utf8")).toBe(
      "damaged audit artifact",
    );
  });

  it("sets up with over 100,000 ignored generated paths and retains evidence for a later source change", async () => {
    await write(".gitignore", "artifacts/\n.mason/reports/\n");
    await commitAll(root, "ignore generated artifacts");
    const initial = await automate(root, { event: "session_start" });
    const baseline = initial.report.baselinePaths[0];
    const original = await fs.readFile(path.join(root, baseline));
    const artifacts = path.join(root, "artifacts");
    await fs.mkdir(artifacts);
    // Real files exercise Git pruning during setup and subsequent explicit checks.
    const count = 100001;
    await Promise.all(
      Array.from({ length: 64 }, async (_, worker) => {
        for (let index = worker; index < count; index += 64) {
          await fs.writeFile(path.join(artifacts, `generated-${index}.ts`), "");
        }
      }),
    );
    expect((await fs.readdir(artifacts)).length).toBe(count);
    const result = await configureProject(root, { host: "codex" });
    expect(result.status).toBe("configured");
    expect(result).not.toHaveProperty("findings");
    const configured = await automate(root, { event: "task_end" });
    expect(configured.report.baselinePaths).toContain(baseline);
    await write("new-feature/main.kt", "fun feature() = true\n");
    const changed = await automate(root, { event: "task_end" });
    expect(
      changed.report.findings.some(
        (f) => f.original.type === "new-module" && f.status === "review-required",
      ),
    ).toBe(true);
    await fs.appendFile(
      path.join(root, "AGENTS.md"),
      "\nThe new-feature directory contains the added capability.\n",
    );
    await commitAll(root, "document the new feature and commit setup metadata");
    const verified = await automate(root, { event: "task_end" });
    expect(verified.report.status).toBe("verified");
    expect(verified.report.baselinePaths).toEqual(changed.report.baselinePaths);
    expect(await fs.readFile(path.join(root, baseline))).toEqual(original);
  }, 120000);

  it.each(["codex", "claude"] as const)(
    "sets up %s in a non-npm repo without auditing or changing existing guidance",
    async (host) => {
      const original = "The `src/missing.kt` entry point.\n";
      await write("AGENTS.md", original);
      await commitAll(root, "outdated instructions");
      const result = await configureProject(root, { host });
      expect(result.status).toBe("configured");
      expect(result.activation.status).toBe("pending");
      if (host === "claude")
        expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toContain("\n@AGENTS.md\n");
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toContain(original);
      await expect(fs.access(path.join(root, "package.json"))).rejects.toThrow();
      await expect(fs.access(path.join(root, ".mason/decisions"))).rejects.toThrow();
      expect(result).not.toHaveProperty("initialReportPath");
      await expect(fs.access(path.join(root, ".mason/reports/repairs"))).rejects.toThrow();
      expect(await git(["status", "--porcelain"], root)).not.toContain("runtime/");
      expect(await git(["check-ignore", ".mason/reports/example.json"], root)).toBe(
        ".mason/reports/example.json",
      );
      expect(result.runtime).toMatchObject({ kind: "global", command: "mason" });
      for (const file of [
        "runtime",
        "run.cjs",
        "run.sh",
        "run.ps1",
        "setup.json",
        "automation.json",
        "project.json",
      ]) {
        await expect(fs.access(path.join(root, ".mason", file))).rejects.toThrow();
      }
      expect(
        await git(
          ["check-ignore", ".mason/local/setup.json", ".mason/local/automation.json"],
          root,
        ),
      ).toBe(".mason/local/setup.json\n.mason/local/automation.json");
      await commitAll(root, "configure Mason");
      expect((await git(["ls-files", ".mason"], root)).trim()).toBe("");
      expect(JSON.parse(await masonInit(root)).initialized).toBe(true);
    },
  );

  it("repeats setup without duplicate instructions, hooks, baseline replacement, or activation reset", async () => {
    await write("CLAUDE.md", "Keep these project conventions exactly.\r\n");
    const first = await configureProject(root, { host: "codex" });
    const config = JSON.stringify(await loadSetup(root));
    const before = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    const second = await configureProject(root, { host: "codex" });
    expect(second.changedFiles).toEqual([]);
    expect(JSON.stringify(await loadSetup(root))).toBe(config);
    expect(second.receiptPath).toBe(first.receiptPath);
    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(before);
    expect(before.startsWith("Keep these project conventions exactly.\r\n")).toBe(true);
    const hooks = JSON.parse(await fs.readFile(path.join(root, ".codex/hooks.json"), "utf8"));
    expect(hooks.hooks.Stop).toHaveLength(1);
  });

  it("creates Codex-readable AGENTS.md while keeping existing Claude project conventions", async () => {
    await fs.rm(path.join(root, "AGENTS.md"));
    await write(".claude/CLAUDE.md", "Existing conventions: use the src directory.\n");
    const first = await configureProject(root, { host: "codex" });
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toContain(".claude/CLAUDE.md");
    expect(await fs.readFile(path.join(root, ".claude/CLAUDE.md"), "utf8")).toContain(
      "Existing conventions: use the src directory.\n",
    );
    expect(await fs.readFile(path.join(root, ".claude/CLAUDE.md"), "utf8")).toContain(
      "\n@../AGENTS.md\n",
    );
    expect((await configureProject(root, { host: "codex" })).changedFiles).toEqual([]);
    expect(first.activation.hosts.codex.instructions).toBe("current");
  });

  it("adds guidance without creating a baseline when no instruction files exist", async () => {
    await fs.rm(path.join(root, "AGENTS.md"));
    await commitAll(root, "remove instructions");
    const result = await configureProject(root, { host: "codex" });
    expect(result).not.toHaveProperty("findings");
    await expect(fs.access(path.join(root, ".mason/reports/repairs"))).rejects.toThrow();
    const after = await automate(root, { event: "task_end" });
    expect(after.report.baselinePaths.length).toBeGreaterThan(0);
    expect((await setupStatus(root)).hosts.codex.observedEvents).toEqual([]);
  });

  it("preserves unrelated TOML bytes, JSON settings, and existing hooks", async () => {
    const toml = '# comment\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n';
    await write(".codex/config.toml", toml);
    const originalHook = {
      hooks: [{ type: "command", command: "existing-tool" }],
      matcher: "Edit",
    };
    await write(
      ".codex/hooks.json",
      JSON.stringify({ setting: 7, hooks: { PreToolUse: [originalHook] } }),
    );
    await configureProject(root, { host: "codex" });
    const config = await fs.readFile(path.join(root, ".codex/config.toml"), "utf8");
    expect(config.startsWith(toml)).toBe(true);
    expect(parse(config).mcp_servers.other.command).toBe("other");
    const hooks = JSON.parse(await fs.readFile(path.join(root, ".codex/hooks.json"), "utf8"));
    expect(hooks.setting).toBe(7);
    expect(hooks.hooks.PreToolUse[0]).toEqual(originalHook);
  });

  it("migrates an existing explicit Mason MCP table while preserving other settings", async () => {
    await write(
      ".codex/config.toml",
      '# before\nmodel = "test"\n[mcp_servers.mason]\ncommand = "old"\nargs = []\nenabled = false\ntool_timeout_sec = 80\n[mcp_servers.mason.env]\nPROJECT_OPTION = "keep"\n[mcp_servers.other]\ncommand = "keep"\n',
    );
    const edit = await mcpEdit(root, "codex");
    const parsed = parse(edit.after);
    expect(parsed.model).toBe("test");
    expect(parsed.mcp_servers.other.command).toBe("keep");
    expect(parsed.mcp_servers.mason.command).toBe(
      process.platform === "win32" ? "cmd.exe" : "mason",
    );
    expect(parsed.mcp_servers.mason.enabled).toBe(false);
    expect(parsed.mcp_servers.mason.tool_timeout_sec).toBe(80);
    expect(parsed.mcp_servers.mason.env).toEqual({ PROJECT_OPTION: "keep" });
    expect(edit.after).toContain('[mcp_servers.other]\ncommand = "keep"\n');
    const result = await configureProject(root, { host: "codex" });
    expect(result.activation.hosts.codex.status).toBe("attention");
    expect((await configureProject(root, { host: "codex" })).changedFiles).toEqual([]);
  });

  it("preserves Claude server options and replaces only its transport details", async () => {
    await write(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          mason: { type: "http", url: "https://example.invalid", env: { OPTION: "keep" } },
          other: { command: "other" },
        },
      }),
    );
    const result = await configureProject(root, { host: "claude" });
    const config = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(config.mcpServers.mason.env).toEqual({ OPTION: "keep" });
    expect(config.mcpServers.mason.url).toBeUndefined();
    expect(config.mcpServers.mason.type).toBe("stdio");
    expect(config.mcpServers.other).toEqual({ command: "other" });
    expect(result.activation.hosts.claude.mcp).toBe("configured");
  });

  it("replaces obsolete secondary Mason guidance without changing surrounding conventions", async () => {
    await write(
      "CLAUDE.md",
      "Before\r\n<!-- mason:start -->\r\nObsolete commands\r\n<!-- mason:end -->\r\nAfter\r\n",
    );
    await configureProject(root, { host: "claude" });
    const text = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(text).toContain("\n@AGENTS.md\r\n");
    expect(text).not.toContain("Obsolete commands");
    expect(text.startsWith("Before\r\n")).toBe(true);
    expect(text.endsWith("\r\nAfter\r\n")).toBe(true);
    expect((await configureProject(root, { host: "claude" })).changedFiles).toEqual([]);
  });

  it("adds a native Claude import beside a prose mention and preserves an existing import-only file", async () => {
    const original = "Project information is also in AGENTS.md.\n";
    await write("CLAUDE.md", original);
    await configureProject(root, { host: "claude" });
    const text = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("\n@AGENTS.md\n");
    await write("CLAUDE.md", "@AGENTS.md\r\n");
    await configureProject(root, { host: "claude" });
    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\r\n");
  });

  it.each([
    [".codex/config.toml", "[broken"],
    [".codex/hooks.json", "{broken"],
    ["AGENTS.md", "original\n<!-- mason:start -->unfinished"],
  ])("rejects malformed %s before shared file edits", async (file, value) => {
    await write(file, value);
    const docs = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    await expect(configureProject(root, { host: "codex" })).rejects.toThrow();
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe(value);
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(docs);
  });

  it("resumes an interrupted configuration write without audit state", async () => {
    const apply = setupFiles.applyEdit;
    vi.spyOn(setupFiles, "applyEdit").mockImplementation(async (dir, edit) => {
      if (edit.path === ".codex/config.toml") throw new Error("disk full");
      return apply(dir, edit);
    });
    await expect(configureProject(root, { host: "codex" })).rejects.toThrow("disk full");
    expect((await setupStatus(root)).status).toBe("not-configured");
    vi.mocked(setupFiles.applyEdit).mockImplementation(apply);
    const done = await configureProject(root, { host: "codex" });
    expect(done).not.toHaveProperty("initialReportPath");
    await expect(fs.access(path.join(root, ".mason/reports/repairs"))).rejects.toThrow();
    expect(done.activation.status).toBe("pending");
  });

  it("refuses concurrent file edits and symlinked setup files", async () => {
    const edit = {
      path: "AGENTS.md",
      before: await fs.readFile(path.join(root, "AGENTS.md"), "utf8"),
      after: "replacement",
    };
    await write("AGENTS.md", "new concurrent content");
    await expect(applyEdit(root, edit)).rejects.toThrow("changed during");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("new concurrent content");
    await fs.mkdir(path.join(root, ".codex"));
    await fs.symlink(path.join(root, "AGENTS.md"), path.join(root, ".codex/config.toml"));
    await expect(configureProject(root, { host: "codex" })).rejects.toThrow("Symlink");
  });

  it("keeps reports private and decisions shareable under an existing blanket Mason ignore", async () => {
    await write(".gitignore", "# existing\r\n.mason/\r\n");
    await configureProject(root, { host: "codex" });
    expect(await git(["check-ignore", ".mason/reports/test.json"], root)).toBe(
      ".mason/reports/test.json",
    );
    const visible = await git(["check-ignore", "--verbose", ".mason/decisions/test.json"], root);
    expect(visible).toContain("!/.mason/decisions/**");
    expect(await git(["check-ignore", "--verbose", ".mason/config.json"], root)).toContain(
      "!/.mason/config.json",
    );
    expect(await git(["check-ignore", "--verbose", ".mason/snapshot.json"], root)).toContain(
      "!/.mason/snapshot.json",
    );
    expect((await configureProject(root, { host: "codex" })).changedFiles).toEqual([]);
  });

  it("uses the same setup engine through MCP mode and CLI, keeping inspection read-only", async () => {
    await expect(masonInit(root, { mode: "setup", host: "codex", base: "main" })).rejects.toThrow(
      "quickstart",
    );
    await expect(masonInit(root, { mode: "setup", host: "codex", evidence: [] })).rejects.toThrow(
      "quickstart",
    );
    expect(JSON.parse(await masonInit(root)).mode).toBe("quickstart");
    await expect(fs.access(path.join(root, ".mason"))).rejects.toThrow();
    await masonInit(root, { mode: "init", host: "codex" });
    const setup = JSON.parse(await masonInit(root, { mode: "setup", host: "codex" }));
    expect(setup.status).toBe("configured");
    const lines: string[] = [];
    expect(
      await runAutomationCli(["setup", "--dir", root, "--host", "codex", "--json"], "", {
        out: (s) => lines.push(s),
        err: (s) => lines.push(s),
      }),
    ).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).changedFiles).toEqual([]);
  });

  it("shows setup progress before configuration edits and keeps the final result on stdout", async () => {
    const out: string[] = [],
      err: string[] = [];
    await initializeProject(root, { host: "claude" });
    const apply = setupFiles.applyEdit;
    vi.spyOn(setupFiles, "applyEdit").mockImplementation(async (dir, edit) => {
      expect(err.join("\n")).not.toContain("Auditing");
      expect(err.join("\n")).toContain("Activating Claude Code integration");
      expect(out).toEqual([]);
      return apply(dir, edit);
    });
    expect(
      await runAutomationCli(["setup", "--dir", root, "--host", "claude"], "", {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Mason configured for claude.");
    expect(out[0]).toContain("Activation: pending");
    expect(err.join("\n")).toContain("Checking agent configuration");
    expect(err.join("\n")).not.toContain("\u001b");
  });

  it("requires a host when detection is ambiguous and preserves explicit disabled settings", async () => {
    await expect(setupProject(root)).rejects.toThrow("--host");
    await write(".codex/config.toml", "[features]\nhooks = false\n");
    const result = await configureProject(root, {});
    expect(result.host).toBe("codex");
    expect(result.activation.hosts.codex.status).toBe("attention");
    expect(
      parse(await fs.readFile(path.join(root, ".codex/config.toml"), "utf8")).features.hooks,
    ).toBe(false);
  });

  it("requires actual MCP and hook observations and isolates sessions and installation revisions", async () => {
    await configureProject(root, { host: "codex" });
    await activateEnvironment("codex");
    await commitAll(root, "configure Mason");
    await getContext(root, "Read source", ["src/main.kt"]);
    expect((await setupStatus(root)).hosts.codex.contextCalls).toBe(0);
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"])
      await hook(event, "one");
    for (const event of ["PostToolUse", "Stop"]) await hook(event, "two");
    expect((await setupStatus(root)).hosts.codex.status).toBe("pending");
    for (const event of ["PostToolUse", "Stop"]) await hook(event, "one");
    expect((await setupStatus(root)).hosts.codex.status).toBe("pending");
    vi.stubGlobal("PKG_VERSION", "test");
    const server = createMcpServer();
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      await client.callTool({
        name: "get_context",
        arguments: { dir: root, task: "Explain the project", files: ["src/main.kt"] },
      });
    } finally {
      await client.close();
      await server.close();
    }
    expect((await setupStatus(root)).hosts.codex.status).toBe("active");
    const ws = await workspace(root);
    const observed = await fs.readFile(
      path.join(
        root,
        observationPath(ws.directory, "codex", (await loadSetup(root))!.hosts.codex!.revision),
      ),
      "utf8",
    );
    expect(observed).not.toContain("Explain the project");
    expect(observed).not.toContain("src/main.kt");
    await write(".codex/hooks.json", "{}");
    expect((await setupStatus(root)).hosts.codex.status).toBe("attention");
    await configureProject(root, { host: "codex" });
    // Restoring identical shared configuration preserves the existing local activation revision.
    expect((await setupStatus(root)).hosts.codex.status).toBe("active");
    expect(await observeActivation(root, "context")).toBeNull();
    await git(["switch", "-c", "other"], root);
    expect((await setupStatus(root)).hosts.codex.status).not.toBe("active");
  }, 60000);

  it("detects a missing global command without treating earlier activation as healthy", async () => {
    await configureProject(root, { host: "codex" });
    vi.mocked(launcher.installedCommand).mockResolvedValue({
      available: false,
      version: null,
      message: "Restart the assistant to pick up PATH.",
    });
    expect((await setupStatus(root)).hosts.codex).toMatchObject({
      status: "attention",
      runtime: "unavailable-on-path",
    });
    const before = await git(["diff"], root);
    await expect(configureProject(root, { host: "codex" })).rejects.toThrow("PATH");
    expect(await git(["diff"], root)).toBe(before);
  });

  it("keeps version-specific activation evidence after a global upgrade without changing project configuration", async () => {
    await configureProject(root, { host: "codex" });
    await activateEnvironment("codex");
    await commitAll(root, "configure Mason");
    await observeActivation(root, "context");
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"])
      await hook(event);
    expect((await setupStatus(root)).hosts.codex.status).toBe("active");
    const ws = await workspace(root),
      setup = (await loadSetup(root))!;
    const oldPath = path.join(
      root,
      observationPath(ws.directory, "codex", setup.hosts.codex!.revision),
    );
    const before = await fs.readFile(oldPath);
    vi.stubGlobal("PKG_VERSION", "next");
    vi.mocked(launcher.installedCommand).mockResolvedValue({
      available: true,
      version: "next",
      message: null,
    });
    expect((await setupStatus(root)).hosts.codex).toMatchObject({
      status: "pending",
      contextCalls: 0,
      observedEvents: [],
    });
    await observeActivation(root, "context");
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"])
      await hook(event);
    expect((await setupStatus(root)).hosts.codex.status).toBe("active");
    expect(await fs.readFile(oldPath)).toEqual(before);
    expect(await loadSetup(root)).toEqual(setup);
    expect(await git(["status", "--porcelain"], root)).toBe("");
  });

  it("does not read hook stdin for a directory called hook or a help request", () => {
    expect(isHookCommand(["--dir", "hook", "status"])).toBe(false);
    expect(isHookCommand(["hook", "--help"])).toBe(false);
    expect(isHookCommand(["hook", "--host", "codex"])).toBe(true);
  });

  it("keeps the marked block idempotent without changing surrounding CRLF bytes", () => {
    const before = "before\r\n<!-- mason:start -->\r\nold\r\n<!-- mason:end -->\r\nafter\r\n";
    const after = managedBlock(before, "<!-- mason:start -->", "<!-- mason:end -->", "new\nbody");
    expect(after).toBe(
      "before\r\n<!-- mason:start -->\r\nnew\r\nbody\r\n<!-- mason:end -->\r\nafter\r\n",
    );
    expect(managedBlock(after, "<!-- mason:start -->", "<!-- mason:end -->", "new\nbody")).toBe(
      after,
    );
  });
});
