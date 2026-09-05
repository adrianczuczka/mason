import fs from "node:fs/promises";
import path from "node:path";

const key = row => `${row.task}/${row.arm}/${row.repeat}`;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const rate = (hits, total) => total ? hits / total : null;

export function summarize(run, review) {
  if (review && (review.version !== 1 || review.runId !== run.id || !Array.isArray(review.entries))) throw new Error("Review must identify this run and contain entries");
  const reviews = new Map();
  for (const entry of review?.entries ?? []) {
    const row = run.results.find(r => key(r) === key(entry));
    if (!row || !row.negativeControl || entry.patchHash !== row.patchHash) throw new Error(`Review does not match a negative-control patch: ${key(entry)}`);
    if (reviews.has(key(entry))) throw new Error(`Duplicate review: ${key(entry)}`);
    if (entry.unnecessaryIntervention === null) continue;
    if (typeof entry.unnecessaryIntervention !== "boolean" || !entry.evidence?.trim()) throw new Error(`Review needs a boolean judgment and evidence: ${key(entry)}`);
    reviews.set(key(entry), entry);
  }
  const arms = {};
  for (const arm of run.options.arms) {
    const rows = run.results.filter(r => r.arm === arm);
    const correct = rows.filter(r => r.session.ok && r.grade.passed).length;
    const negatives = rows.filter(r => r.negativeControl);
    const reviewed = negatives.map(r => reviews.get(key(r))).filter(Boolean);
    const costs = rows.map(r => r.session.costUsd).filter(v => typeof v === "number");
    arms[arm] = {
      attempts: rows.length, completed: rows.filter(r => r.session.ok).length,
      correct, correctRate: rate(correct, rows.length),
      constraintFailures: rows.filter(r => r.grade.checks.some(c => c.kind === "constraint" && !c.passed)).length,
      companionFailures: rows.filter(r => r.grade.checks.some(c => c.kind === "companion" && !c.passed)).length,
      knownCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      missingCostRows: rows.length - costs.length,
      meanWallTimeMs: mean(rows.map(r => r.session.wallTimeMs).filter(v => typeof v === "number")),
      masonToolCalls: rows.reduce((n, r) => n + r.session.mcpCalls.filter(t => t.startsWith("mcp__mason__")).length, 0),
      negativeControls: negatives.length, reviewedNegativeControls: reviewed.length,
      unnecessaryInterventions: reviewed.filter(r => r.unnecessaryIntervention).length,
      unnecessaryInterventionRate: rate(reviewed.filter(r => r.unnecessaryIntervention).length, reviewed.length),
    };
  }
  const pairs = { comparable: 0, masonOnlyCorrect: 0, baselineOnlyCorrect: 0, bothCorrect: 0, neitherCorrect: 0, incomplete: 0, mismatched: 0 };
  const pairsByKey = new Map();
  for (const row of run.results) {
    const id = `${row.task}/${row.repeat}`;
    if (!pairsByKey.has(id)) pairsByKey.set(id, {});
    pairsByKey.get(id)[row.arm] = row;
  }
  for (const { baseline, mason } of pairsByKey.values()) {
    if (!baseline || !mason) { pairs.incomplete++; continue; }
    if (baseline.sourceCommit !== mason.sourceCommit || baseline.knowledgeDigest !== mason.knowledgeDigest || !baseline.session.models.length || JSON.stringify(baseline.session.models) !== JSON.stringify(mason.session.models)) { pairs.mismatched++; continue; }
    pairs.comparable++;
    const b = baseline.session.ok && baseline.grade.passed;
    const m = mason.session.ok && mason.grade.passed;
    pairs[b && m ? "bothCorrect" : b ? "baselineOnlyCorrect" : m ? "masonOnlyCorrect" : "neitherCorrect"]++;
  }
  return { arms, pairs };
}

const percent = n => n === null ? "pending" : `${(n * 100).toFixed(1)}%`;
const money = n => n === null ? "unknown" : `$${n.toFixed(3)}`;

