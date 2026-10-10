import { expect, it } from "vitest";
import type { RepairFinding } from "../src/audit/repair.js";
import {
  completionFindings,
  completionSummary,
  createNotificationState,
  notificationStateSchema,
} from "../src/automation/notifications.js";

function finding(id: string): RepairFinding {
  const source = {
    type: "deleted-reference" as const,
    confidence: "certain" as const,
    message: `Missing src/${id}.ts`,
    anchor: { doc: "README.md", line: 1, excerpt: null },
    evidence: {
      kind: "missing-path" as const,
      claimed: `src/${id}.ts`,
      renamedTo: null,
      deletedInCommit: null,
      everTracked: true,
      parentDirExists: true,
    },
  };
  return { id, original: source, current: source, status: "unresolved", reason: "Still missing" };
}

it("delivers overflow at later completions without losing it across a restart", () => {
  const findings = Array.from({ length: 7 }, (_, i) => finding(`file${i}`));
  let state = createNotificationState([], "head");
  const first = completionFindings(state, findings);
  expect(completionSummary(first, "report.json")).toContain("3 more in the report");
  expect(completionSummary(first, "report.json")).not.toContain("src/file4.ts");
  expect(Object.keys(state.delivered)).toHaveLength(4);
  state = notificationStateSchema.parse(JSON.parse(JSON.stringify(state)));
  const next = completionFindings(state, findings);
  expect(next.map((f) => f.id)).toEqual(["file4", "file5", "file6"]);
  expect(completionSummary(next, "report.json")).toContain("src/file6.ts");
  expect(completionFindings(state, findings)).toEqual([]);
});

it("retains delivery history through absent or unverified evidence and reopens confirmed resolutions", () => {
  const item = finding("one");
  const state = createNotificationState([], "head");
  expect(completionFindings(state, [item])).toHaveLength(1);
  expect(completionFindings(state, [])).toEqual([]);
  expect(completionFindings(state, [{ ...item, status: "unverified" }])).toEqual([]);
  expect(completionFindings(state, [item])).toEqual([]);
  expect(completionFindings(state, [{ ...item, status: "resolved" }])).toEqual([]);
  expect(completionFindings(state, [item])).toHaveLength(1);
});

it("keeps baseline backlog quiet but reports escalation and recurrence", () => {
  const item = finding("one");
  const state = createNotificationState([item], "head");
  expect(completionFindings(state, [item])).toEqual([]);
  completionFindings(state, [{ ...item, status: "resolved" }]);
  expect(completionFindings(state, [item])).toHaveLength(1);
  expect(completionFindings(state, [item])).toEqual([]);
});
