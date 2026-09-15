import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { automate, automationStatus } from "../src/automation/runtime.js";
import { runAutomationCli } from "../src/automation/cli.js";
import { workspace, readInputs } from "../src/automation/evidence.js";
import { discoverDocs } from "../src/audit/docs.js";
import { CHECKS } from "../src/audit/checks/index.js";
import { reviewAdvisory } from "../src/audit/advisory-review.js";
import * as audit from "../src/audit/audit.js";
import * as drift from "../src/drift/drift.js";
import { initGitRepo, commitAll, git } from "./helpers.js";

let root: string;
async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-performance-")));
  await initGitRepo(root);
  await write(".gitignore", ".mason/reports/\nbuild/\n");
  await write("package.json", '{"scripts":{"test":"node --test"}}');
  for (let i = 0; i < 3; i++) await write(`src/file-${i}.ts`, `export const value = ${i};`);
  await write("AGENTS.md", "The src directory. `src/file-0.ts`, `src/file-1.ts`, `src/file-2.ts`. Run `npm run test`.\n");
  await commitAll(root, "initial");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("audits changed inputs once across retained baselines and reuses that audit on sequential calls", async () => {
  const compute = vi.spyOn(audit, "computeAudit");
  await automate(root, { event: "session_start" });
  expect(compute).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) {
    await fs.rm(path.join(root, `src/file-${i}.ts`));
    compute.mockClear();
    await automate(root, { event: "after_tool" });
    expect(compute).toHaveBeenCalledTimes(1);
  }
  const state = await automationStatus(root);
  expect(state.baselinePaths).toHaveLength(4);
  const bytes = await Promise.all(state.baselinePaths.map(p => fs.readFile(path.join(root, p), "utf8")));
  compute.mockClear();
  const event = { host: "claude" as const, sessionId: "sequential", toolId: "shell", mutating: true };
  const pre = await automate(root, { ...event, event: "before_tool" });
  const post = await automate(root, { ...event, event: "after_tool" });
  expect(compute).not.toHaveBeenCalled();
  expect(pre.report.checks).toMatchObject({ ran: [], auditReused: true });
  expect(post.report.counts.unresolved).toBe(3);
  expect(post.report.capture).toBe("observed");
  const ws = await workspace(root);
  const saved = JSON.parse(await fs.readFile(path.join(root, ws.directory, "state.json"), "utf8"));
  expect(Object.values(saved.sessions)).toContainEqual(expect.objectContaining({ pending: {}, coverageGaps: [] }));
  await write("AGENTS.md", "The src directory. Its entry points were removed. Run `npm run test`.\n");
  const dirty = await automate(root, { event: "task_end" });
  expect(dirty.report.checks.auditReused).not.toBe(true);
  await commitAll(root, "remove entries and repair docs");
  const final = await automate(root, { event: "task_end" });
  expect(final.report.counts).toMatchObject({ resolved: 3, unresolved: 0, unverified: 0 });
  expect(await Promise.all(state.baselinePaths.map(p => fs.readFile(path.join(root, p), "utf8")))).toEqual(bytes);
}, 20000);

it("retries skipped checks on unchanged inputs and only caches their recovered result", async () => {
  const original = CHECKS["dead-command"];
  const check = vi.spyOn(CHECKS, "dead-command").mockResolvedValue({ issues: [], advisories: [], skipped: [{ check: "dead-command", reason: "temporarily unavailable" }] });
  expect((await automate(root, { event: "session_start" })).report.status).toBe("incomplete");
  expect((await automate(root, { event: "before_tool" })).report.status).toBe("incomplete");
  expect(check).toHaveBeenCalledTimes(2);
  check.mockImplementation(original);
  const recovered = await automate(root, { event: "before_tool" });
  expect(recovered.report.status).toBe("verified");
  expect(recovered.report.checks.ran).toContain("dead-command");
  expect((await automate(root, { event: "after_tool" })).report.checks.auditReused).toBe(true);
});

