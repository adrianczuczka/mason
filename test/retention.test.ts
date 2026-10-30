import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { automate, observeDecisionLifecycle } from "../src/automation/runtime.js";
import { workspace } from "../src/automation/evidence.js";
import {
  CHECK_REPORT_PRUNE_THRESHOLD,
  RETAINED_CHECK_REPORTS,
} from "../src/automation/retention.js";
import { commitAll, initGitRepo } from "./helpers.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-retention-"));
  await initGitRepo(root);
  await fs.writeFile(path.join(root, "README.md"), "# Fixture\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".mason/reports/\n");
  await commitAll(root, "fixture");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("keeps recent and referenced check reports and prunes the rest", async () => {
  const audit = await automate(root, { event: "task_end" });
  const ws = await workspace(root);
  const checks = path.join(root, ws.directory, "checks");
  const old = new Date("2026-01-01T00:00:00Z");
  await fs.utimes(path.join(root, audit.report.reportPath), old, old);
  const receiptReport = ws.directory + "/checks/" + randomUUID() + ".json";
  await fs.writeFile(path.join(root, receiptReport), "{}\n");
  await fs.utimes(path.join(root, receiptReport), old, old);
  await fs.writeFile(
    path.join(root, ws.directory, "setup-claude.json"),
    JSON.stringify({ initialReportPath: receiptReport }),
  );
  await fs.writeFile(path.join(checks, "notes.txt"), "not a report\n");
  const filler = CHECK_REPORT_PRUNE_THRESHOLD + 50;
  for (let n = 0; n < filler; n++) {
    const file = path.join(checks, `guidance-${randomUUID()}.json`);
    await fs.writeFile(file, "{}\n");
    const at = new Date(Date.UTC(2026, 1, 1, 0, 0, n));
    await fs.utimes(file, at, at);
  }

  const guidance = await observeDecisionLifecycle(root, { event: "task_end" });
  const remaining = await fs.readdir(checks);
  const reports = remaining.filter((name) => name.endsWith(".json"));
  expect(reports.length).toBeLessThanOrEqual(RETAINED_CHECK_REPORTS + 2);
  expect(remaining).toContain(path.basename(guidance.report.reportPath));
  expect(remaining).toContain(path.basename(audit.report.reportPath));
  expect(remaining).toContain(path.basename(receiptReport));
  expect(remaining).toContain("notes.txt");
  // The audit pointer still reads after pruning.
  expect((await automate(root, { event: "session_start" })).report.status).not.toBe("unavailable");
}, 60000);

it("leaves a small report directory unscanned", async () => {
  await automate(root, { event: "task_end" });
  const ws = await workspace(root);
  const checks = path.join(root, ws.directory, "checks");
  for (let n = 0; n < CHECK_REPORT_PRUNE_THRESHOLD - 5; n++)
    await fs.writeFile(path.join(checks, `${randomUUID()}.json`), "{}\n");
  const before = (await fs.readdir(checks)).length;
  await observeDecisionLifecycle(root, { event: "task_end" });
  expect((await fs.readdir(checks)).length).toBe(before + 1);
}, 60000);
