import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initializeProject, setupProject } from "../src/setup/setup.js";
import { setupStatus } from "../src/setup/status.js";
import { teardownProject } from "../src/setup/teardown.js";
import { loadSetup } from "../src/setup/model.js";
import * as launcher from "../src/setup/launcher.js";
import { managedHookCommand } from "../src/automation/adapters.js";
import { runAutomationCli } from "../src/automation/cli.js";
import { createMcpServer } from "../src/mcp/server.js";
import { commitAll, git, initGitRepo } from "./helpers.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-cli-contract-")));
  await initGitRepo(root);
  await fs.writeFile(path.join(root, "AGENTS.md"), "Project conventions.\n");
  await commitAll(root, "initial");
  vi.stubGlobal("PKG_VERSION", "test");
  vi.spyOn(launcher, "installedCommand").mockResolvedValue({
    available: true,
    version: "test",
    message: null,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("previews initialization without creating files, then initializes without activating", async () => {
  const before = await fs.readFile(path.join(root, "AGENTS.md"));
  const preview = await initializeProject(root, { host: "claude", dryRun: true });
  expect(preview.changes.some((item) => item.path === ".mcp.json")).toBe(true);
  expect(await fs.readFile(path.join(root, "AGENTS.md"))).toEqual(before);
  await expect(fs.access(path.join(root, ".mason"))).rejects.toThrow();
  const initialized = await initializeProject(root, { host: "claude" });
  expect(initialized.changes).toEqual(preview.changes);
  expect(await loadSetup(root)).toBeNull();
  expect((await setupStatus(root)).status).toBe("not-configured");
  expect((await initializeProject(root, { host: "claude" })).changes).toEqual([]);
});

it("activates compatible older instructions, JSON formatting and legacy hooks without an MR", async () => {
  await initializeProject(root, { host: "claude" });
  const instructions = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    instructions.replace("## Mason project knowledge", "## Older Mason project guidance"),
  );
  const mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
  delete mcp.mcpServers.mason.type;
  await fs.writeFile(path.join(root, ".mcp.json"), JSON.stringify(mcp, null, 4));
  const settings = JSON.parse(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8"));
  for (const groups of Object.values(settings.hooks) as Array<
    Array<{ hooks: Array<{ command: string }> }>
  >)
    for (const group of groups)
      for (const hook of group.hooks)
        hook.command = managedHookCommand("claude", process.platform, true);
  await fs.writeFile(path.join(root, ".claude/settings.json"), JSON.stringify(settings, null, 4));
  await commitAll(root, "older compatible integration");
  const configured = await setupProject(root, { host: "claude" });
  expect(configured.activation.status).toBe("pending");
  expect(configured.activation.hosts.claude.instructions).toBe("compatible");
  expect(configured.activation.hosts.claude.hookConfiguration).toBe("compatible");
  expect(configured.activation.hosts.claude.updates.join(" ")).toContain("mason init");
  expect(await git(["status", "--porcelain"], root)).toBe("");
});

it("keeps local teardown, preview and reactivation free of shared edits", async () => {
  await initializeProject(root, { host: "claude" });
  await setupProject(root, { host: "claude" });
  await commitAll(root, "team configuration");
  const before = await loadSetup(root);
  const preview = await teardownProject(root, { host: "claude", dryRun: true });
  expect(await loadSetup(root)).toEqual(before);
  expect(preview.changes.every((change) => change.path.startsWith(".mason/"))).toBe(true);
  const removed = await teardownProject(root, { host: "claude" });
  expect(removed.scope).toBe("local");
  expect(removed.changes).toEqual(preview.changes);
  expect((await setupStatus(root)).status).toBe("not-configured");
  expect(await git(["status", "--porcelain"], root)).toBe("");
  expect((await setupProject(root, { host: "claude" })).activation.status).toBe("pending");
  expect(await git(["status", "--porcelain"], root)).toBe("");
});

it("requires explicit project removal and previews its shared edits", async () => {
  await initializeProject(root, { host: "codex" });
  await commitAll(root, "shared setup");
  const preview = await teardownProject(root, { project: true, dryRun: true });
  expect(preview.changes.some((change) => change.path === ".codex/config.toml")).toBe(true);
  expect(await git(["status", "--porcelain"], root)).toBe("");
  expect((await teardownProject(root, { project: true })).changes).toEqual(preview.changes);
});

it("rejects the unshipped prepare flag and limits previews to init and teardown", async () => {
  for (const args of [
    ["setup", "--prepare"],
    ["setup", "--dry-run"],
    ["init", "--project"],
  ]) {
    const out: string[] = [];
    expect(
      await runAutomationCli([...args, "--dir", root, "--json"], "", {
        out: (s) => out.push(s),
        err: () => {},
      }),
    ).toBe(2);
    expect(JSON.parse(out[0]).failure).toBeDefined();
    expect(await loadSetup(root)).toBeNull();
  }
});

it("passes MCP initialization previews through without writes", async () => {
  const server = createMcpServer();
  const client = new Client({ name: "preview", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({
      name: "mason_init",
      arguments: { dir: root, mode: "init", host: "claude", dryRun: true },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("preview");
    await expect(fs.access(path.join(root, ".mason"))).rejects.toThrow();
    expect(await git(["status", "--porcelain"], root)).toBe("");
  } finally {
    await client.close();
    await server.close();
  }
});