it("rechecks original history even when the current audit is cached", async () => {
  await automate(root, { event: "session_start" });
  vi.spyOn(drift, "getChangesWithStatus").mockResolvedValue(null);
  const result = await automate(root, { event: "task_end" });
  expect(result.report.checks.auditReused).toBe(true);
  expect(result.report.status).toBe("incomplete");
  expect(result.report.diagnostics.join(" ")).toContain("original audit commit is unavailable");
});

it.each(["missing", "json", "schema", "null", "digest"])("recovers a %s current-audit cache without replacing original evidence", async damage => {
  await automate(root, { event: "session_start" });
  await fs.rm(path.join(root, "src/file-0.ts"));
  const initial = await automate(root, { event: "after_tool" });
  const originals = await Promise.all(initial.report.baselinePaths.map(p => fs.readFile(path.join(root, p), "utf8")));
  const ws = await workspace(root);
  const state = JSON.parse(await fs.readFile(path.join(root, ws.directory, "state.json"), "utf8"));
  const file = path.join(root, state.analysis.path);
  if (damage === "missing") await fs.rm(file);
  else if (damage === "json") await fs.writeFile(file, "{broken");
  else if (damage === "schema") await fs.writeFile(file, "{}");
  else if (damage === "null") await fs.writeFile(file, "null");
  else {
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    saved.digest = "0".repeat(64);
    await fs.writeFile(file, JSON.stringify(saved));
  }
  const compute = vi.spyOn(audit, "computeAudit");
  const recovered = await automate(root, { event: "before_tool" });
  expect(compute).toHaveBeenCalledTimes(1);
  expect(recovered.report.counts.unresolved).toBe(1);
  expect(recovered.report.baselinePaths).toEqual(initial.report.baselinePaths);
  if (damage !== "missing") expect(recovered.report.diagnostics.join(" ")).toContain("invalid current-audit cache");
  const next = await automate(root, { event: "task_end" });
  expect(next.report.status).toBe("issues-remain");
  expect(next.report.checks.auditReused).toBe(true);
  expect(next.report.diagnostics).toEqual([]);
  expect(await Promise.all(initial.report.baselinePaths.map(p => fs.readFile(path.join(root, p), "utf8")))).toEqual(originals);
});

it("does not use cache recovery to replace a damaged original baseline", async () => {
  const first = await automate(root, { event: "session_start" });
  const ws = await workspace(root);
  const state = JSON.parse(await fs.readFile(path.join(root, ws.directory, "state.json"), "utf8"));
  await fs.rm(path.join(root, state.analysis.path));
  const baseline = path.join(root, first.report.baselinePaths[0]);
  const damaged = JSON.parse(await fs.readFile(baseline, "utf8"));
  damaged.createdAt = "2000-01-01T00:00:00.000Z";
  const bytes = JSON.stringify(damaged);
  await fs.writeFile(baseline, bytes);
  await expect(automate(root, { event: "task_end" })).rejects.toThrow("baseline was modified");
  expect(await fs.readFile(baseline, "utf8")).toBe(bytes);
});

