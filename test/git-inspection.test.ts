import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { automate, automationStatus } from "../src/automation/runtime.js";
import { workspace } from "../src/automation/evidence.js";
import { withRepositoryInspection } from "../src/audit/inspection.js";
import { lastCommitOf } from "../src/audit/git.js";
import { discoverDocPaths } from "../src/audit/docs.js";
import { gitSourcePaths } from "../src/audit/inputs.js";
import { withProfile } from "../src/utils/profile.js";
import * as gitReads from "../src/utils/git-read.js";
import * as drift from "../src/drift/drift.js";
import { initGitRepo, commitAll } from "./helpers.js";

let root: string;
const write = async (file: string, contents: string) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), contents);
};
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-git-inspection-")));
  await initGitRepo(root);
  await write(".gitignore", ".mason/reports/\nhidden/\n");
  await write("package.json", '{"scripts":{"test":"node --test"}}');
  await write("src/main.ts", "export const main = true;\n");
  await write("AGENTS.md", "The src directory. Entry: `src/main.ts`. Run `npm run test`.\n");
  await commitAll(root, "initial");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it.each([false, true])("keeps warm inventory and ignore queries bounded as modules grow (partial: %s)", async partial => {
  if (partial) await write("AGENTS.md", 'The src directory. `src/main.ts`. Run `cd "$PROJECT_DIR" && npm run test`.\n');
  for (let i = 0; i < 12; i++) {
    await write(`module-${i}/src/main.ts`, "export const value = true;");
    await write(`module-${i}/README.md`, "Source: `src/main.ts`.\n");
    await write(`module-${i}/.gitignore`, "generated/\n");
  }
  await commitAll(root, "add modules");
  await automate(root, { event: "session_start" });
  let timing: { phases: Record<string, { calls: number }> };
  const current = await withProfile(() => automate(root, { event: "task_end" }), text => { timing = JSON.parse(text); });
  expect(current.report.status).toBe(partial ? "incomplete" : "verified");
  expect(current.report.checks.auditReused === true).toBe(!partial);
  if (partial) expect(current.report.checks.ran).toContain("dead-command");
  // One shared inventory in analysis, a separate fresh one before publication.
  expect(timing!.phases["git.ls-files"].calls).toBe(2);
  // Two directory levels per inspection, independent of module count.
  expect(timing!.phases["git.check-ignore"].calls).toBe(4);
  expect(JSON.stringify(timing!)).not.toContain(root);
  expect(JSON.stringify(timing!)).not.toContain("module-");
});

it.each(["new document", "new module", "deleted source", "ignore edit"])("rejects a %s arriving after the initial inventory", async change => {
  await write("hidden/main.ts", "ignored source");
  const first = await automate(root, { event: "session_start" });
  const baseline = await fs.readFile(path.join(root, first.report.baselinePaths[0]), "utf8");
  const stateFile = path.join(root, (await workspace(root)).directory, "state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const original = drift.getChangesWithStatus;
  let changed = false;
  vi.spyOn(drift, "getChangesWithStatus").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!changed) {
      changed = true;
      if (change === "new document") await write("notes/README.md", "New instructions. Run `npm run missing`.\n");
      if (change === "new module") await write("new-module/main.ts", "export const value = 1;");
      if (change === "deleted source") await fs.rm(path.join(root, "src/main.ts"));
      if (change === "ignore edit") await write(".gitignore", ".mason/reports/\n");
    }
    return result;
  });
  await expect(automate(root, { event: "task_end" })).rejects.toMatchObject({ failure: { code: "inputs-changed", receiptRecorded: true } });
  expect(JSON.parse(await fs.readFile(stateFile, "utf8")).analysis).toEqual(state.analysis);
  expect(await fs.readFile(path.join(root, first.report.baselinePaths[0]), "utf8")).toBe(baseline);
  expect((await automationStatus(root)).verificationStatus).toBe("unavailable");
});

it("never substitutes the initial inventory when the final Git read fails", async () => {
  await automate(root, { event: "session_start" });
  const original = gitReads.execGit;
  let inventories = 0;
  vi.spyOn(gitReads, "execGit").mockImplementation((args, options) => {
    if (args[0] === "ls-files" && args.includes("--cached") && args.includes("--others") && ++inventories === 2) {
      return Promise.reject(new Error("Final inventory unavailable"));
    }
    return original(args, options);
  });
  await expect(automate(root, { event: "task_end" })).rejects.toThrow("Final inventory unavailable");
  expect((await automationStatus(root)).verificationStatus).toBe("unavailable");
  expect((await automate(root, { event: "task_end" })).report.status).toBe("verified");
});

it("shares exact history queries without mixing scopes, phases or failed reads", async () => {
  const query = vi.spyOn(gitReads, "execGit");
  const first = await withRepositoryInspection(root, async () => {
    const results = await Promise.all([lastCommitOf(root, "AGENTS.md"), lastCommitOf(root, "AGENTS.md")]);
    await lastCommitOf(root, "src/main.ts");
    return results[0];
  });
  expect(query.mock.calls.filter(([args]) => args[0] === "log")).toHaveLength(2);
  await write("AGENTS.md", "Updated instructions.\n");
  const head = await commitAll(root, "update instructions");
  expect((await withRepositoryInspection(root, () => lastCommitOf(root, "AGENTS.md")))?.hash).toBe(head);
  expect(first?.hash).not.toBe(head);
  query.mockRejectedValueOnce(new Error("Temporary history failure"));
  await withRepositoryInspection(root, async () => {
    expect(await lastCommitOf(root, "AGENTS.md")).toBeNull();
    expect((await lastCommitOf(root, "AGENTS.md"))?.hash).toBe(head);
  });
});

it("preserves document casing, literal path characters and source selection in a shared inventory", async () => {
  await write("odd[dir]\t ü/rEaDmE.MD", "Documentation.\n");
  await write("odd[dir]\t ü/main.rs", "fn main() {}\n");
  await write("src/.ts", "export const hidden = true;\n");
  await write("hidden/README.md", "Ignored.\n");
  await write("hidden/main.rs", "ignored\n");
  const direct = await Promise.all([discoverDocPaths(root), gitSourcePaths(root)]);
  const shared = await withRepositoryInspection(root, () => Promise.all([discoverDocPaths(root), gitSourcePaths(root)]));
  expect(shared).toEqual(direct);
  expect(shared[0]).toContain("odd[dir]\t ü/rEaDmE.MD");
  expect(shared[1]).toContain("odd[dir]\t ü/main.rs");
  expect(shared[1]).toContain("src/.ts");
  expect(shared.flat().some(file => file.startsWith("hidden/"))).toBe(false);
});

it("keeps overlapping inspections of the same repository independent", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const older = withRepositoryInspection(root, async () => {
    const before = await gitSourcePaths(root);
    entered();
    await paused;
    return { before, after: await gitSourcePaths(root) };
  });
  try {
    await ready;
    await write("new-module/main.ts", "export const newModule = true;");
    const newer = await withRepositoryInspection(root, () => gitSourcePaths(root));
    expect(newer).toContain("new-module/main.ts");
  } finally { release(); }
  const original = await older;
  expect(original.after).toEqual(original.before);
  expect(original.after).not.toContain("new-module/main.ts");
});
