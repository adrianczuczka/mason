import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { runAutomationHook } from "../src/automation/adapters.js";
import { automationStatus } from "../src/automation/runtime.js";
import { workspace } from "../src/automation/evidence.js";
import { setupProject } from "../src/setup/setup.js";
import { setupStatus } from "../src/setup/status.js";
import { effectiveSetup, loadSetup } from "../src/setup/model.js";
import { readObservation } from "../src/setup/observations.js";
import { teardownProject } from "../src/setup/teardown.js";
import * as launcher from "../src/setup/launcher.js";
import { commitAll, git, initGitRepo } from "./helpers.js";

let temp: string, root: string, linked: string;
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-worktree-activation-")));
  root = path.join(temp, "main"); linked = path.join(temp, "linked");
  await fs.mkdir(root); await initGitRepo(root);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/main.ts"), "export {};\n");
  await fs.writeFile(path.join(root, "AGENTS.md"), "Entry: `src/main.ts`.\n");
  await commitAll(root, "initial");
  vi.stubGlobal("PKG_VERSION", "test");
  vi.spyOn(launcher, "installedCommand").mockResolvedValue({ available: true, version: "test", message: null });
  // prepareLaunch supplies these per invocation; restore the test process afterwards.
  for (const key of ["MASON_SETUP_ROOT", "MASON_SETUP_HOST", "MASON_SETUP_REVISION"]) vi.stubEnv(key, undefined);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(temp, { recursive: true, force: true }); });

it.each(["claude", "codex"] as const)("checks %s mutations in a linked worktree without local setup", async host => {
  const setup = await setupProject(root, { host });
  await commitAll(root, "configure");
  await git(["worktree", "add", "-b", "linked", linked], root);
  const mainReport = await fs.readFile(path.join(root, setup.initialReportPath));
  const invoke = (name: string, extra = {}) => runAutomationHook(host, JSON.stringify({
    cwd: path.join(linked, "src"), session_id: "worktree-task", hook_event_name: name, ...extra,
  }), { managed: true });
  await invoke("SessionStart"); await invoke("UserPromptSubmit");
  const tool = { tool_name: "Bash", tool_use_id: "rename" };
  await invoke("PreToolUse", tool);
  await fs.rename(path.join(linked, "src/main.ts"), path.join(linked, "src/renamed.ts"));
  await commitAll(linked, "rename entry");
  expect(JSON.stringify(await invoke("PostToolUse", tool))).toContain("src/main.ts");
  const stop = await invoke("Stop");
  expect(stop?.decision).toBe("block");
  const status = await automationStatus(linked);
  const report = JSON.parse(await fs.readFile(path.join(linked, status.reportPath!), "utf8"));
  expect(report.root).toBe(linked);
  expect(report.capture).toBe("observed");
  expect(report.diagnostics).toEqual([]);
  expect(report.counts.unresolved).toBe(1);
  expect(await loadSetup(linked)).toBeNull();
  expect(await fs.readFile(path.join(root, setup.initialReportPath))).toEqual(mainReport);
  for (const baseline of status.baselinePaths) {
    expect(JSON.parse(await fs.readFile(path.join(linked, baseline), "utf8")).report.root).toBe(linked);
    await expect(fs.access(path.join(root, baseline))).rejects.toMatchObject({ code: "ENOENT" });
  }
  const ws = await workspace(linked), revision = (await loadSetup(root))!.hosts[host]!.revision;
  expect(Object.values((await readObservation(linked, ws.directory, host, revision))!.sessions)[0].events)
    .toEqual(["session_start", "turn_start", "before_tool", "after_tool", "task_end"]);
  const configured = await setupStatus(linked);
  expect(configured).toMatchObject({ activationRoot: root });
  expect(configured.hosts[host].observedEvents).toHaveLength(5);
  expect(configured.hosts[host].pending.join(" ")).not.toContain("reconcile");
}, 30000);

it("honors local overrides, inherited host scope, corrupt receipts, and teardown", async () => {
  await setupProject(root, { host: "claude" }); await commitAll(root, "configure");
  await git(["worktree", "add", "-b", "linked", linked], root);
  expect(await launcher.prepareLaunch("codex", { dir: linked, allowInactive: true })).toBe(false);
  expect(await launcher.prepareLaunch("claude", { dir: linked, allowInactive: true })).toBe(true);
  const parent = await fs.readFile(path.join(root, ".mason/local/setup.json"), "utf8");
  await fs.writeFile(path.join(root, ".mason/local/setup.json"), "{");
  await expect(launcher.prepareLaunch("claude", { dir: linked, allowInactive: true })).rejects.toThrow();
  await fs.writeFile(path.join(root, ".mason/local/setup.json"), parent);
  await fs.mkdir(path.join(linked, ".mason/local"), { recursive: true });
  await fs.writeFile(path.join(linked, ".mason/local/setup.json"), "{");
  await expect(effectiveSetup(linked)).rejects.toThrow();
  await fs.rm(path.join(linked, ".mason/local/setup.json"));
  expect((await teardownProject(linked, { host: "claude", dryRun: true })).status).toBe("complete");
  expect(await launcher.prepareLaunch("claude", { dir: linked, allowInactive: true })).toBe(true);
  expect((await teardownProject(linked, { host: "claude" })).status).toBe("complete");
  expect(await launcher.prepareLaunch("claude", { dir: linked, allowInactive: true })).toBe(false);
  expect((await setupStatus(linked)).status).toBe("not-configured");
  expect(await fs.readFile(path.join(root, ".mason/local/setup.json"), "utf8")).toBe(parent);
  expect((await teardownProject(linked, { host: "claude" })).changes).toEqual([]);
  await setupProject(linked, { host: "claude" });
  expect((await effectiveSetup(linked)).root).toBe(linked);
  expect(await launcher.prepareLaunch("claude", { dir: linked })).toBe(true);
}, 30000);

it("requires a recorded checkout location when Git metadata was stored separately", async () => {
  await setupProject(root, { host: "claude" }); await commitAll(root, "configure");
  await git(["init", "--separate-git-dir", path.join(temp, "git-metadata")], root);
  await git(["worktree", "add", "-b", "linked", linked], root);
  expect((await effectiveSetup(linked)).setup).toBeNull();
  await git(["config", "core.worktree", root], root);
  expect((await effectiveSetup(linked)).root).toBe(root);
  expect(await launcher.prepareLaunch("claude", { dir: linked })).toBe(true);
});

it("disconnects one inherited host while the other keeps following primary setup", async () => {
  await setupProject(root, { host: "claude" });
  await setupProject(root, { host: "codex" });
  await commitAll(root, "configure both hosts");
  await git(["worktree", "add", "-b", "linked", linked], root);
  expect((await teardownProject(linked, { host: "claude" })).status).toBe("complete");
  expect(await launcher.prepareLaunch("claude", { dir: linked, allowInactive: true })).toBe(false);
  expect(await launcher.prepareLaunch("codex", { dir: linked })).toBe(true);
  const status = await setupStatus(linked);
  expect(status.activationRoot).toBe(root);
  expect(status.hosts.codex.pending.join(" ")).not.toContain("reconcile");
  expect(status.hosts.claude).toBeUndefined();
  await teardownProject(root, { host: "codex" });
  expect(await launcher.prepareLaunch("codex", { dir: linked, allowInactive: true })).toBe(false);
}, 30000);
