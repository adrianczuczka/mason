import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tasks } from "../bench/harness/patches/tasks.mjs";
import { capturePatch, prepareFixture, writeFiles, git } from "../bench/harness/patches/fixture.mjs";
import { gradePatch } from "../bench/harness/patches/grade.mjs";
import { validateTasks } from "../bench/harness/patches/validate.mjs";
import { renderReport, summarize } from "../bench/harness/patches/report.mjs";
import { parsePatchArgs } from "../bench/harness/run-patches.mjs";
import { runSession } from "../bench/harness/lib/session.mjs";
import { loadAdapter, validAdapterResult } from "../bench/harness/lib/adapter.mjs";
import { computeDrift } from "../src/drift/drift.js";
import { computeDecisionDrift } from "../src/decisions/drift.js";

const exec = promisify(execFile);
const task = (id: string) => tasks.find(t => t.id === id)!;

describe("patch benchmark", () => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "mason-bench-test-")); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it("validates every original, reference, and deliberate regression", async () => {
    const result = await validateTasks(tasks);
    expect(result).toHaveLength(10);
    expect(result.every(r => r.referencePasses && !r.originalPasses && r.mutations.length)).toBe(true);
  }, 60000);

  it("gives both arms identical commits and knowledge with private tests absent", async () => {
    const baseline = await prepareFixture(path.join(directory, "baseline"), task("router-migration"), "baseline");
    const mason = await prepareFixture(path.join(directory, "mason"), task("router-migration"), "mason");
    expect(baseline.sourceCommit).toBe(mason.sourceCommit);
    expect(baseline.sourceTree).toBe(mason.sourceTree);
    expect(baseline.knowledgeDigest).toBe(mason.knowledgeDigest);
    expect(await fs.readFile(path.join(baseline.repo, "CLAUDE.md"), "utf8")).toBe(await fs.readFile(path.join(mason.repo, "CLAUDE.md"), "utf8"));
    expect(await fs.readdir(path.join(baseline.repo, "test"))).toEqual(["smoke.test.mjs"]);
    await expect(fs.access(path.join(baseline.repo, ".mason"))).rejects.toThrow();
    expect(git(baseline.repo, "status", "--porcelain")).toBe("");
    expect(git(mason.repo, "status", "--porcelain")).toBe("");
  });

  it("actually creates stale and unknown Mason evidence", async () => {
    const stale = await prepareFixture(path.join(directory, "stale"), task("router-migration"), "mason");
    expect((await computeDrift(stale.repo))?.featureFreshness?.["router-migration"]).toBe("changed");
    expect((await computeDecisionDrift(stale.repo)).freshness?.["router-entry"]).toBe("changed");
    const unknown = await prepareFixture(path.join(directory, "unknown"), task("unknown-history"), "mason");
    expect((await computeDecisionDrift(unknown.repo)).freshness?.["old-export-halt"]).toBe("unknown");
  });

  it("keeps current fixture maps fresh with complete public-test coverage", async () => {
    for (const t of tasks.filter(t => !t.advance)) {
      const fixture = await prepareFixture(path.join(directory, t.id), t, "mason");
      const drift = await computeDrift(fixture.repo);
      expect(drift?.unmappedFiles, t.id).toEqual([]);
      expect(drift?.stale, t.id).toBe(false);
      expect(drift?.featureFreshness?.[t.id], t.id).toBe("current");
    }
  });

  it("rejects tampering with public tests even when held-out behavior passes", async () => {
    const t = task("health-label");
    const fixture = await prepareFixture(path.join(directory, "repo"), t, "baseline");
    await writeFiles(fixture.repo, { ...t.reference, "test/smoke.test.mjs": "// skip tests\n" });
    const grade = await gradePatch(t, fixture);
    expect(grade.checks.every(c => c.passed)).toBe(true);
    expect(grade.passed).toBe(false);
    expect(grade.integrity).toContain("Protected fixture file changed: test/smoke.test.mjs");
  });

  it("captures staged, unstaged, and new files in the patch artifact", async () => {
    const t = task("health-label");
    const fixture = await prepareFixture(path.join(directory, "repo"), t, "baseline");
    await writeFiles(fixture.repo, t.reference);
    git(fixture.repo, "add", "src/status.mjs");
    await writeFiles(fixture.repo, { "src/helper.mjs": "export const value = true;\n" });
    const patch = capturePatch(fixture);
    expect(patch).toContain("serviceName");
    expect(patch).toContain("src/helper.mjs");
    expect(patch).toContain("new file mode");
    const clean = await prepareFixture(path.join(directory, "clean"), t, "baseline");
    const artifact = path.join(directory, "change.patch");
    await fs.writeFile(artifact, patch);
    expect(() => git(clean.repo, "apply", "--check", artifact)).not.toThrow();
    git(clean.repo, "apply", artifact);
    expect((await gradePatch(t, clean)).passed).toBe(true);
  });

  it("allows an alternate correct implementation with a new helper", async () => {
    const t = task("health-label");
    const fixture = await prepareFixture(path.join(directory, "repo"), t, "baseline");
    await writeFiles(fixture.repo, {
      "src/name.mjs": "export const name='parcel';\n",
      "src/status.mjs": "import {name} from './name.mjs'; export function status(){return Object.assign({healthy:true},{serviceName:name});}\n",
    });
    expect((await gradePatch(t, fixture)).passed).toBe(true);
  });

  it("rejects invalid limits and unknown task selection before running sessions", () => {
    for (const args of [["--repeats", "NaN"], ["--budget-per-session", "0"], ["--tasks", "missing"], ["--arms", "baseline,baseline"], ["--model"]]) {
      expect(() => parsePatchArgs(args)).toThrow();
    }
  });

  it("handles an unavailable CLI without hanging or inventing zero cost", async () => {
    const result = await runSession({ cwd: directory, prompt: "unused", executable: path.join(directory, "missing-cli"), timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.costUsd).toBeNull();
    expect(result.stderr).toContain("ENOENT");
  });

  it("rejects malformed adapter results and undeclared budget enforcement", async () => {
    expect(validAdapterResult({ type: "result", ok: true })).toBe(false);
    expect(validAdapterResult({ ok: true, resultText: "done", model: "test", costUsd: -1, toolCalls: [] })).toBe(false);
    const config = path.join(directory, "adapter.json");
    await fs.writeFile(config, JSON.stringify({ name: "test", version: "1", command: "node", args: [] }));
    await expect(loadAdapter(config)).rejects.toThrow(/enforce/);
  });

  it("runs a custom agent adapter without invoking Claude", async () => {
    const driver = path.join(directory, "driver.cjs");
    await fs.writeFile(driver, `const fs=require('node:fs');
const job=JSON.parse(fs.readFileSync(0,'utf8'));
if(job.version!==1||job.limits.maxBudgetUsd!==.25)process.exit(2);
fs.writeFileSync('src/status.mjs',"export function status(){return {healthy:true,serviceName:'parcel'};}\\n");
console.log(JSON.stringify({type:'result',ok:true,model:job.model,resultText:'Added label',costUsd:null,numTurns:1,toolCalls:[{name:'Edit',input:{file_path:'src/status.mjs'}}]}));
`);
    const config = path.join(directory, "adapter.json");
    await fs.writeFile(config, JSON.stringify({ name: "deterministic-test", version: "1", command: process.execPath, args: [driver], enforcesBudget: true }));
    const output = path.join(directory, "custom-results");
    await exec(process.execPath, ["bench/harness/run-patches.mjs", "--adapter", config, "--model", "fixture-test-model", "--tasks", "health-label", "--budget-per-session", ".25", "--output", output], { cwd: process.cwd(), timeout: 20000 });
    const run = JSON.parse(await fs.readFile(path.join(output, "results.json"), "utf8"));
    expect(run.agent.name).toBe("deterministic-test");
    expect(run.results.every(r => r.grade.passed && r.session.ok)).toBe(true);
    expect(run.results.every(r => r.session.costUsd === null)).toBe(true);
    expect(summarize(run).pairs.bothCorrect).toBe(1);
  }, 30000);

  it("terminates an agent that exceeds its time budget", async () => {
    const executable = path.join(directory, "slow-cli");
    await fs.writeFile(executable, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n", { mode: 0o755 });
    const result = await runSession({ cwd: directory, prompt: "unused", executable, timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.wallTimeMs).toBeLessThan(3000);
  });

  it("runs the entire artifact/report path with a deterministic fake CLI", async () => {
    const bin = path.join(directory, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('test-cli');process.exit(0);}
fs.writeFileSync('src/status.mjs',"export function status(){return {healthy:true,serviceName:'parcel'};}\\n");
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Edit',input:{file_path:'src/status.mjs'}}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'Added the service label.',total_cost_usd:0,num_turns:1,modelUsage:{'test-model':{}},usage:{}}));
`, { mode: 0o755 });
    const output = path.join(directory, "results");
    await exec(process.execPath, ["bench/harness/run-patches.mjs", "--tasks", "health-label", "--output", output], {
      cwd: process.cwd(), env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, timeout: 20000,
    });
    const run = JSON.parse(await fs.readFile(path.join(output, "results.json"), "utf8"));
    expect(run.status).toBe("complete");
    expect(run.results).toHaveLength(2);
    expect(run.results.every(r => r.grade.passed && r.session.ok)).toBe(true);
    expect(summarize(run).pairs.bothCorrect).toBe(1);
    expect(summarize(run).arms.mason.unnecessaryInterventionRate).toBeNull();
    expect(renderReport(run)).toContain("awaiting review");
    for (const row of run.results) {
      await expect(fs.access(path.join(output, row.artifacts.patch))).resolves.toBeUndefined();
      await expect(fs.access(path.join(output, row.artifacts.transcript))).resolves.toBeUndefined();
    }
    const review = JSON.parse(await fs.readFile(path.join(output, "review-template.json"), "utf8"));
    review.entries[0].unnecessaryIntervention = false;
    review.entries[0].evidence = "Session implements the requested label without objections or unrelated edits.";
    expect(summarize(run, review).arms.baseline.reviewedNegativeControls).toBe(1);
    review.entries[0].patchHash = "different-patch";
    expect(() => summarize(run, review)).toThrow(/does not match/);
    run.results[0].session.ok = false;
    run.results[0].session.costUsd = null;
    expect(summarize(run).arms.baseline.correct).toBe(0);
    expect(summarize(run).arms.baseline.missingCostRows).toBe(1);
    run.results[0].sourceCommit = "different-source";
    expect(summarize(run).pairs.mismatched).toBe(1);
  }, 30000);
});
