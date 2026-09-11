import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareRepair, verifyRepair, findingId } from "../src/audit/repair.js";
import { reviewAdvisory } from "../src/audit/advisory-review.js";
import { runAuditCli, formatAuditSummary } from "../src/audit/cli.js";
import { computeAudit } from "../src/audit/audit.js";
import { automate } from "../src/automation/runtime.js";
import { upsertDecision, loadDecisions } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { masonReviewAdvisory } from "../src/mcp/tools.js";
import { git, initGitRepo, commitAll } from "./helpers.js";
import { CHECKS } from "../src/audit/checks/index.js";

let root: string;
const write = async (file: string, content: string) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); };
async function seed(doc = "README.md", manifest = "package.json") {
  await write(".gitignore", ".mason/reports/\nnode_modules/\n");
  await write(doc, "# Example\nSupported package instructions.\n");
  await write(manifest, '{"scripts":{"test":"vitest"}}');
  await commitAll(root, "initial");
  await write(manifest, '{"scripts":{"test":"vitest","build":"tsc"}}');
  await commitAll(root, "new build script");
  const baseline = await prepareRepair(root, ["deps-changed"]);
  return { baselinePath: baseline.baselinePath, findingId: findingId(baseline.report.advisories[0]) };
}
async function record(target: Awaited<ReturnType<typeof seed>>, action: "addressed" | "inapplicable" | "deferred" = "inapplicable") {
  const prepared = await reviewAdvisory(root, { ...target, action: "prepare" });
  if (prepared.status !== "prepared") throw new Error("Not prepared");
  return reviewAdvisory(root, { ...target, action, reviewToken: prepared.reviewToken, reviewer: "Fixture reviewer", note: "Reviewed the added build script; the existing instructions remain accurate." });
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-advisory-")); await initGitRepo(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("durable advisory assessments", () => {
  it("prepares original evidence without writing and requires attribution and a fresh token", async () => {
    const target = await seed();
    const prepared = await reviewAdvisory(root, target);
    expect(prepared).toMatchObject({ status: "prepared", finding: { type: "deps-changed" }, history: [] });
    expect(prepared.status === "prepared" && prepared.diff).toContain('"build":"tsc"');
    await expect(fs.access(path.join(root, ".mason/reviews"))).rejects.toThrow();
    await expect(reviewAdvisory(root, { ...target, action: "addressed" })).rejects.toThrow("requires reviewToken");
  });

  it("retains closure across fresh calls, the final metadata commit and unrelated changes", async () => {
    const target = await seed();
    const original = await fs.readFile(path.join(root, target.baselinePath), "utf8");
    expect((await verifyRepair(root, target.baselinePath)).counts["review-required"]).toBe(1);
    await record(target);
    const closed = await verifyRepair(root, target.baselinePath);
    expect(closed).toMatchObject({ status: "verified", findings: [{ status: "resolved", review: { status: "current", reviewer: "Fixture reviewer" } }] });
    await commitAll(root, "record advisory assessment");
    await write("unrelated.ts", "export const unrelated = true;");
    await commitAll(root, "unrelated code");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
    expect(await fs.readFile(path.join(root, target.baselinePath), "utf8")).toBe(original);
    const audit = (await computeAudit(root, { checks: ["deps-changed"] }))!;
    expect(audit.advisories).toHaveLength(1); // Historical evidence is retained.
    expect(formatAuditSummary(audit)).toContain("1 advisories have recorded assessments");
    expect(formatAuditSummary(audit)).not.toContain("1 advisories remain for review");
  });

  it("resolves an addressed historical advisory after a real documentation repair", async () => {
    const target = await seed();
    await write("README.md", "# Example\nBuild with `npm run build`.\n");
    await commitAll(root, "document build");
    await record(target, "addressed");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
    await commitAll(root, "record assessment");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
  });

  it.each(["README.md", "package.json"])("reopens when relevant %s changes and preserves prior history", async file => {
    const target = await seed(); await record(target); await commitAll(root, "review");
    await write(file, file.endsWith("json") ? '{"scripts":{"test":"new-test"}}' : "# Revised instructions\nDifferent guidance.\n");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("incomplete");
    await commitAll(root, "change reviewed evidence");
    const reopened = await verifyRepair(root, target.baselinePath);
    expect(reopened.findings[0]).toMatchObject({ status: "review-required", review: { status: "reopened" } });
    await record(target, "addressed");
    const again = await reviewAdvisory(root, target);
    expect(again.status === "prepared" && again.history.length).toBe(2);
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
  });

  it("does not resolve deferred findings", async () => {
    const target = await seed(); await record(target, "deferred");
    expect((await verifyRepair(root, target.baselinePath)).findings[0]).toMatchObject({ status: "review-required", review: { status: "deferred" } });
  });

  it("rejects stale preparations after code or competing review changes", async () => {
    const target = await seed(); const prepared = await reviewAdvisory(root, target);
    if (prepared.status !== "prepared") throw new Error("Not prepared");
    const input = { ...target, action: "inapplicable" as const, reviewer: "Fixture reviewer", note: "Reviewed", reviewToken: prepared.reviewToken };
    await record(target);
    await expect(reviewAdvisory(root, input)).rejects.toThrow("conflict");
    const updated = await reviewAdvisory(root, target);
    if (updated.status !== "prepared") throw new Error("Not prepared");
    await write("package.json", '{}'); await commitAll(root, "change package");
    await expect(reviewAdvisory(root, { ...input, reviewToken: updated.reviewToken })).rejects.toThrow("conflict");
  });

  it("requires committed scoped edits while allowing unrelated local work", async () => {
    const target = await seed(); await write("package.json", '{}');
    await expect(record(target)).rejects.toThrow("Commit relevant");
    await commitAll(root, "commit manifest"); await write("unrelated.ts", "local work");
    await record(target);
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
  });

  it("preserves closure in a clone with a newly captured equivalent baseline", async () => {
    const target = await seed(); await record(target); await commitAll(root, "review");
    const clone = root + "-clone";
    try {
      await git(["clone", root, clone], path.dirname(root));
      const fresh = await prepareRepair(clone, ["deps-changed"]);
      expect((await verifyRepair(clone, fresh.baselinePath)).status).toBe("verified");
    } finally { await fs.rm(clone, { recursive: true, force: true }); }
  });

  it("uses package scope, handles literal path characters, and notices newly added manifests", async () => {
    const target = await seed("packages/[sdk] space/README.md", "packages/[sdk] space/package.json");
    await record(target); await commitAll(root, "review");
    await write("packages/other/package.json", '{}'); await commitAll(root, "other package");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
    await write("packages/[sdk] space/sub/package.json", '{}'); await commitAll(root, "new scoped manifest");
    expect((await verifyRepair(root, target.baselinePath)).findings[0].review?.status).toBe("reopened");
  });

  it("keeps malformed review history visible and never treats a missing document as reviewed", async () => {
    const target = await seed(); const result = await record(target);
    if (result.status !== "recorded") throw new Error("Not recorded");
    const file = path.join(root, result.recordPath);
    const valid = await fs.readFile(file, "utf8");
    await fs.writeFile(file, '{"invalid":true}');
    expect((await verifyRepair(root, target.baselinePath)).findings[0].status).toBe("unverified");
    await expect(record(target)).rejects.toThrow();
    await fs.writeFile(file, valid); await write("README.md", "");
    expect((await verifyRepair(root, target.baselinePath)).findings[0].status).toBe("unverified");
  });

  it("serializes concurrent submissions without losing an assessment", async () => {
    const target = await seed(); const prepared = await reviewAdvisory(root, target);
    if (prepared.status !== "prepared") throw new Error("Not prepared");
    const input = { ...target, action: "inapplicable" as const, reviewer: "Fixture reviewer", note: "Reviewed", reviewToken: prepared.reviewToken };
    const results = await Promise.allSettled([reviewAdvisory(root, input), reviewAdvisory(root, input)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const again = await reviewAdvisory(root, target);
    expect(again.status === "prepared" && again.history.length).toBe(1);
  });

  it("updates automation's cached status and deduplicates equivalent baseline findings", async () => {
    await seed();
    const initial = (await automate(root, { event: "task_end" })).report;
    const finding = initial.findings.find(f => f.original.type === "deps-changed")!;
    const target = { baselinePath: initial.baselinePaths[0], findingId: finding.id };
    await record(target);
    const checked = (await automate(root, { event: "task_end" })).report;
    expect(checked.findings.find(f => f.id === finding.id)?.status).toBe("resolved");
    expect(checked.counts["review-required"]).toBe(0);
    expect(checked.findings.filter(f => f.id === finding.id)).toHaveLength(1);
    await commitAll(root, "commit review");
    expect((await automate(root, { event: "task_end" })).report.counts["review-required"]).toBe(0);
  });

  it("closes a later finding across both a clean initial baseline and its captured baseline", async () => {
    await write(".gitignore", ".mason/reports/\n"); await write("README.md", "# Project\n"); await write("package.json", '{}');
    await commitAll(root, "initial");
    const initial = (await automate(root, { event: "task_end" })).report;
    expect(initial.status).toBe("verified");
    await write("package.json", '{"scripts":{"test":"vitest"}}'); await commitAll(root, "add test script");
    const changed = (await automate(root, { event: "task_end" })).report;
    expect(changed.baselinePaths).toHaveLength(2);
    const finding = changed.findings.find(f => f.original.type === "deps-changed")!;
    await record({ baselinePath: changed.baselinePaths[1], findingId: finding.id });
    expect((await automate(root, { event: "task_end" })).report).toMatchObject({ status: "verified", counts: { resolved: 1, "review-required": 0 } });
    await commitAll(root, "record review");
    expect((await automate(root, { event: "task_end" })).report.status).toBe("verified");
  });

  it("exposes preparation and recording through CLI and MCP", async () => {
    const target = await seed(); const output: string[] = [];
    const code = await runAuditCli(["review", "--dir", root, "--baseline", target.baselinePath, "--finding", target.findingId, "--json"], { out: text => output.push(text), err: text => output.push(text) });
    expect(code).toBe(0);
    const prepared = JSON.parse(output[0]);
    expect(JSON.parse(await masonReviewAdvisory(root, { ...target, action: "inapplicable", reviewToken: prepared.reviewToken, reviewer: "Fixture reviewer", note: "Reviewed" })).status).toBe("recorded");
  });

  it("routes decisions to existing reviews and preserves acceptance, reopening and retirement", async () => {
    await seed(); await write("src/client.ts", "export const retries = 1;\n"); await commitAll(root, "client");
    await upsertDecision(root, { title: "Retry only transient failures", body: "Avoid retrying authorization failures; only transient failures may succeed on retry.", category: "decision", files: ["src/client.ts"],
      owner: "Fixture team", sources: [{ kind: "document", reference: "README.md" }] });
    const id = (await loadDecisions(root))[0].id;
    await commitAll(root, "proposal"); await write("src/client.ts", "export const retries = 2;\n"); await commitAll(root, "change client");
    const baseline = await prepareRepair(root, ["decision-anchor-drift"]);
    const target = { baselinePath: baseline.baselinePath, findingId: findingId(baseline.report.advisories[0]) };
    expect(await reviewAdvisory(root, target)).toMatchObject({ status: "decision-review-required", decisionId: id });
    expect((await verifyRepair(root, target.baselinePath)).counts["review-required"]).toBe(1);
    const prepared = await reviewDecision(root, { id });
    if (prepared.status !== "prepared") throw new Error("Not prepared");
    expect((await reviewDecision(root, { id, action: "accept", reviewer: "Fixture reviewer", note: "Reviewed behavior", reviewToken: prepared.reviewToken })).status).toBe("accepted");
    await commitAll(root, "accept decision");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
    await write("src/client.ts", "export const retries = 3;\n"); await commitAll(root, "change again");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("incomplete");
    const retire = await reviewDecision(root, { id });
    if (retire.status !== "prepared") throw new Error("Not prepared");
    await reviewDecision(root, { id, action: "retire", reviewer: "Fixture reviewer", note: "Constraint no longer applies", reviewToken: retire.reviewToken });
    await commitAll(root, "retire decision");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
  });

  it("never lets an advisory assessment dismiss a newly provable issue", async () => {
    await seed(); await write("src/kept.ts", "export {};"); await write("README.md", "Use `src/missing.ts`.\n"); await commitAll(root, "claim");
    const baseline = await prepareRepair(root, ["deleted-reference"]);
    const original = baseline.report.advisories[0];
    const target = { baselinePath: baseline.baselinePath, findingId: findingId(original) };
    await record(target);
    vi.spyOn(CHECKS, "deleted-reference").mockResolvedValue({ issues: [{ ...original, type: "deleted-reference", confidence: "certain" }], advisories: [], skipped: [] });
    expect((await verifyRepair(root, target.baselinePath)).findings[0].status).toBe("unresolved");
  });

  it("refuses symlinked review records and unreachable assessment history", async () => {
    const target = await seed(); const recorded = await record(target);
    if (recorded.status !== "recorded") throw new Error("Not recorded");
    const file = path.join(root, recorded.recordPath);
    const valid = await fs.readFile(file, "utf8");
    await fs.unlink(file); await write("copy.json", valid); await fs.symlink(path.join(root, "copy.json"), file);
    expect((await verifyRepair(root, target.baselinePath)).findings[0].status).toBe("unverified");
    await fs.unlink(file); await fs.writeFile(file, valid);
    // A valid record from another history cannot establish a review here.
    const changed = JSON.parse(valid); changed.events[0].evidence.head = "0".repeat(40);
    const { digest } = await import("../src/audit/findings.js");
    const { digest: old, ...payload } = changed; changed.digest = digest(payload);
    await fs.writeFile(file, JSON.stringify(changed));
    expect((await verifyRepair(root, target.baselinePath)).findings[0].status).toBe("unverified");
  });

  it("reopens an assessed reference when an ignored output appears and rejects linked targets", async () => {
    await seed();
    await write(".gitignore", ".mason/reports/\nbuild/\n");
    await write("README.md", "The optional [generated guide](build/guide.md).\n");
    await commitAll(root, "document generated output");
    const baseline = await prepareRepair(root, ["deleted-reference"]);
    const target = { baselinePath: baseline.baselinePath, findingId: findingId(baseline.report.advisories[0]) };
    await record(target); await commitAll(root, "review optional output");
    expect((await verifyRepair(root, target.baselinePath)).status).toBe("verified");
    await write("build/guide.md", "# Generated guide\n");
    expect((await verifyRepair(root, target.baselinePath)).findings[0].review?.status).toBe("reopened");
    await fs.unlink(path.join(root, "build/guide.md"));
    await fs.symlink(path.join(root, "README.md"), path.join(root, "build/guide.md"));
    await expect(reviewAdvisory(root, target)).rejects.toThrow("symbolic link");
  });
});
