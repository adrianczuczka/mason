#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runSession } from "./lib/session.mjs";
import { loadAdapter } from "./lib/adapter.mjs";
import { selectTasks } from "./patches/tasks.mjs";
import { capturePatch, digest, prepareFixture } from "./patches/fixture.mjs";
import { gradePatch } from "./patches/grade.mjs";
import { validateTasks } from "./patches/validate.mjs";
import { writeReport } from "./patches/report.mjs";

const HARNESS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HARNESS, "../..");
const SYSTEM = "Implement the requested code change in this checkout. Read its CLAUDE.md and relevant engineering history. " +
  "Inspect current code when guidance is stale, unknown, or unrelated. Run the public tests. " +
  "Only edit source and tests; do not modify existing public tests, package/config files, context documents, or Mason metadata. " +
  "Do not commit, install dependencies, access the network, spawn other agents/background work, or read outside this checkout. " +
  "Finish with a concise summary of the patch, tests, and any constraints that changed or prevented your approach. " +
  "An independent evaluator will assess observable behavior; no particular implementation is required.";

export function parsePatchArgs(argv) {
  const options = { arms: ["baseline", "mason"], repeats: 1, maxTurns: 24, timeoutSeconds: 240, budgetPerSession: 1 };
  const values = { "--tasks": "tasks", "--arms": "arms", "--repeats": "repeats", "--model": "model", "--adapter": "adapter", "--max-turns": "maxTurns", "--timeout-seconds": "timeoutSeconds", "--budget-per-session": "budgetPerSession", "--output": "output", "--report": "report", "--review": "review" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--validate") { options.validate = true; continue; }
    if (flag === "--help") { options.help = true; continue; }
    const key = values[flag], value = argv[++i];
    if (!key || !value || value.startsWith("--")) throw new Error(`Unknown flag or missing value: ${flag}`);
    options[key] = ["tasks", "arms"].includes(key) ? value.split(",") : ["repeats", "maxTurns", "timeoutSeconds", "budgetPerSession"].includes(key) ? Number(value) : value;
  }
  for (const key of ["repeats", "maxTurns", "timeoutSeconds", "budgetPerSession"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0 || (key !== "budgetPerSession" && !Number.isInteger(options[key]))) throw new Error(`${key} must be a positive ${key === "budgetPerSession" ? "number" : "integer"}`);
  }
  if (new Set(options.arms).size !== options.arms.length || options.arms.some(a => !["baseline", "mason"].includes(a))) throw new Error("Arms must be baseline and/or mason, without duplicates");
  if (options.review && !options.report) throw new Error("--review requires --report results.json");
  if (options.report && (options.validate || options.output)) throw new Error("--report cannot be combined with --validate or --output");
  if (options.adapter && !options.model && !options.validate && !options.help && !options.report) throw new Error("--model is required with a custom adapter");
  options.model ??= "sonnet";
  selectTasks(options.tasks);
  return options;
}

const HELP = `Run actual patch tasks in isolated checkouts; grade with held-out tests.

node bench/harness/run-patches.mjs --validate             # offline fixture/grader checks
node bench/harness/run-patches.mjs                        # ten tasks, both arms, one repeat
node bench/harness/run-patches.mjs --tasks webhook-retry,health-label
node bench/harness/run-patches.mjs --repeats 3 --model <full-model-id>
node bench/harness/run-patches.mjs --adapter <config.json> --model <model-id>
node bench/harness/run-patches.mjs --report <results.json> --review <review.json>

Options: --arms baseline,mason --max-turns 24 --timeout-seconds 240
         --budget-per-session 1 --output <new-directory>
The built-in driver uses Claude. --adapter selects any coding agent through a
JSON subprocess protocol; see patches/README.md. No model is needed to validate.
Results, raw transcripts, session summaries, patches, and review templates are
written under bench/harness/results/patches/<run-id>/ by default.
`;

async function provenance() {
  const files = ["run-patches.mjs", "lib/session.mjs", "lib/adapter.mjs", ...(await fs.readdir(path.join(HARNESS, "patches"))).filter(f => f.endsWith(".mjs")).sort().map(f => `patches/${f}`)];
  const texts = await Promise.all(files.map(async f => [f, await fs.readFile(path.join(HARNESS, f), "utf8")]));
  return { suiteDigest: digest(JSON.stringify(texts)), sources: texts };
}

