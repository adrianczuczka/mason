import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { git, initGitRepo, commitAll } from "./helpers.js";
import { computeReview } from "../src/review/review.js";
import { runReviewCli, formatReviewSummary } from "../src/review/cli.js";
import { upsertDecision } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { masonInit } from "../src/mcp/tools.js";
import * as snapshot from "../src/snapshot/snapshot.js";

describe("CI evidence in reviews", () => {
  let repo: string, base: string, head: string;
  const reportPath = ".mason/reports/check.json", manifestPath = ".mason/reports/evidence.json";
  const sourceRoot = "/runner/project";
  const write = async (file: string, value: unknown) => {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  const testReport = (status: "passed" | "failed" | "skipped" = "passed") => ({
    success: status !== "failed", numTotalTests: 1, numPassedTests: Number(status === "passed"), numFailedTests: Number(status === "failed"),
    numPendingTests: Number(status === "skipped"), numTodoTests: 0, numFailedTestSuites: Number(status === "failed"),
    testResults: [{ name: `${sourceRoot}/test/delivery.test.ts`, status: status === "failed" ? "failed" : "passed", message: "",
      assertionResults: [{ fullName: "delivery respects idempotency", status, failureMessages: status === "failed" ? ["Repeated an unkeyed delivery"] : [] }] }],
  });
  const check = (extra = {}) => ({ id: "tests", kind: "tests", tool: "vitest", command: "npm test", commit: head, workingTreeClean: true,
    source: "https://ci.example.test/runs/42", sourceRoot, status: "completed", exitCode: 0, report: { format: "vitest-json", path: reportPath }, ...extra });
  const sarif = (results: unknown[] = [], extra = {}) => ({ version: "2.1.0", runs: [{ tool: { driver: { name: "Example analyzer", rules: [{ id: "retry-safety", defaultConfiguration: { level: "error" } }] } },
    invocations: [{ executionSuccessful: true, commandLine: "analyze src" }], results, ...extra }] });
  const finding = (extra = {}) => ({ ruleId: "retry-safety", message: { text: "Retry lacks an idempotency check" }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/delivery.ts" }, region: { startLine: 1 } } }], ...extra });
  const manifest = async (checks: unknown[] = [check()]) => write(manifestPath, { version: 1, checks });
  const review = () => computeReview(repo, base, { evidence: [manifestPath] });
  const cli = async (extra: string[] = []) => {
    const out: string[] = [], err: string[] = [];
    const code = await runReviewCli(["--dir", repo, "--base", base, "--evidence", manifestPath, ...extra], { out: s => out.push(s), err: s => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "mason-evidence-"));
    await initGitRepo(repo);
    await write("src/delivery.ts", "export const retries = 1;\n");
    await write("test/delivery.test.ts", "// delivery tests\n");
    base = await commitAll(repo, "initial delivery");
    await write("src/delivery.ts", "export const retries = 2;\n");
    head = await commitAll(repo, "change delivery");
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(repo, { recursive: true, force: true }); });

  it("preserves the old review contract when no evidence is requested", async () => {
    const result = await computeReview(repo, base);
    expect(result.evidence).toBeUndefined();
    expect(result.version).toBe(1);
    await expect(fs.access(path.join(repo, ".mason"))).rejects.toThrow();
  });

  it("imports current passing test evidence with command and source, without writes", async () => {
    await write(reportPath, testReport()); await manifest();
    const before = await git(["status", "--porcelain"], repo);
    const result = await review();
    expect(result.evidence).toMatchObject({ status: "passed", headHash: head, scope: "committed", summary: { passed: 1 } });
    expect(result.evidence.checks[0]).toMatchObject({ command: "npm test", commit: head, source: "https://ci.example.test/runs/42", freshness: "current", counts: { passed: 1 } });
    expect(await git(["status", "--porcelain"], repo)).toBe(before);
    expect((await cli(["--require-evidence"])).code).toBe(0);
  });

  it("associates failing tests with paired changed sources and accepted decisions only", async () => {
    const input = { title: "Delivery idempotency", body: "Incident 42 duplicated deliveries; require a key before retry.", category: "gotcha" as const, files: ["src/delivery.ts"], owner: "Delivery team", sources: [{ kind: "incident" as const, reference: "incident/42" }] };
    const saved = await upsertDecision(repo, input);
    const prepared = await reviewDecision(repo, { id: saved.id });
    await reviewDecision(repo, { id: saved.id, action: "accept", reviewer: "Test reviewer", note: "Reviewed incident and source", reviewToken: prepared.reviewToken });
    await upsertDecision(repo, { ...input, title: "Unaccepted alternative", force: true });
    await write(reportPath, testReport("failed")); await manifest([check({ exitCode: 1 })]);
    const result = await review(), failure = result.evidence.checks[0].findings[0];
    expect(result.evidence.status).toBe("failed");
    expect(failure.relatedChangedFiles).toEqual([{ file: "src/delivery.ts", relationship: "paired-test", confidence: "exact" }]);
    expect(failure.acceptedDecisions.map(d => d.id)).toEqual([saved.id]);
    expect(failure.acceptedDecisions[0].owner).toBe("Delivery team");
    expect(formatReviewSummary(result)).toContain("Related decisions are associations, not proven violations");
    expect((await cli()).code).toBe(0);
    expect((await cli(["--require-evidence"])).code).toBe(1);
  });

  it("imports SARIF locations, rule metadata, and commands", async () => {
    await write(reportPath, sarif([finding()]));
    await manifest([check({ id: "analysis", kind: "static-analysis", tool: "Example analyzer", report: { format: "sarif", path: reportPath } })]);
    const imported = (await review()).evidence.checks[0];
    expect(imported).toMatchObject({ outcome: "failed", reportedTools: ["Example analyzer"], reportedCommands: ["analyze src"] });
    expect(imported.findings[0]).toMatchObject({ severity: "error", locations: [{ file: "src/delivery.ts", line: 1 }], relatedChangedFiles: [{ file: "src/delivery.ts", relationship: "direct" }] });
  });

  it("keeps stale passing reports from becoming current evidence", async () => {
    await write(reportPath, testReport()); await manifest([check({ commit: base })]);
    expect((await review()).evidence).toMatchObject({ status: "incomplete", checks: [{ outcome: "passed", freshness: "stale" }] });
    expect((await cli(["--require-evidence"])).code).toBe(2);
  });

  it.each([null, undefined])("keeps an absent tested commit unknown (%s)", async commit => {
    await write(reportPath, testReport()); await manifest([check({ commit })]);
    expect((await review()).evidence).toMatchObject({ status: "incomplete", checks: [{ freshness: "unknown" }] });
  });

  it.each([false, undefined])("does not attribute a dirty or unrecorded test checkout to HEAD (%s)", async workingTreeClean => {
    await write(reportPath, testReport()); await manifest([check({ workingTreeClean })]);
    expect((await review()).evidence.checks[0].freshness).toBe("unknown");
    expect((await cli(["--require-evidence"])).code).toBe(2);
  });

  it("keeps current working-tree edits outside the imported commit evidence", async () => {
    await write(reportPath, testReport()); await manifest();
    await write("src/delivery.ts", "export const retries = 9;\n");
    expect((await review()).evidence.workingTree.changedFiles).toContain("src/delivery.ts");
    expect((await cli()).out).toContain("outside this evidence's scope");
  });

  it("distinguishes skipped checks and missing report artifacts", async () => {
    await manifest([check(), check({ id: "lint", kind: "static-analysis", status: "skipped", report: undefined, reason: "Not configured in this job" })]);
    const result = (await review()).evidence;
    expect(result.checks.map(c => c.outcome)).toEqual(["unavailable", "skipped"]);
    expect(result.checks[1].diagnostics).toContain("Not configured in this job");
    expect((await cli(["--require-evidence"])).code).toBe(2);
  });

  it("does not call zero tests or all-skipped tests passing", async () => {
    await write(reportPath, { ...testReport(), numTotalTests: 0, numPassedTests: 0, testResults: [] }); await manifest();
    expect((await review()).evidence.checks[0].outcome).toBe("unavailable");
    await write(reportPath, testReport("skipped"));
    expect((await review()).evidence.checks[0].outcome).toBe("skipped");
  });

  it("rejects contradictory success and count claims", async () => {
    await write(reportPath, { ...testReport("failed"), success: true }); await manifest();
    expect((await review()).evidence.checks[0].outcome).toBe("unavailable");
    await write(reportPath, { ...testReport(), numTotalTests: 200 });
    expect((await review()).evidence.checks[0].outcome).toBe("unavailable");
  });

  it("does not ignore nonzero or missing command exit status", async () => {
    await write(reportPath, testReport()); await manifest([check({ exitCode: 2 })]);
    expect((await review()).evidence.status).toBe("failed");
    await manifest([check({ exitCode: null })]);
    expect((await review()).evidence.status).toBe("incomplete");
  });

  it("keeps valid checks visible beside malformed records and duplicate check ids", async () => {
    await write(reportPath, testReport()); await manifest([check(), { id: "bad", report: {} }, check()]);
    const result = (await review()).evidence;
    expect(result.checks).toHaveLength(1);
    expect(result.status).toBe("incomplete");
    expect(result.diagnostics.join(" ")).toContain("Duplicate check id");
  });

  it("rejects artifacts outside the repository and symlinked reports", async () => {
    await manifest([check({ report: { format: "vitest-json", path: "../outside.json" } })]);
    expect((await review()).evidence.checks[0].diagnostics.join(" ")).toMatch(/inside the repository/);
    await fs.symlink(path.join(repo, "src/delivery.ts"), path.join(repo, reportPath)); await manifest();
    expect((await review()).evidence.checks[0].diagnostics.join(" ")).toMatch(/Symlink/);
  });

  it("does not execute a command recorded in a manifest", async () => {
    await write(reportPath, testReport()); await manifest([check({ command: "touch SHOULD_NOT_EXIST" })]);
    await review();
    await expect(fs.access(path.join(repo, "SHOULD_NOT_EXIST"))).rejects.toThrow();
  });

  it("does not count absent, accepted-suppressed, or pass SARIF results as active failures", async () => {
    await write(reportPath, sarif([finding({ baselineState: "absent" }), finding({ suppressions: [{ kind: "external", status: "accepted" }] }), finding({ kind: "pass" })]));
    await manifest([check({ kind: "security", report: { format: "sarif", path: reportPath } })]);
    const result = (await review()).evidence;
    expect(result.status).toBe("passed");
    expect(result.checks[0].counts).toMatchObject({ active: 0, absent: 1, suppressed: 1 });
  });

  it("does not turn failed SARIF execution or omitted results into an empty pass", async () => {
    await write(reportPath, sarif([], { invocations: [{ executionSuccessful: false }] }));
    await manifest([check({ kind: "static-analysis", report: { format: "sarif", path: reportPath } })]);
    expect((await review()).evidence.status).toBe("unavailable");
    await write(reportPath, sarif([], { results: undefined }));
    expect((await review()).evidence.status).toBe("unavailable");
  });

  it("marks conflicting embedded revision metadata unknown", async () => {
    await write(reportPath, sarif([], { versionControlProvenance: [{ revisionId: base }] }));
    await manifest([check({ kind: "static-analysis", report: { format: "sarif", path: reportPath } })]);
    expect((await review()).evidence).toMatchObject({ status: "incomplete", checks: [{ freshness: "unknown" }] });
  });

  it("resolves indexed SARIF paths and URI bases from a different CI checkout", async () => {
    await write(reportPath, sarif([finding({ locations: [{ physicalLocation: { artifactLocation: { index: 0 } } }] })], {
      artifacts: [{ location: { uri: "src/delivery.ts", uriBaseId: "SRC" } }], originalUriBaseIds: { SRC: { uri: `file://${sourceRoot}/` } },
    }));
    await manifest([check({ kind: "static-analysis", report: { format: "sarif", path: reportPath } })]);
    expect((await review()).evidence.checks[0].findings[0].locations).toEqual([{ file: "src/delivery.ts" }]);
  });

  it("retains findings with unsafe or unresolvable locations as unlocated diagnostics", async () => {
    await write(reportPath, sarif([finding({ locations: [{ physicalLocation: { artifactLocation: { uri: "../outside.ts" } } }] })]));
    await manifest([check({ kind: "static-analysis", report: { format: "sarif", path: reportPath } })]);
    const imported = (await review()).evidence.checks[0];
    expect(imported.outcome).toBe("failed");
    expect(imported.findings[0].locations).toEqual([]);
    expect(imported.findings[0].relatedChangedFiles).toEqual([]);
    expect(imported.diagnostics.join(" ")).toContain("out-of-checkout");
  });

  it("includes evidence for an empty diff and through MCP onboarding", async () => {
    await write(reportPath, testReport("failed")); await manifest([check({ exitCode: 1 })]);
    const result = await computeReview(repo, head, { evidence: [manifestPath] });
    expect(result.changedFiles).toEqual([]);
    expect(result.evidence.status).toBe("failed");
    const onboarding = JSON.parse(await masonInit(repo, { base: head, evidence: [manifestPath] }));
    expect(onboarding.review.evidence.status).toBe("failed");
  });

  it("requires explicit evidence inputs for the CI gate", async () => {
    const code = await runReviewCli(["--dir", repo, "--base", base, "--require-evidence"], { out: () => {}, err: () => {} });
    expect(code).toBe(2);
  });

  it("pins the diff and invalidates evidence if HEAD changes during review", async () => {
    await write(reportPath, testReport()); await manifest();
    vi.spyOn(snapshot, "getCurrentGitHash").mockImplementationOnce(async () => {
      await write("src/new.ts", "export const newFile = true;\n");
      await commitAll(repo, "concurrent commit");
      return head;
    });
    const result = await review();
    expect(result.changedFiles).toEqual(["src/delivery.ts"]);
    expect(result.evidence).toMatchObject({ status: "incomplete", headHash: head, summary: { unknown: 1 }, checks: [{ freshness: "unknown" }] });
    expect(result.evidence.diagnostics.join(" ")).toContain("HEAD changed during the review");
  });

  it("reports partial test execution without treating it as complete", async () => {
    const raw = testReport();
    raw.numTotalTests = 2; raw.numPendingTests = 1;
    raw.testResults[0].assertionResults.push({ fullName: "disabled test", status: "skipped", failureMessages: [] });
    await write(reportPath, raw); await manifest();
    expect((await review()).evidence).toMatchObject({ status: "incomplete", checks: [{ outcome: "passed", counts: { passed: 1, skipped: 1 } }] });
  });

  it("prioritizes active changed-file findings without losing totals when truncating", async () => {
    const results = Array.from({ length: 210 }, () => finding({ locations: [], baselineState: "absent" }));
    results.push(finding());
    await write(reportPath, sarif(results));
    await manifest([check({ kind: "duplication", report: { format: "sarif", path: reportPath } })]);
    const evidence = (await review()).evidence;
    expect(evidence.status).toBe("failed");
    expect(evidence.checks[0]).toMatchObject({ totalFindings: 211, truncated: true, counts: { active: 1, absent: 210 } });
    expect(evidence.checks[0].findings).toHaveLength(200);
    expect(evidence.checks[0].findings[0].relatedChangedFiles[0].file).toBe("src/delivery.ts");
  });

  it("combines manifests while keeping a malformed manifest visible", async () => {
    await write(reportPath, testReport()); await manifest();
    const second = ".mason/reports/second.json";
    await write(second, "invalid JSON");
    const result = await computeReview(repo, base, { evidence: [manifestPath, second] });
    expect(result.evidence.status).toBe("incomplete");
    expect(result.evidence.checks).toHaveLength(1);
    expect(result.evidence.diagnostics.join(" ")).toContain(second);
    await write(second, { version: 1, checks: [check({ id: "other-tests" })] });
    expect((await computeReview(repo, base, { evidence: [manifestPath, second] })).evidence.summary.passed).toBe(2);
  });

  it("strips terminal control sequences from imported summaries", async () => {
    await write(reportPath, testReport()); await manifest([check({ tool: "\u001b[2Jvitest", command: "test\nforged line" })]);
    const result = await cli();
    expect(result.out).not.toContain("\u001b");
    expect(result.out).toContain("test forged line");
  });
});
