import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cases,
  arms,
  prompts,
  template,
  forkFixture,
  replay,
  grade,
} from "./knowledge/cancellation-lifecycle.mjs";
import { git, receipts } from "./knowledge/fixture.mjs";
import { withMason, call } from "./knowledge/mcp.mjs";
import { runHost } from "./automation/session.mjs";
const { values } = parseArgs({
  options: { validate: { type: "boolean" }, live: { type: "boolean" }, output: { type: "string" } },
});
if (Number(!!values.validate) + Number(!!values.live) !== 1)
  throw new Error("Select --validate or --live");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const out = path.resolve(
  values.output ??
    path.join(
      repo,
      ".mason/reports/cancellation-lifecycle-" + new Date().toISOString().replaceAll(":", "-"),
    ),
);
await fs.mkdir(out, { recursive: true });
const reportPath = path.join(out, "report.json");
await fs.writeFile(reportPath, "{}", { flag: "wx" });
const tracked = [
  "bench/harness/run-cancellation-lifecycle.mjs",
  "bench/harness/knowledge/cancellation-lifecycle.mjs",
  "bench/harness/knowledge/cancellation-check.mjs",
  "bench/harness/knowledge/cancellation-submission.mjs",
  "bench/harness/knowledge/observe-cancellation-hook.mjs",
  "bench/harness/knowledge/observe-mcp.mjs",
  "bench/harness/knowledge/prevention-fixture.mjs",
  "bench/harness/knowledge/fixture.mjs",
  "bench/harness/knowledge/mcp.mjs",
  "bench/harness/automation/fixture.mjs",
  "bench/harness/automation/session.mjs",
  "bench/harness/knowledge/CANCELLATION_LIFECYCLE_EXPERIMENT.md",
  "dist/mason.js",
  "dist/mason-mcp.js",
  "dist/mason-runtime.js",
];
const fingerprint = async () =>
  Object.fromEntries(
    await Promise.all(
      tracked.map(async (file) => [
        file,
        createHash("sha256")
          .update(await fs.readFile(path.join(repo, file)))
          .digest("hex"),
      ]),
    ),
  );
const report = {
  version: 1,
  mode: values.live ? "live" : "validation",
  sourceRevision: git(repo, "rev-parse", "HEAD"),
  nodeVersion: process.version,
  hostVersion: values.live
    ? execFileSync("claude", ["--version"], { encoding: "utf8" }).trim()
    : "not used",
  fingerprints: await fingerprint(),
  workspace: await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mason-cancellation-lifecycle-")),
  ),
  schedule: cases.flatMap((scenario, i) =>
    (i % 2 ? [...arms].reverse() : arms).map((arm) => ({ scenario, arm })),
  ),
  maxConfiguredHostSpendUsd: values.live ? 8 : 0,
  limits: {
    budgetUsd: 1,
    timeoutMs: 180000,
    model: "configured default",
    effort: "configured default",
  },
  rows: [],
  templates: {},
  semanticReview: "pending; coordinating reviewer is unblinded",
};
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});
process.on("SIGTERM", () => {
  stop = true;
});
await save();
console.log("Output: " + out);
try {
  const binary = path.join(repo, "dist/mason.js"),
    mcp = path.join(repo, "dist/mason-mcp.js");
  const observer = path.join(repo, "bench/harness/knowledge/observe-cancellation-hook.mjs");
  const mcpObserver = path.join(repo, "bench/harness/knowledge/observe-mcp.mjs");
  for (const cell of report.schedule) {
    if (stop) {
      report.stopReason = "Interrupted; no automatic retry.";
      break;
    }
    if (JSON.stringify(report.fingerprints) !== JSON.stringify(await fingerprint()))
      throw new Error("Fingerprint changed; start a new run");
    if (!report.templates[cell.scenario])
      report.templates[cell.scenario] = await template(
        path.join(report.workspace, cell.scenario + "-template"),
        cell.scenario,
        mcp,
      );
    const id = cell.scenario + "-" + cell.arm;
    const root = path.join(report.workspace, id),
      hookLog = path.join(out, id + "-hooks.jsonl"),
      mcpLog = path.join(out, id + "-mcp.jsonl");
    const row = { ...cell, id, root, hookLog, mcpLog, status: "running" };
    report.rows.push(row);
    await save();
    console.log("Running " + id);
    try {
      row.initial = await forkFixture(report.templates[cell.scenario], root, cell.arm, {
        binary,
        observer,
        hookLog,
      });
      const observerArgs = [
        mcpObserver,
        mcp,
        root,
        mcpLog,
        '["operation.mjs","managed.mjs","greeting.txt"]',
      ];
      if (values.validate) {
        const fire = (event) =>
          execFileSync(process.execPath, [observer, cell.arm, binary, hookLog], {
            cwd: root,
            input: JSON.stringify({ cwd: root, session_id: id, hook_event_name: event }),
            encoding: "utf8",
            timeout: 40000,
          });
        fire("SessionStart");
        fire("UserPromptSubmit");
        if (cell.arm === "mason" && cell.scenario !== "unrelated")
          await withMason(
            mcpObserver,
            root,
            (c) =>
              call(c, root, "get_context", {
                task: prompts[cell.scenario],
                files: ["operation.mjs", "managed.mjs"],
              }),
            observerArgs,
          );
        await replay(root, cell.scenario);
        fire("Stop");
        row.session = { ok: true, kind: "reference replay", elapsedMs: 0, costUsd: 0 };
      } else
        row.session = await runHost({
          host: "claude",
          arm: "hooks",
          cwd: root,
          prompt: prompts[cell.scenario],
          controlled: true,
          budgetUsd: 1,
          timeoutMs: 180000,
          transcript: path.join(out, id + "-transcript.jsonl"),
          mcpConfig: {
            mcpServers:
              cell.arm === "mason"
                ? { mason: { command: process.execPath, args: observerArgs } }
                : {},
          },
        });
      row.grade = await grade(root, row.initial, row.session, await receipts(mcpLog));
      row.hookEvents = await receipts(hookLog);
      row.status = "completed";
      console.log(id + ": " + row.grade.pass);
    } catch (error) {
      row.status = "failed";
      row.error = String(error.stack ?? error);
      console.error(row.error);
    }
    await save();
  }
  report.fingerprintsUnchanged =
    JSON.stringify(report.fingerprints) === JSON.stringify(await fingerprint());
  report.pass =
    report.rows.length === report.schedule.length &&
    report.rows.every((r) => r.grade?.pass) &&
    report.fingerprintsUnchanged;
  report.status = report.stopReason ? "interrupted" : "completed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack ?? error);
  console.error(report.error);
}
await save();
if (!report.pass) process.exitCode = 1;