it("rejects symlinked caches and unexpected cache pointers without following or changing them", async () => {
  await automate(root, { event: "session_start" });
  const ws = await workspace(root), statePath = path.join(root, ws.directory, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const cachePath = path.join(root, state.analysis.path);
  await fs.rm(cachePath);
  await fs.symlink(path.join(root, "package.json"), cachePath);
  await expect(automate(root, { event: "task_end" })).rejects.toThrow("Symlink");
  expect((await fs.lstat(cachePath)).isSymbolicLink()).toBe(true);
  state.analysis.path = "package.json";
  await fs.writeFile(statePath, JSON.stringify(state));
  await expect(automate(root, { event: "task_end" })).rejects.toThrow("Invalid automation analysis cache path");
  expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe('{"scripts":{"test":"node --test"}}');
});

it("reopens a review when an ignored original scope changes outside the current audit inventory", async () => {
  await write("AGENTS.md", "The src directory. Generated output: `build/result.js`. Run `npm run test`.\n");
  await fs.mkdir(path.join(root, "build"));
  await commitAll(root, "document generated output");
  const first = await automate(root, { event: "session_start" });
  const finding = first.report.findings.find(f => f.original.evidence.kind === "missing-path")!;
  expect(finding).toBeDefined();
  await write("AGENTS.md", "The src directory. Run `npm run test`.\n");
  await commitAll(root, "remove obsolete output reference");
  const target = { baselinePath: first.report.baselinePaths[0], findingId: finding.id };
  const prepared = await reviewAdvisory(root, { ...target, action: "prepare" });
  await reviewAdvisory(root, { ...target, action: "inapplicable", reviewToken: prepared.reviewToken, reviewer: "Fixture reviewer", note: "Output reference no longer applies." });
  await commitAll(root, "record assessment");
  await automate(root, { event: "task_end" });
  const before = await readInputs(root);
  await write("build/result.js", "generated");
  expect((await readInputs(root)).fingerprint).toBe(before.fingerprint);
  const changed = await automate(root, { event: "task_end" });
  expect(changed.report.checks.auditReused).toBe(true);
  expect(changed.report.findings.find(f => f.id === finding.id)).toMatchObject({ status: "review-required", review: { status: "reopened" } });
});

it("rejects input changes during cached verification and keeps the failed receipt visible", async () => {
  await automate(root, { event: "session_start" });
  const original = drift.getChangesWithStatus;
  vi.spyOn(drift, "getChangesWithStatus").mockImplementation(async (...args) => {
    const result = await original(...args);
    await write("AGENTS.md", "The src directory. Changed during verification.\n");
    return result;
  });
  await expect(automate(root, { event: "task_end" })).rejects.toThrow("changed during verification");
  expect((await automationStatus(root)).verificationStatus).toBe("unavailable");
});

it("profiles checks and hook failures on stderr without changing normal JSON output or recording paths", async () => {
  const out: string[] = [], err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  expect(await runAutomationCli(["check", "--dir", root, "--json", "--profile"], "", io)).toBe(0);
  expect(JSON.parse(out.pop()!).status).toBe("verified");
  const timing = JSON.parse(err.pop()!);
  expect(timing).toMatchObject({ kind: "mason-profile", version: 1, phases: { "automation.inputs": { calls: 2 } } });
  expect(JSON.stringify(timing)).not.toContain(root);
  expect(JSON.stringify(timing)).not.toContain("file-0");
  await runAutomationCli(["check", "--dir", root, "--json"], "", io);
  expect(err).toEqual([]);
  expect(await runAutomationCli(["hook", "--host", "claude", "--profile"], "{broken", io)).toBe(0);
  expect(JSON.parse(out.pop()!).systemMessage).toContain("unavailable");
  expect(JSON.parse(err.pop()!).kind).toBe("mason-profile");
});

it("batches dirty document detection without losing rename or unusual path identity", async () => {
  const old = "odd\t ü/README.md", next = "new\n ü/README.md";
  await write(old, "Documentation.\n");
  await commitAll(root, "add unusual path");
  await fs.mkdir(path.dirname(path.join(root, next)));
  await git(["mv", old, next], root);
  await write("AGENTS.md", "Dirty root.\n");
  await write("untracked/README.md", "Untracked.\n");
  const docs = await discoverDocs(root);
  expect(docs.find(d => d.path === next)?.dirty).toBe(true);
  expect(docs.find(d => d.path === "AGENTS.md")?.dirty).toBe(true);
  expect(docs.find(d => d.path === "untracked/README.md")?.dirty).toBe(true);
  expect(docs.some(d => d.path === old)).toBe(false);
});
