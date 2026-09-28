import { expect, it } from "vitest";
import { completionFindings, completionSummary, createNotificationState } from "../src/automation/notifications.js";
import { findingId, type Finding } from "../src/audit/findings.js";
import type { RepairFinding } from "../src/audit/repair.js";

const finding = (source: Finding): RepairFinding => ({ id: findingId(source), original: source, current: source,
  status: "confidence" in source ? "unresolved" : "review-required", reason: "Check still reports this condition." });
const count = (actual: number) => finding({ type: "stale-count", confidence: "certain", message: `There are ${actual} modules`,
  anchor: { doc: "README.md", line: 4, excerpt: "2 modules" },
  evidence: { kind: "count-mismatch", claimed: 2, actual, unit: "modules", countedFrom: "workspaces", members: [] } });
const decision = (paths: string[], revision = 1) => finding({ type: "decision-anchor-drift", message: "anchor changed",
  anchor: { doc: ".mason/decisions/build.json", line: null, excerpt: "Build convention" },
  evidence: { kind: "decision-anchor", decisionId: "build", title: "Build convention", changedFiles: paths, refreshedHash: "a".repeat(40),
    provenance: { approval: "proposed", revision, owner: null, sources: [], guidance: "Inspect evidence", reviewRequired: true, lastReview: null } } });

it("ignores presentation changes and detects a worsening count under the same finding ID", () => {
  const original = count(3);
  const state = createNotificationState([original], "baseline");
  const wording = count(3);
  wording.current!.message = "different wording";
  wording.current!.anchor.line = 50;
  wording.reason = "Different report bookkeeping";
  expect(completionFindings(state, [wording])).toEqual([]);
  const worse = count(5);
  expect(worse.id).toBe(original.id);
  expect(completionFindings(state, [worse])).toEqual([worse]);
  expect(completionFindings(state, [worse])).toEqual([]);
  expect(completionFindings(state, [count(4)])).toEqual([]);
  // Returning to the already reported magnitude is not another interruption.
  expect(completionFindings(state, [worse])).toEqual([]);
  expect(completionFindings(state, [count(6)])).toHaveLength(1);
  expect(state.baseline).toEqual(createNotificationState([original], "baseline").baseline);
});

it("keeps decision metadata changes quiet and treats additional anchors as advisory", () => {
  const original = decision(["build.gradle.kts"]);
  const state = createNotificationState([original], "baseline");
  expect(completionFindings(state, [decision(["build.gradle.kts"], 2)])).toEqual([]);
  const changed = decision(["settings.gradle.kts", "build.gradle.kts"], 2);
  const selected = completionFindings(state, [changed]);
  expect(selected).toHaveLength(1);
  expect(selected[0].id).toBe(changed.id);
  expect(selected[0].current?.evidence).toMatchObject({ changedFiles: ["build.gradle.kts", "settings.gradle.kts"] });
  expect(completionFindings(state, [decision(["build.gradle.kts", "settings.gradle.kts"], 2)])).toEqual([]);
  const summary = completionSummary([changed], "report.json");
  expect(summary).toContain("[advisory]");
  expect(summary).toContain("acceptance is not required");
  expect(summary).not.toContain("needs human review");
});

it("does not treat verification loss as a new issue or erase its delivered notice", () => {
  const state = createNotificationState([], "baseline");
  const issue = count(3);
  const unknown: RepairFinding = { ...issue, current: undefined, status: "unverified" };
  expect(completionFindings(state, [unknown])).toEqual([]);
  expect(completionFindings(state, [issue])).toEqual([issue]);
  expect(completionFindings(state, [unknown])).toEqual([]);
  expect(completionFindings(state, [issue])).toEqual([]);
});

it("retains notification history through serialization and reopens resolved backlog findings", () => {
  const issue = count(3);
  const state = createNotificationState([issue], "baseline");
  expect(completionFindings(state, [issue])).toEqual([]);
  expect(completionFindings(state, [{ ...issue, status: "resolved", current: undefined }])).toEqual([]);
  const restarted = JSON.parse(JSON.stringify(state));
  expect(completionFindings(restarted, [issue])).toEqual([issue]);
  expect(completionFindings(JSON.parse(JSON.stringify(restarted)), [issue])).toEqual([]);
});

it("recognizes an advisory escalating into a concrete issue", () => {
  const issue = count(3);
  const { confidence, ...source } = issue.original as Extract<Finding, { confidence: unknown }>;
  const advisory = finding(source);
  const state = createNotificationState([advisory], "baseline");
  expect(completionFindings(state, [issue])).toEqual([issue]);
});

it("ignores dependency commit churn and surfaces a changed matched declaration", () => {
  const dependency = (after: string, hash: string) => finding({ type: "deps-changed", message: "dependency changed",
    anchor: { doc: "README.md", line: 1, excerpt: "typescript" },
    evidence: { kind: "doc-behind-manifests", docLastCommit: { hash, date: "today", subject: "docs" }, manifestCommits: [], totalCommits: 42,
      matches: [{ manifest: "package.json", dependency: "typescript", before: "4", after, line: 1, excerpt: "typescript" }] } });
  const state = createNotificationState([dependency("5", "a")], "baseline");
  expect(completionFindings(state, [dependency("5", "b")])).toEqual([]);
  expect(completionFindings(state, [dependency("6", "c")])).toHaveLength(1);
});

it("coalesces current decision revisions and prevents old resolved revisions from erasing delivery", () => {
  const state = createNotificationState([], "baseline");
  const first = decision(["build.gradle.kts"], 1);
  const next = decision(["settings.gradle.kts"], 2);
  const selected = completionFindings(state, [first, next]);
  expect(selected).toHaveLength(1);
  expect(completionSummary(selected, "report.json")).toContain("build.gradle.kts, settings.gradle.kts");
  expect(completionFindings(state, [next, first])).toEqual([]);
  expect(completionFindings(state, [next, { ...first, current: undefined, status: "resolved" }])).toEqual([]);
  expect(completionFindings(state, [next])).toEqual([]);
  const third = decision(["settings.gradle.kts", "src/main.ts"], 3);
  expect(completionFindings(state, [third, { ...first, current: undefined, status: "unverified" }])).toHaveLength(1);
  expect(completionFindings(state, [third])).toEqual([]);
});
