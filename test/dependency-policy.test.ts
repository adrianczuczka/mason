import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initGitRepo, commitAll } from "./helpers.js";
import { computeAudit } from "../src/audit/audit.js";
import { prepareRepair, verifyRepair, findingId, formatRepairSummary } from "../src/audit/repair.js";
import { reviewAdvisory } from "../src/audit/advisory-review.js";
import { runAdvisoryCli } from "../src/audit/advisory-cli.js";
import { discoverDocPaths } from "../src/audit/docs.js";
import { readInputs } from "../src/automation/evidence.js";
import { automate } from "../src/automation/runtime.js";
import { digest } from "../src/audit/findings.js";
import { withRepositoryInspection } from "../src/audit/inspection.js";

let root: string;
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
};
const manifest = (zod: string, react = "18") => JSON.stringify({ dependencies: { zod, react } });
const audit = () => computeAudit(root, { checks: ["deps-changed"] });
async function seed(doc = "Use zod 3 for validation.\n") {
  await write(".gitignore", ".mason/reports/\nignored/\n");
  await write("README.md", doc);
  await write("package.json", manifest("3"));
  await commitAll(root, "initial");
  await write("package.json", manifest("4"));
  await commitAll(root, "upgrade zod");
}
async function target() {
  const prepared = await prepareRepair(root, ["deps-changed"]);
  return { baselinePath: prepared.baselinePath, findingId: findingId(prepared.report.advisories[0]) };
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-dependency-policy-")); await initGitRepo(root); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("dependency precision and policy", () => {
  it("shows the affected passage and actual dependency change", async () => {
    await seed("# Setup\nUse zod 3 for validation.\n");
    const report = await audit();
    expect(report?.advisories).toHaveLength(1);
    expect(report?.advisories[0]).toMatchObject({ anchor: { line: 2, excerpt: "Use zod 3 for validation." },
      evidence: { matches: [{ dependency: "zod", manifest: "package.json", before: "3", after: "4", line: 2 }] } });
    expect((await verifyRepair(root, (await target()).baselinePath)).status).toBe("incomplete");
  });

  it("does not match unchanged dependencies, substrings or comments", async () => {
    await seed("# Dependencies\nUse react 18. zodish is an example.\n<!-- zod 3 -->\n");
    expect((await audit())?.advisories[0]).toMatchObject({ resolution: "informational", evidence: { matches: [] } });
    const checked = await verifyRepair(root, (await target()).baselinePath);
    expect(checked.status).toBe("verified");
    expect(checked.counts["review-required"]).toBe(0);
    await write("README.md", "# Dependencies\nEdited while working.\n");
    expect((await verifyRepair(root, checked.baselinePath)).status).toBe("verified");
  });

  it("keeps generic manifest churn out of the hook review queue", async () => {
    await seed("# Dependencies\nSee package.json.\n");
    const result = await automate(root, { event: "session_start", host: "claude", sessionId: "fixture" });
    expect(result.report.status).toBe("verified");
    expect(result.report.counts["review-required"]).toBe(0);
    expect(result.message).toBeNull();
  });

  it("includes configured guides with root dependency scope and respects Git ignores", async () => {
    await seed();
    await write("docs/dependencies.md", "Use zod 4.\n");
    await write("ignored/private.md", "Use zod.\n");
    await write("src/unrelated.ts", "export {};\n");
    await write(".mason/config.json", JSON.stringify({ audit: { include: ["docs/**/*.md", "ignored/**/*.md"] } }));
    await commitAll(root, "guides");
    await write("package.json", manifest("5")); await commitAll(root, "upgrade");
    const paths = await withRepositoryInspection(root, () => discoverDocPaths(root));
    expect(paths.sort()).toEqual(["README.md", "docs/dependencies.md"].sort());
    expect((await audit())?.advisories.find(f => f.anchor.doc === "docs/dependencies.md")?.evidence).toMatchObject({ matches: [{ dependency: "zod", before: "4", after: "5" }] });
  });

  it("excludes only the selected check and invalidates cached automation", async () => {
    await seed("Use zod 3.\n[missing](missing.md)\n");
    const baseline = await target();
    const before = await readInputs(root);
    await write(".mason/config.json", JSON.stringify({ audit: { exclude: { "deps-changed": ["README.md"] } } }));
    const report = await computeAudit(root);
    expect(report?.advisories.some(f => f.type === "deps-changed")).toBe(false);
    expect(report?.advisories.some(f => f.type === "deleted-reference")).toBe(true);
    expect((await readInputs(root)).keys["deps-changed"]).not.toBe(before.keys["deps-changed"]);
    const checked = await verifyRepair(root, baseline.baselinePath);
    expect(checked.status).toBe("verified");
    expect(checked.findings[0].reason).toContain("Excluded by project audit policy");
    await write(".mason/config.json", "{}");
    expect((await verifyRepair(root, baseline.baselinePath)).status).toBe("incomplete");
  });

  it("matches Gradle catalog version references to Maven coordinates", async () => {
    await write("README.md", 'Use `androidx.compose.ui:ui:1.0`.\n');
    const catalog = (version: string) => `[versions]\ncompose = "${version}"\n[libraries]\ncompose-ui = { module = "androidx.compose.ui:ui", version.ref = "compose" }\n`;
    await write("gradle/libs.versions.toml", catalog("1.0")); await commitAll(root, "initial");
    await write("gradle/libs.versions.toml", catalog("2.0")); await commitAll(root, "upgrade compose");
    expect((await audit())?.advisories[0].evidence).toMatchObject({ matches: [{ dependency: "androidx.compose.ui:ui", before: "1.0", after: "2.0" }] });
  });

  it("does not let later informational churn close an earlier specific finding", async () => {
    await seed(); const original = await target();
    await write("README.md", "# Dependencies\nUse zod 3 for validation. Extra guidance.\n"); await commitAll(root, "edit unrelated prose");
    await write("package.json", manifest("4", "19")); await commitAll(root, "upgrade unrelated react");
    expect((await audit())?.advisories[0].resolution).toBe("informational");
    expect((await verifyRepair(root, original.baselinePath)).findings[0].status).toBe("review-required");
  });

  it("retains legacy recency-only evidence without requiring an assessment", async () => {
    await seed("# Dependencies\nSee package.json.\n"); const original = await target();
    const file = path.join(root, original.baselinePath);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    delete saved.report.advisories[0].resolution;
    delete saved.report.advisories[0].evidence.matches;
    delete saved.report.advisories[0].evidence.matchingIncomplete;
    const { digest: previous, ...payload } = saved;
    await fs.writeFile(file, JSON.stringify({ ...payload, digest: digest(payload) }));
    await write("README.md", "# Project\nNavigation only.\n"); await commitAll(root, "edit document");
    const checked = await verifyRepair(root, original.baselinePath);
    expect(checked.status).toBe("verified");
    expect(checked.findings[0].reason).toContain("Retained as information");
    expect(checked.findings[0].original.evidence).not.toHaveProperty("matches");
  });

  it("does not inspect excluded path targets during automation", async () => {
    await seed("[generated](generated.md)\n");
    await fs.symlink(path.join(root, "README.md"), path.join(root, "generated.md"));
    await write(".mason/config.json", JSON.stringify({ audit: { exclude: { "deleted-reference": ["README.md"] } } }));
    expect((await automate(root, { event: "task_end" })).report.status).toBe("verified");
  });

  it("labels retained findings with their historical baseline", async () => {
    await seed(); const original = await target();
    await write("README.md", "Use zod 4.\n"); await commitAll(root, "update doc");
    const checked = await verifyRepair(root, original.baselinePath);
    expect(formatRepairSummary(checked)).toContain("Historical evidence at ");
    expect(checked.findings[0].status).toBe("review-required");
  });
});

