import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { withMason, call } from "./knowledge/mcp.mjs";
import { git, write, records } from "./knowledge/fixture.mjs";
import { lesson } from "./knowledge/prevention-fixture.mjs";
import { select, digest } from "./knowledge/task-start-probe.mjs";
import { quote } from "./automation/fixture.mjs";
import { runHost } from "./automation/session.mjs";

const { values } = parseArgs({
  options: { output: { type: "string" }, "host-probe": { type: "boolean" } },
});
const repo = fileURLToPath(new URL("../../", import.meta.url));
const out = path.resolve(
  values.output ??
    path.join(
      repo,
      ".mason/reports/task-start-probe-" + new Date().toISOString().replaceAll(":", "-"),
    ),
);
await fs.mkdir(out, { recursive: true });
await fs.writeFile(
  path.join(out, "report.json"),
  JSON.stringify({ status: "initializing", sourceRevision: git(repo, "rev-parse", "HEAD") }),
  { flag: "wx" },
);
let activeRoot = null;
try {
  const modulePath = path.join(out, "assemble.mjs");
  const built = await build({
    entryPoints: {
      assemble: path.join(repo, "src/context/assemble.ts"),
      lexical: path.join(repo, "src/context/lexical.ts"),
    },
    outdir: out,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    absWorkingDir: repo,
  });
  const { assembleContext } = await import(pathToFileURL(modulePath).href);
  const { tokenSet } = await import(pathToFileURL(path.join(out, "lexical.mjs")).href);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-task-start-")));
  activeRoot = root;
  await write(root, "app.json", '{"schedulerDependency":false}\n');
  await write(root, "keep.pro", "");
  await write(
    root,
    "policy.md",
    "Synthetic R17 reduction: reflective constructor removed by shrinking; background scheduling requires constructor retention and release startup verification. Not an independent incident.\n",
  );
  await write(root, ".gitignore", ".mason/local/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "probe fixture");
  const mcp = path.join(repo, "dist/mason-mcp.js");
  const seed = await withMason(mcp, root, async (client) => {
    const saved = await call(client, root, "save_decision", {
      title: "Conditional scheduler startup protection",
      category: "gotcha",
      body: lesson,
      files: ["app.json", "keep.pro"],
      owner: "Synthetic Mobile team",
      sources: [{ kind: "document", reference: "policy.md" }],
    });
    if (saved.status !== "created") throw new Error("Seed creation failed");
    const prepared = await call(client, root, "review_decision", {
      id: saved.id,
      action: "prepare",
    });
    const accepted = await call(client, root, "review_decision", {
      id: saved.id,
      action: "accept",
      reviewToken: prepared.reviewToken,
      reviewer: "Laboratory fixture reviewer",
      note: "Synthetic development seed, not maintainer approval.",
    });
    if (accepted.status !== "accepted") {
      await fs.writeFile(
        path.join(out, "report.json"),
        JSON.stringify({ status: "failed seed review", root, saved, prepared, accepted }, null, 2),
      );
      throw new Error("Seed review failed: " + JSON.stringify(accepted));
    }
    return saved.id;
  });
  git(root, "add", ".");
  git(root, "commit", "-qm", "reviewed probe seed");
  const knowledgeBefore = digest(await records(root, "candidate"));
  const taskCases = [
    {
      name: "relevant",
      prompt:
        "Implement forecast refresh using the background scheduler and preserve release startup.",
      expectedRelevant: true,
    },
    {
      name: "bash",
      prompt:
        "Using Bash for inspection and edits, implement forecast refresh using the background scheduler and preserve release startup.",
      expectedRelevant: true,
    },
    {
      name: "unrelated",
      prompt: "Change the greeting from hello to welcome.",
      expectedRelevant: false,
    },
    {
      name: "weak-overlap",
      prompt: "Update the release announcement wording in the documentation.",
      expectedRelevant: false,
    },
    {
      name: "paraphrase",
      prompt: "Run weather updates periodically while the application is not open.",
      expectedRelevant: true,
    },
  ];
  const rows = [];
  for (const task of taskCases) {
    const bundle = await assembleContext(root, task.prompt);
    const result = select(bundle);
    rows.push({
      ...task,
      ...result,
      relevantSeedSelected: result.selected.some((d) => d.id === seed),
      rawMatches: Object.entries(bundle.decisions).map(([id, d]) => ({
        id,
        score: d.score,
        approval: d.approval,
        sharedTokens: [...tokenSet(task.prompt)].filter((token) =>
          tokenSet([d.title, d.body, ...d.files.map((f) => path.basename(f))].join(" ")).has(token),
        ),
      })),
    });
  }
  const tracked = [
    ...new Set([
      ...Object.keys(built.metafile.inputs),
      "bench/harness/run-task-start-probe.mjs",
      "bench/harness/knowledge/task-start-probe.mjs",
      "bench/harness/knowledge/prevention-fixture.mjs",
      "bench/harness/knowledge/mcp.mjs",
      "bench/harness/knowledge/fixture.mjs",
      "bench/harness/automation/fixture.mjs",
      "bench/harness/automation/session.mjs",
      "bench/harness/knowledge/TASK_START_EXPERIMENT.md",
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
  const report = {
    version: 1,
    status: "selection completed",
    sourceRevision: git(repo, "rev-parse", "HEAD"),
    nodeVersion: process.version,
    root,
    fingerprints: await fingerprints(),
    bundleDigest: digest(await fs.readFile(modulePath, "utf8")),
    seed,
    rows,
    matchingDisagreements: rows
      .filter((r) => r.expectedRelevant !== r.relevantSeedSelected)
      .map((r) => r.name),
    hostProbe: null,
    scope:
      "Harness-only selection characterization and optional synthetic consumption probe; no patch-outcome claim.",
  };
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  if (values["host-probe"]) {
    const nonce = "probe-" + randomUUID();
    const hookLog = path.join(out, "hooks.jsonl");
    const command = [
      process.execPath,
      path.join(repo, "bench/harness/knowledge/task-start-probe.mjs"),
      modulePath,
      root,
      hookLog,
      nonce,
    ]
      .map(quote)
      .join(" ");
    await write(
      root,
      ".claude/settings.json",
      JSON.stringify(
        { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 30 }] }] } },
        null,
        2,
      ),
    );
    const prompt =
      "Implement forecast refresh using the background scheduler and preserve release startup. This is a delivery probe: make no edits or tool calls. Return the laboratory delivery marker from injected context verbatim, and summarize the accepted engineering lesson if present.";
    report.hostProbe = {
      hostVersion: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
      budgetUsd: 1,
      timeoutMs: 180000,
      session: await runHost({
        host: "claude",
        arm: "hooks",
        cwd: root,
        prompt,
        controlled: true,
        budgetUsd: 1,
        timeoutMs: 180000,
        transcript: path.join(out, "transcript.jsonl"),
      }),
    };
    const receipts = (await fs.readFile(hookLog, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    report.hostProbe.receipts = receipts;
    const events = (await fs.readFile(path.join(out, "transcript.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    report.hostProbe.toolCalls = events
      .flatMap((e) =>
        e.type === "assistant"
          ? (e.message?.content ?? []).filter((c) => c.type === "tool_use")
          : [],
      )
      .map((c) => c.name);
    report.hostProbe.markerConsumed =
      report.hostProbe.session.ok &&
      report.hostProbe.session.result?.includes(nonce) === true &&
      receipts.some((r) => r.marker === nonce && r.selected.some((d) => d.id === seed));
    report.hostProbe.limitation =
      "Prompt explicitly asks for a random hook-only marker; this establishes synthetic consumption, not spontaneous lesson use or prevention.";
  }
  report.knowledgeUnchanged = knowledgeBefore === digest(await records(root, "candidate"));
  report.fingerprintsUnchanged =
    JSON.stringify(report.fingerprints) === JSON.stringify(await fingerprints());
  report.status = "completed";
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      output: out,
      disagreements: report.matchingDisagreements,
      knowledgeUnchanged: report.knowledgeUnchanged,
      fingerprintsUnchanged: report.fingerprintsUnchanged,
      hostProbe: report.hostProbe && {
        ok: report.hostProbe.session.ok,
        markerConsumed: report.hostProbe.markerConsumed,
        costUsd: report.hostProbe.session.costUsd,
      },
    }),
  );
  if (
    !report.knowledgeUnchanged ||
    !report.fingerprintsUnchanged ||
    (report.hostProbe && !report.hostProbe.markerConsumed)
  )
    process.exitCode = 1;
} catch (error) {
  const previous = JSON.parse(await fs.readFile(path.join(out, "report.json"), "utf8"));
  await fs.writeFile(
    path.join(out, "report.json"),
    JSON.stringify(
      { ...previous, status: "failed", root: activeRoot, error: String(error.stack ?? error) },
      null,
      2,
    ),
  );
  console.error(String(error.stack ?? error));
  process.exitCode = 1;
}