export function renderReport(run, review) {
  const { arms, pairs } = summarize(run, review);
  const lines = [
    "# Mason patch benchmark", "", `Run: ${run.id} · state: ${run.status} · model requested: ${run.options.model}`, "",
    "Controlled, dependency-free fixtures. This pilot measures patch behavior in curated scenarios; it does not establish a production improvement or the cost of building/maintaining real project knowledge.", "",
    "Both arms receive identical source commits, task prompts, public tests, instructions, and engineering facts. Mason additionally receives the same facts as curated map/decision records through MCP. No automatic retries or LLM answer judge are used.", "",
    "| Arm | Correct patches / attempts | Completed sessions | Constraint failures | Missed companion updates | Known cost | Mean seconds | Mason calls |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [arm, s] of Object.entries(arms)) lines.push(`| ${arm} | ${s.correct}/${s.attempts} (${percent(s.correctRate)}) | ${s.completed} | ${s.constraintFailures} | ${s.companionFailures} | ${money(s.knownCostUsd)}${s.missingCostRows ? ` (${s.missingCostRows} unknown)` : ""} | ${s.meanWallTimeMs === null ? "unknown" : (s.meanWallTimeMs / 1000).toFixed(1)} | ${s.masonToolCalls} |`);
  lines.push("", `Comparable pairs: ${pairs.comparable}. Mason alone correct: ${pairs.masonOnlyCorrect}; baseline alone correct: ${pairs.baselineOnlyCorrect}; both correct: ${pairs.bothCorrect}; neither correct: ${pairs.neitherCorrect}. Incomplete: ${pairs.incomplete}; source/knowledge/model mismatches excluded: ${pairs.mismatched}.`, "",
    "## Unnecessary interventions", "", "This rate requires human review of negative-control transcripts. A failed patch alone is not a false-positive warning. Count an intervention only when irrelevant or obsolete guidance causes an unwarranted warning, refusal, or unrelated change. Evidence inspection and accurate freshness notices alone do not count.", "");
  for (const [arm, s] of Object.entries(arms)) lines.push(`- ${arm}: ${s.unnecessaryInterventions}/${s.reviewedNegativeControls} reviewed controls (${percent(s.unnecessaryInterventionRate)}); ${s.negativeControls - s.reviewedNegativeControls} awaiting review.`);
  lines.push("", "## Every attempt", "", "| Task | Repeat | Arm | Session | Patch | Failed checks | Artifacts |", "|---|---:|---|---|---|---|---|");
  for (const row of run.results) {
    const failed = [...row.grade.integrity, ...row.grade.checks.filter(c => !c.passed).map(c => c.id), ...(row.grade.publicTests?.passed === false ? ["public tests"] : [])];
    lines.push(`| ${row.task} | ${row.repeat} | ${row.arm} | ${row.session.ok ? "completed" : row.session.error ?? "failed"} | ${row.grade.passed ? "pass" : "fail"} | ${failed.join(", ").replaceAll("|", "\\|")} | [patch](${row.artifacts.patch}) · [session](${row.artifacts.session}) |`);
  }
  lines.push("", "## Reproduction and limits", "",
    `- Fixture and grader digest: \`${run.suiteDigest}\`. Mason build digest: \`${run.masonBuildDigest}\`. Dependency lock digest: \`${run.dependencyLockDigest ?? "not recorded"}\`.`,
    `- CLI: ${run.cliVersion}. Node: ${run.nodeVersion}. Harness source commit: ${run.harnessCommit} (working changes: ${run.harnessDirty}).`,
    `- Per-session limits: ${run.options.maxTurns} turns, ${run.options.timeoutSeconds}s, ${money(run.options.budgetPerSession)}. Requested repetitions: ${run.options.repeats}.`,
    "- Exact resolved model identifiers, source commits, knowledge digests, costs, grades, and artifact paths are recorded in results.json. A model alias can change between runs; use a full model identifier for subsequent comparisons.",
    "- Reference patches and deliberately wrong patches validate checks offline. They are not agent outcomes and are never counted in this comparison.",
    "- Private checks are copied into a separate grader only after a session ends. Agents edit isolated temporary checkouts; these are evaluation hygiene, not an operating-system security sandbox.",
    "- The repeated-mistake tasks seed a past incident. They do not yet measure multi-session learning or automatic decision capture.",
    "- Inspect patch and transcript artifacts before publishing. Report all attempts and pending judgments. Repeat runs and add real repository tasks before making effectiveness claims.", "");
  return lines.join("\n");
}

export async function writeReport(directory, run, review) {
  await fs.writeFile(path.join(directory, "report.md"), renderReport(run, review));
  const template = { version: 1, runId: run.id, entries: run.results.filter(r => r.negativeControl).map(r => ({
    task: r.task, arm: r.arm, repeat: r.repeat, patchHash: r.patchHash, unnecessaryIntervention: null, evidence: "",
  })) };
  await fs.writeFile(path.join(directory, "review-template.json"), JSON.stringify(template, null, 2) + "\n");
}