async function checkpoint(directory, run) {
  const file = path.join(directory, "results.json");
  const temporary = file + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(run, null, 2) + "\n");
  await fs.rename(temporary, file);
  await writeReport(directory, run);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parsePatchArgs(argv);
  if (options.help) { console.log(HELP); return; }
  if (options.report) {
    const file = path.resolve(options.report);
    const run = JSON.parse(await fs.readFile(file, "utf8"));
    const review = options.review ? JSON.parse(await fs.readFile(options.review, "utf8")) : undefined;
    await writeReport(path.dirname(file), run, review);
    console.log(`Report: ${path.join(path.dirname(file), "report.md")}`);
    return;
  }
  const selected = selectTasks(options.tasks);
  const validation = await validateTasks(selected, r => console.log(`Validated ${r.task}: reference passes; bad patch rejected`));
  if (options.validate) {
    if (options.output) {
      const directory = path.resolve(options.output);
      await fs.mkdir(path.dirname(directory), { recursive: true });
      await fs.mkdir(directory);
      const source = await provenance();
      await fs.writeFile(path.join(directory, "validation.json"), JSON.stringify({ version: 1, mode: "offline-validation", suiteDigest: source.suiteDigest, agentSessions: 0, results: validation }, null, 2) + "\n");
      await fs.writeFile(path.join(directory, "report.md"), "# Offline patch-suite validation\n\nNo coding-agent sessions were run. This validates the fixtures and graders; it is not a Mason effectiveness comparison.\n\n| Task | Original | Reference | Deliberately wrong patch |\n|---|---|---|---|\n" + validation.map(r => `| ${r.task} | fails | passes | rejected: ${r.mutations.map(m => m.id).join(", ")} |`).join("\n") + "\n");
      console.log(`Validation report: ${path.join(directory, "report.md")}`);
    }
    console.log(`${validation.length} patch tasks validated without model calls.`);
    return;
  }

  const executable = path.join(ROOT, "dist/mason-mcp.js");
  const build = options.arms.includes("mason") ? await fs.readFile(executable) : null;
  const adapter = options.adapter ? await loadAdapter(path.resolve(options.adapter)) : null;
  const cliVersion = adapter ? `${adapter.name} ${adapter.version}` : execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15000 }).trim();
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = options.output ? path.resolve(options.output) : path.join(HARNESS, "results/patches", id);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory);
  const source = await provenance();
  await fs.writeFile(path.join(directory, "harness-sources.json"), JSON.stringify(source.sources, null, 2) + "\n");
  // Preserve the exact bundled server evaluated even if the working build changes.
  const serverFile = path.join(directory, "mason-mcp.mjs");
  if (build) {
    await fs.writeFile(serverFile, build);
    await fs.symlink(path.join(ROOT, "node_modules"), path.join(directory, "node_modules"), "dir");
  }
  const run = {
    version: 1, id, status: "running", startedAt: new Date().toISOString(), options,
    suiteDigest: source.suiteDigest, masonBuildDigest: build ? digest(build) : null,
    dependencyLockDigest: digest(await fs.readFile(path.join(ROOT, "package-lock.json"))),
    cliVersion, agent: adapter ?? { name: "claude", version: cliVersion }, nodeVersion: process.version,
    harnessCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    harnessDirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim(),
    protocol: { type: "controlled-pilot", scoring: "all task, companion, constraint and regression checks plus public tests and fixture integrity",
      falsePositives: "human-reviewed unnecessary interventions on negative controls; pending until reviewed",
      retries: 0, knowledgeSetup: "curated, identical facts; excludes real map generation and maintenance cost",
      limits: "not evidence of production effectiveness or multi-session learning" },
    validation, results: [],
  };
  await checkpoint(directory, run);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mason-patch-run-"));
  console.log(`Run: ${directory}\n${selected.length * options.arms.length * options.repeats} sessions, budget limit $${options.budgetPerSession} each; no automatic retries.`);
  try {
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      for (const [index, task] of selected.entries()) {
        // Alternate which arm runs first to reduce systematic order effects.
        const order = (index + repeat) % 2 ? options.arms : [...options.arms].reverse();
        for (const arm of order) {
          const name = `${task.id}-${repeat}-${arm}`;
          const artifacts = { patch: `${name}.patch`, session: `${name}.session.json`, transcript: `${name}.stream.jsonl` };
          const fixture = await prepareFixture(path.join(workspace, name), task, arm);
          console.log(`[${name}] running`);
          const session = await runSession({ cwd: fixture.repo, prompt: task.prompt, model: options.model,
            adapter,
            maxTurns: options.maxTurns, maxBudgetUsd: options.budgetPerSession, timeoutMs: options.timeoutSeconds * 1000,
            controlled: true, systemPrompt: SYSTEM, transcriptFile: path.join(directory, artifacts.transcript),
            mcpConfig: { mcpServers: arm === "mason" ? { mason: { command: process.execPath, args: [serverFile] } } : {} } });
          const grade = await gradePatch(task, fixture);
          const patch = capturePatch(fixture);
          await fs.writeFile(path.join(directory, artifacts.patch), patch);
          await fs.writeFile(path.join(directory, artifacts.session), JSON.stringify(session, null, 2) + "\n");
          run.results.push({ task: task.id, category: task.category, negativeControl: task.negativeControl, arm, repeat,
            sourceCommit: fixture.sourceCommit, sourceTree: fixture.sourceTree, knowledgeDigest: fixture.knowledgeDigest,
            patchHash: digest(patch), artifacts, session, grade });
          await checkpoint(directory, run);
          console.log(`[${name}] session=${session.ok ? "complete" : "failed"} patch=${grade.passed ? "pass" : "fail"} cost=${session.costUsd ?? "unknown"}`);
          if (session.interrupted) throw new Error("Benchmark interrupted");
          // Infrastructure/auth failures cannot yield a useful pilot. Preserve the
          // attempt and stop, rather than spending the rest of the run on retries.
          if (!session.ok && session.toolCalls.length === 0) throw new Error(`Session failed before any tool use: ${session.resultText || session.stderr || session.resultSubtype || "no result"}`);
        }
      }
    }
    run.status = "complete";
  } catch (error) {
    run.status = "aborted";
    run.error = error.message;
    throw error;
  } finally {
    run.finishedAt = new Date().toISOString();
    await checkpoint(directory, run);
    await fs.rm(workspace, { recursive: true, force: true });
    console.log(`Report: ${path.join(directory, "report.md")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
