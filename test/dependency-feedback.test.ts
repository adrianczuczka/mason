import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { computeAudit } from "../src/audit/audit.js";
import { prepareRepair, verifyRepair } from "../src/audit/repair.js";
import { hasDependencyContent } from "../src/audit/checks/deps-changed.js";
import { automate, summarize } from "../src/automation/runtime.js";
import { commitAll, initGitRepo } from "./helpers.js";

let root: string;
const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text);
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-dependency-feedback-")));
  await initGitRepo(root);
  await write(".gitignore", ".mason/\n");
  await write("README.md", "## Library Dependencies\n- ZXing\n- commons-net\n");
  await write("package.json", '{"dependencies":{"zxing":"1.0"}}');
  await commitAll(root, "initial");
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));
async function bump(version: number) {
  await write("package.json", JSON.stringify({ dependencies: { zxing: `${version}.0` } }));
  await commitAll(root, "dependency update " + version);
}

it("filters general instructions while retaining versionless library lists and runtime requirements", async () => {
  await write("AGENTS.md", "## Architecture\nKeep remote and local beside data.\nReview changes within the requested scope.\n");
  await write("CLAUDE.md", "Requires JDK 21.\n");
  await commitAll(root, "instructions"); await bump(2);
  const report = (await computeAudit(root, { checks: ["deps-changed"] }))!;
  expect(report.advisories.map(f => f.anchor.doc).sort()).toEqual(["CLAUDE.md", "README.md"]);
  expect(report.skippedChecks).toEqual([]);
});

it.each([
  ["## Tech stack\nReact, TypeScript, Node", true],
  ["Library: ZXing.", true],
  ["Install with `pip install requests`.", true],
  ["Versions are configured in `gradle/libs.versions.toml`.", true],
  ["Use JDK 21 to build.", true],
  ["# Architecture\nKeep remote and local beside data.", false],
  ["# Review\n<!-- dependency versions -->", false],
  ["# Review\n<!-- mason:start -->\nCheck dependency changes.\n<!-- mason:end -->", false],
])("recognizes dependency-facing content: %s", (text, relevant) => {
  expect(hasDependencyContent(text as string)).toBe(relevant);
});

it("uses committed content when a local edit removes the dependency section", async () => {
  await bump(2);
  await write("README.md", "# Project\nGeneral usage only.\n");
  const baseline = await prepareRepair(root, ["deps-changed"]);
  expect(baseline.report.advisories).toEqual([]);
  expect(baseline.report.suppressedAdvisories).toHaveLength(1);
  expect((await verifyRepair(root, baseline.baselinePath)).findings[0].status).toBe("unverified");
  await commitAll(root, "remove section");
  const checked = await verifyRepair(root, baseline.baselinePath);
  expect(checked.findings[0]).toMatchObject({ status: "review-required", reason: expect.stringContaining("no longer reports") });
});

it("shows current dependency evidence and labels retained historical evidence after a doc commit", async () => {
  await bump(2);
  const initial = (await automate(root, { event: "session_start" })).report;
  const original = initial.findings[0].original;
  const baselineBytes = await fs.readFile(path.join(root, initial.baselinePaths[0]));
  await bump(3);
  const current = (await automate(root, { event: "task_end" })).report;
  expect(current.findings[0].original).toEqual(original);
  expect(summarize(current)).toContain("2 commits");
  expect(summarize(current)).toContain("dependency update 3");
  expect(summarize(current)).toContain("1 advisory awaiting review");
  await write("README.md", "## Library Dependencies\nZXing is maintained in the manifest.\n");
  await commitAll(root, "revise docs");
  const historical = (await automate(root, { event: "task_end" })).report;
  expect(historical.status).toBe("incomplete"); // Stable machine-readable contract.
  expect(historical.findings[0]).toMatchObject({ original, status: "review-required" });
  expect(historical.findings[0].current).toBeUndefined();
  const summary = summarize(historical);
  expect(summary).toContain("1 advisory awaiting review");
  expect(summary).toContain("current check no longer reports this condition");
  expect(summary).not.toContain("manifests touched");
  expect(await fs.readFile(path.join(root, initial.baselinePaths[0]))).toEqual(baselineBytes);
  expect(summarize({ ...historical, diagnostics: ["History unavailable"] })).toContain("Mason: incomplete");
}, 20000);
