#!/usr/bin/env node
// Run this repository's Vitest suite and record the observed run for mason-review.
// This is a CI producer; the review importer itself never runs commands.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = process.cwd();
function checkout() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  return { commit: head.status === 0 ? head.stdout.trim() : null,
    clean: status.status === 0 ? status.stdout.length === 0 : null };
}
const before = checkout();
const reportPath = `.mason/reports/${randomUUID()}/vitest.json`;
const manifestPath = path.join(root, ".mason/reports/evidence.json");
await fs.mkdir(path.dirname(path.join(root, reportPath)), { recursive: true });
const args = ["node_modules/vitest/vitest.mjs", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`];
const check = { id: "unit-tests", kind: "tests", tool: "vitest", command: `node ${args.join(" ")}`,
  commit: before.commit, sourceRoot: root, workingTreeClean: before.clean === true,
  ...(process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? { source: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}),
  report: { format: "vitest-json", path: reportPath },
};
async function save(value) {
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, checks: [value] }, null, 2) + "\n");
  await fs.rename(temporary, manifestPath);
}
// Invalidate any previous manifest before starting. Interrupted runs stay unavailable.
await save({ ...check, status: "unavailable", reason: "Test run has not completed." });
const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
const after = checkout();
await save({ ...check, workingTreeClean: before.clean === true && after.clean === true && before.commit === after.commit,
  exitCode: result.status,
  status: result.status === null ? "unavailable" : "completed",
  ...(result.status === null ? { reason: result.error?.message ?? `Test process stopped by ${result.signal ?? "an unknown cause"}.` } : {}),
});
process.stdout.write(`Evidence manifest: ${manifestPath}\n`);
process.exitCode = result.status ?? 2;
