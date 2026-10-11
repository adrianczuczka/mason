import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { withMason, call } from "./knowledge/mcp.mjs";
import { git, write, records } from "./knowledge/fixture.mjs";
import { digest, select } from "./knowledge/task-start-probe.mjs";
import { lessons, tasks, rules, evidence } from "./knowledge/selection-grid.mjs";

const { values } = parseArgs({ options: { output: { type: "string" } } });
const repo = fileURLToPath(new URL("../../", import.meta.url));
const out = path.resolve(
  values.output ??
    path.join(
      repo,
      ".mason/reports/selection-grid-" + new Date().toISOString().replaceAll(":", "-"),
    ),
);
await fs.mkdir(out, { recursive: true });
const reportPath = path.join(out, "report.json");
await fs.writeFile(reportPath, JSON.stringify({ status: "initializing" }), { flag: "wx" });
const report = {
  version: 1,
  sourceRevision: git(repo, "rev-parse", "HEAD"),
  nodeVersion: process.version,
  tasks,
  lessons,
  rules: Object.keys(rules),
  rows: [],
  scope:
    "Unblinded synthetic selection development. No model calls, patches, production changes or outcome claims.",
};
try {
  const built = await build({
    entryPoints: { assemble: "src/context/assemble.ts", lexical: "src/context/lexical.ts" },
    outdir: out,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    absWorkingDir: repo,
  });
  const { assembleContext } = await import(pathToFileURL(path.join(out, "assemble.mjs")).href);
  const { tokenSet } = await import(pathToFileURL(path.join(out, "lexical.mjs")).href);
  const tracked = [
    ...new Set([
      ...Object.keys(built.metafile.inputs),
      "bench/harness/run-selection-grid.mjs",
      "bench/harness/knowledge/selection-grid.mjs",
      "bench/harness/knowledge/task-start-probe.mjs",
      "bench/harness/knowledge/prevention-fixture.mjs",
      "bench/harness/knowledge/fixture.mjs",
      "bench/harness/knowledge/mcp.mjs",
      "dist/mason-mcp.js",
      "dist/mason-runtime.js",
    ]),
  ];
  const fingerprints = async () =>
    Object.fromEntries(
      await Promise.all(
        tracked.map(async (f) => [f, digest(await fs.readFile(path.join(repo, f), "utf8"))]),
      ),
    );
  report.fingerprints = await fingerprints();
  report.root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mason-selection-grid-")),
  );
  const root = report.root;
  for (const file of [...new Set(lessons.flatMap((d) => d.files))])
    await write(root, file, "Synthetic selection anchor; not independent incident evidence.\n");
  await write(root, "policy.md", lessons.map((d) => `## ${d.title}\n${d.body}`).join("\n"));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "synthetic selection facts");
  const ids = {};
  await withMason(path.join(repo, "dist/mason-mcp.js"), root, async (client) => {
    for (const d of lessons) {
      const saved = await call(client, root, "save_decision", {
        title: d.title,
        body: d.body,
        files: d.files,
        category: "gotcha",
        owner: "Synthetic fixture team",
        sources: [{ kind: "document", reference: "policy.md" }],
      });
      if (saved.status !== "created")
        throw new Error("Seed creation failed: " + JSON.stringify(saved));
      const prepared = await call(client, root, "review_decision", {
        id: saved.id,
        action: "prepare",
      });
      const accepted = await call(client, root, "review_decision", {
        id: saved.id,
        action: "accept",
        reviewToken: prepared.reviewToken,
        reviewer: "Synthetic fixture reviewer",
        note: "Development selection fixture, not real team approval.",
      });
      if (accepted.status !== "accepted")
        throw new Error("Seed acceptance failed: " + JSON.stringify(accepted));
      ids[saved.id] = d.key;
    }
  });
  git(root, "add", ".");
  git(root, "commit", "-qm", "review synthetic selection records");
  const knowledge = digest(await records(root, "candidate"));
  report.ids = ids;
  for (const task of tasks) {
    const bundle = await assembleContext(root, task.prompt);
    const matches = Object.entries(bundle.decisions);
    for (const [name, rule] of Object.entries(rules)) {
      const filtered = {
        ...bundle,
        decisions: Object.fromEntries(matches.filter(([, d]) => rule(task.prompt, d, tokenSet))),
      };
      const result = select(filtered);
      const actual = result.selected.map((d) => ids[d.id]);
      report.rows.push({
        name: task.name,
        rule: name,
        expected: task.expected,
        actual,
        falsePositives: actual.filter((key) => !task.expected.includes(key)),
        misses: task.expected.filter((key) => !actual.includes(key)),
        bytes: result.bytes,
        omitted: result.omitted,
        rawMatches: matches.map(([id, d]) => ({
          key: ids[id],
          score: d.score,
          ...evidence(task.prompt, d, tokenSet),
        })),
      });
    }
  }
  report.summary = Object.fromEntries(
    Object.keys(rules).map((rule) => {
      const rows = report.rows.filter((r) => r.rule === rule);
      return [
        rule,
        {
          exactTasks: rows.filter((r) => !r.falsePositives.length && !r.misses.length).length,
          taskCount: rows.length,
          falsePositiveBodies: rows.reduce((n, r) => n + r.falsePositives.length, 0),
          missedLessons: rows.reduce((n, r) => n + r.misses.length, 0),
          emittedBytes: rows.reduce((n, r) => n + r.bytes, 0),
        },
      ];
    }),
  );
  report.knowledgeUnchanged = knowledge === digest(await records(root, "candidate"));
  report.fingerprintsUnchanged =
    JSON.stringify(report.fingerprints) === JSON.stringify(await fingerprints());
  report.status = "completed";
  if (!report.knowledgeUnchanged || !report.fingerprintsUnchanged)
    throw new Error("Integrity gate failed");
  console.log(JSON.stringify({ output: out, summary: report.summary }));
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
}
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