describe("one-step dependency dismissals", () => {
  it("keeps no-claims dismissal through manifest changes and reopens on document edits", async () => {
    await seed("# Dependencies\nSee package.json for details.\n"); const original = await target();
    const result = await reviewAdvisory(root, { ...original, action: "dismiss", reasonCode: "no-dependency-claims", note: "This page gives navigation only." });
    expect(result.status).toBe("recorded");
    await commitAll(root, "share dismissal");
    await write("package.json", manifest("5")); await commitAll(root, "another upgrade");
    let checked = await verifyRepair(root, original.baselinePath);
    expect(checked.findings[0]).toMatchObject({ status: "resolved", review: { outcome: "dismissed", status: "current" } });
    await write("package.json", manifest("6"));
    expect((await verifyRepair(root, original.baselinePath)).findings[0].review?.status).toBe("current");
    await write("README.md", "# Dependencies\nUse zod 5.\n"); await commitAll(root, "introduce claim");
    checked = await verifyRepair(root, original.baselinePath);
    expect(checked.findings[0]).toMatchObject({ status: "review-required", review: { status: "reopened" } });
    expect(checked.status).toBe("incomplete");
  });

  it("reopens unrelated-change dismissals on later manifest changes", async () => {
    await seed(); const original = await target();
    await reviewAdvisory(root, { ...original, action: "dismiss", reasonCode: "unrelated-manifest-change", note: "The advice applies to either supported version." });
    await commitAll(root, "dismiss");
    expect((await verifyRepair(root, original.baselinePath)).status).toBe("verified");
    await write("package.json", manifest("5")); await commitAll(root, "upgrade");
    expect((await verifyRepair(root, original.baselinePath)).findings[0].review?.status).toBe("reopened");
  });

  it("supports CLI dismissal without preparation and requires a reason", async () => {
    await seed(); const original = await target();
    await expect(reviewAdvisory(root, { ...original, action: "dismiss", note: "Missing code" })).rejects.toThrow("reasonCode");
    const output: string[] = [];
    expect(await runAdvisoryCli(["--dir", root, "--baseline", original.baselinePath, "--finding", original.findingId,
      "--outcome", "dismiss", "--reason", "unrelated-manifest-change", "--note", "Version-independent guidance", "--json"],
    { out: value => output.push(value), err: value => output.push(value) })).toBe(0);
    expect(JSON.parse(output[0]).event.outcome).toBe("dismissed");
  });

  it("refuses dismissal of other advisory types and uncommitted documents", async () => {
    await seed("Use zod 3. [missing](missing.md)\n");
    const original = await target();
    await write("README.md", "Use zod 4.\n");
    await expect(reviewAdvisory(root, { ...original, action: "dismiss", reasonCode: "no-dependency-claims", note: "Draft" })).rejects.toThrow("Commit relevant");
    await write("README.md", "[missing](missing.md)\n"); await commitAll(root, "reference");
    const baseline = await prepareRepair(root, ["deleted-reference"]);
    await expect(reviewAdvisory(root, { baselinePath: baseline.baselinePath, findingId: findingId(baseline.report.advisories[0]),
      action: "dismiss", reasonCode: "no-dependency-claims", note: "Wrong type" })).rejects.toThrow("only available for dependency");
  });

  it("rejects unsafe configuration and configured symlinks", async () => {
    await seed();
    await write(".mason/config.json", JSON.stringify({ audit: { include: ["../outside/*.md"] } }));
    await expect(audit()).rejects.toThrow("repository-relative");
    await write(".mason/config.json", JSON.stringify({ audit: { include: ["guide.md"] } }));
    await fs.symlink(path.join(root, "README.md"), path.join(root, "guide.md"));
    await expect(audit()).rejects.toThrow(/symbolic link|Symlink/i);
  });
});
