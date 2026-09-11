import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { runHost } from './automation/session.mjs';
import { withMason, call } from './knowledge/mcp.mjs';
import { write, digest, receipts } from './knowledge/fixture.mjs';
import { inspectToolchain, runStartup } from './knowledge/startup-native.mjs';
import { fixture, prompts, initialApp, appText, referenceRules, grade, reviewPacket, accept, nextCheckout } from './knowledge/startup-fixture.mjs';

const { values } = parseArgs({ options: {
  validate: { type: 'boolean' }, live: { type: 'boolean' }, resume: { type: 'string' }, reviews: { type: 'string' },
  regrade: { type: 'string' }, reason: { type: 'string' },
  hosts: { type: 'string', default: 'codex' }, arms: { type: 'string', default: 'candidate,notes' }, repeats: { type: 'string', default: '1' },
  model: { type: 'string' }, 'timeout-ms': { type: 'string', default: '180000' }, 'budget-usd': { type: 'string', default: '1' },
  'r8-jar': { type: 'string' }, 'java-home': { type: 'string' }, output: { type: 'string' },
} });
if ([values.validate, values.live, values.resume, values.regrade].filter(Boolean).length !== 1) throw new Error('Choose --validate, --live, --resume RUN --reviews FILE, or --regrade RUN --reason TEXT.');
const hosts = values.hosts.split(','), arms = values.arms.split(','), repeats = Number(values.repeats);
const limits = { timeoutMs: Number(values['timeout-ms']), budgetUsd: Number(values['budget-usd']), ...(values.model ? { model: values.model } : {}) };
if (hosts.some(h => !['claude', 'codex'].includes(h)) || arms.some(a => !['candidate', 'notes'].includes(a))
  || new Set(hosts).size !== hosts.length || new Set(arms).size !== arms.length || !Number.isInteger(repeats) || repeats < 1 || repeats > 20
  || !Number.isFinite(limits.timeoutMs) || limits.timeoutMs < 1000 || !Number.isFinite(limits.budgetUsd) || limits.budgetUsd <= 0) throw new Error('Invalid matrix or session limits');
const repo = fileURLToPath(new URL('../../', import.meta.url)), binary = path.join(repo, 'dist/mason-mcp.js');
const observer = fileURLToPath(new URL('./knowledge/observe-mcp.mjs', import.meta.url));
const out = values.resume || values.regrade ? path.resolve(values.resume ?? values.regrade) : path.resolve(values.output ?? path.join(repo, 'bench/harness/results/lifecycle', new Date().toISOString().replaceAll(':', '-')));
const graderFiles = [fileURLToPath(import.meta.url), observer, binary, ...['startup-native.mjs', 'startup-fixture.mjs', 'fixture.mjs', 'mcp.mjs'].map(f => fileURLToPath(new URL('./knowledge/' + f, import.meta.url))), fileURLToPath(new URL('./automation/session.mjs', import.meta.url))];
const fingerprint = async () => Object.fromEntries(await Promise.all(graderFiles.map(async f => [f, digest(await fs.readFile(f))])));
const status = s => !s ? 'not run' : s.status === 'complete' ? s.grade.pass ? 'pass' : 'fail' : s.status;
const passed = row => ['capture', 'control', 'reconsider', 'followup'].every(s => row.stages[s]?.grade?.pass)
  && ['capture', 'reconsider'].every(s => row.stages[s]?.review?.verdict === 'accept' && row.stages[s].reviewApplied);
let report;
async function save() {
  const requests = {};
  for (const row of report.rows) for (const stage of ['capture', 'reconsider']) {
    const s = row.stages[stage];
    if (s?.grade?.eligibleForReview && !s.review && !s.error) requests[row.id + '/' + stage] = s.packet;
  }
  report.summary = { passed: report.rows.filter(passed).length, total: report.rows.length, pendingReviews: Object.keys(requests).length };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'review-requests.json'), JSON.stringify(requests, null, 2));
  await fs.writeFile(path.join(out, 'report.md'), [
    '# Conditional knowledge lifecycle — R8 startup', '',
    report.mode === 'validation' ? 'Deterministic reference actions. No agent-performance evidence.' : 'Live ordinary requests; independent semantic review required at two boundaries.', '',
    'Reconstructed from a real removal/reintroduction/repair incident. This reduced JVM model runs actual R8; it does not run Android, Room or WorkManager. Development case, not held-out validation.', '',
    '| Run | Capture | Review | Reconsider | Review | Follow-up | Control |', '|---|---|---|---|---|---|---|',
    ...report.rows.map(r => `| ${r.id} | ${status(r.stages.capture)} | ${r.stages.capture?.review?.verdict ?? 'pending'} | ${status(r.stages.reconsider)} | ${r.stages.reconsider?.review?.verdict ?? 'pending'} | ${status(r.stages.followup)} | ${status(r.stages.control)} |`), '',
    ...report.rows.flatMap(r => Object.entries(r.stages).flatMap(([s, v]) => [...(v.grade?.failures ?? []), ...(v.error ? [v.error] : [])].map(f => `- ${r.id}/${s}: ${f}`))), '',
    'Passing requires behavior, selective capture, supported proposals, both independent reviews, and fresh-session reuse of the accepted revision. Notes is an explicit portable project-notes baseline. MCP observation establishes retrieval before edits, not that retrieval caused success. No-capture failures are never seeded or retried.', '',
    'Hooks and private auto-memory are disabled. Session transcripts, tool receipts, toolchain identity, usage, failures and unknown costs remain in report.json and adjacent artifacts. One run cannot establish an advantage or a false-positive rate.', '',
  ].join('\n'));
}
const observerArgs = (root, log) => [observer, binary, root, log, JSON.stringify(['app.json', 'keep.pro'])];
async function replay(row, stage, root, log) {
  if (stage === 'control') { await write(root, 'greeting.txt', 'welcome\n'); return; }
  if (stage !== 'capture' && row.arm !== 'notes') await withMason(observer, root, c => call(c, root, 'get_context', { task: prompts[stage], files: ['app.json', 'keep.pro'] }), observerArgs(root, log));
  const app = stage === 'capture' ? { ...initialApp, schedulerDependency: false } : { requestedBackground: true, backgroundEnabled: true, schedulerDependency: true, jobs: stage === 'reconsider' ? ['forecast'] : ['forecast', 'cleanup'] };
  await write(root, 'app.json', appText(app));
  if (stage === 'reconsider') await write(root, 'keep.pro', referenceRules);
  if (stage === 'followup') return;
  const body = stage === 'capture'
    ? 'Remove the currently unused scheduler dependency to avoid release startup failure. R17 established that R8 strips the reflectively loaded database constructor; debug passes and monitoring starts too late. Removal avoids initialization but does not fix the shrinker hazard. If background work becomes required, revisit initialization and verify minified release startup; this is not a permanent scheduler ban.'
    : 'Background scheduling is now required for forecast refresh. Retain the scheduler and preserve its reflectively invoked database constructor during R8 shrinking, then verify minified release startup. R17 showed debug-only checks and application monitoring miss this pre-application crash. The earlier removal applied to an unused integration; it no longer satisfies requirements. This local mitigation does not establish that an upstream upgrade fixes the issue.';
  if (row.arm === 'notes') await write(root, 'PROJECT_NOTES.md', '# Proposed lesson\n' + body + '\nOwner: Mobile team. Sources: .investigation/notes.md (R17); requirements.md.\n');
  else await withMason(observer, root, c => call(c, root, 'save_decision', {
    ...(stage === 'reconsider' ? { id: row.stages.capture.grade.saved[0].id } : {}), title: 'Scheduler initialization under release minification', category: 'gotcha', body,
    owner: 'Mobile team', actor: 'Deterministic validator', files: ['app.json', 'keep.pro'], sources: [{ kind: 'incident', reference: '.investigation/notes.md' }, { kind: 'document', reference: 'requirements.md' }],
  }), observerArgs(root, log));
}
async function runStage(row, stage, root, before) {
  const log = path.join(out, row.id + '-' + stage + '-mcp.jsonl');
  const s = row.stages[stage] = { root, before, log, status: 'running' };
  await save(); console.log('[' + row.id + '/' + stage + '] running');
  try {
    if (report.mode === 'validation') { await replay(row, stage, root, log); s.session = { ok: true, kind: 'deterministic-replay', costUsd: 0, elapsedMs: 0 }; }
    else {
      const mcpConfig = { mcpServers: row.arm === 'notes' ? {} : { mason: { command: process.execPath, args: observerArgs(root, log),
        ...(row.host === 'codex' ? { required: true, tools: Object.fromEntries(['get_context', 'get_impact', 'save_decision'].map(name => [name, { approval_mode: 'approve' }])) } : {}),
      } } };
      s.session = await runHost({ host: row.host, arm: 'instructions', cwd: root, prompt: prompts[stage], mcpConfig, isolated: true,
        transcript: path.join(out, row.id + '-' + stage + '-transcript.jsonl'), ...report.limits });
    }
    s.grade = await grade(root, before, stage, s.session, await receipts(log), report.toolchain);
    if (report.mode === 'live' && (!s.session.sessionId || Object.values(row.stages).some(other => other !== s && other.session?.sessionId === s.session.sessionId))) {
      s.grade.failures.push('a distinct session was not established'); s.grade.pass = s.grade.eligibleForReview = false;
    }
    if (s.grade.eligibleForReview) s.packet = await reviewPacket(root, before, s.grade, stage);
    s.status = 'complete';
  } catch (error) { s.error = error.stack; s.status = 'failed'; }
  await save(); console.log('[' + row.id + '/' + stage + '] ' + status(s));
}
async function advance(row, reviews = {}) {
  for (const [stage, next] of [['capture', 'reconsider'], ['reconsider', 'followup']]) {
    const s = row.stages[stage];
    if (!s?.grade?.eligibleForReview || s.error || s.review?.verdict === 'reject') return;
    if (!s.review) {
      const review = report.mode === 'validation' ? { verdict: 'accept', reviewDigest: s.packet.reviewDigest, reviewer: 'Deterministic validator', reason: 'Known reference proposal in a reconstructed mechanism test; not an agent-quality assessment.' } : reviews[row.id + '/' + stage];
      if (!review) return;
      if (!['accept', 'reject'].includes(review.verdict) || !review.reviewer?.trim() || !review.reason?.trim() || review.reviewDigest !== s.packet.reviewDigest) throw new Error('Invalid independent review for ' + row.id + '/' + stage);
      s.review = { verdict: review.verdict, reviewer: review.reviewer, reason: review.reason, reviewDigest: review.reviewDigest };
      await save(); // An interrupted review is retained as incomplete, never silently retried.
      if (review.verdict === 'reject') return;
      try {
        await accept(s.root, s.before, s.grade, stage, s.review, binary, await receipts(s.log), report.toolchain);
        s.reviewApplied = true;
      } catch (error) { s.error = error.stack; await save(); return; }
      await save();
    }
    if (!s.reviewApplied) return;
    if (!row.stages[next]) {
      const root = row.root + '-' + next;
      const before = await nextCheckout(s.root, root, row.arm, next);
      await runStage(row, next, root, before);
    }
  }
}

if (values.regrade) {
  if (!values.reason?.trim()) throw new Error('Regrading requires a recorded reason');
  const original = await fs.readFile(path.join(out, 'report.json'), 'utf8');
  report = JSON.parse(original);
  if (report.rows.some(r => r.stages.followup || Object.values(r.stages).some(s => s.status !== 'complete' || s.review && !s.reviewApplied))) throw new Error('Regrade only completed artifacts before the final review boundary; never retry a session or reassess an applied review');
  const current = await fingerprint();
  for (const file of graderFiles.filter(f => f !== fileURLToPath(import.meta.url) && !f.endsWith('/startup-fixture.mjs'))) {
    if (current[file] !== report.fingerprint[file]) throw new Error('Execution code or server changed; start a new run');
  }
  const actual = await inspectToolchain(report.toolchain.r8Jar, report.toolchain.javaHome);
  if (JSON.stringify(actual) !== JSON.stringify(report.toolchain)) throw new Error('Toolchain changed; start a new run');
  const archive = 'report-before-regrade-' + Date.now() + '.json';
  await fs.writeFile(path.join(out, archive), original, { flag: 'wx' });
  for (const row of report.rows) for (const [stage, s] of Object.entries(row.stages)) {
    if (s.reviewApplied) continue;
    s.grade = await grade(s.root, s.before, stage, s.session, await receipts(s.log), report.toolchain);
    if (report.mode === 'live' && (!s.session.sessionId || Object.values(row.stages).some(other => other !== s && other.session?.sessionId === s.session.sessionId))) {
      s.grade.failures.push('a distinct session was not established'); s.grade.pass = s.grade.eligibleForReview = false;
    }
    if (s.grade.eligibleForReview) s.packet = await reviewPacket(s.root, s.before, s.grade, stage);
    else delete s.packet;
  }
  report.regrades = [...report.regrades ?? [], { at: new Date().toISOString(), reason: values.reason, originalReport: archive, previousFingerprint: report.fingerprint,
    stages: report.rows.flatMap(r => Object.entries(r.stages).filter(([, s]) => !s.reviewApplied).map(([stage]) => r.id + '/' + stage)) }];
  report.fingerprint = current;
} else if (values.resume) {
  if (!values.reviews) throw new Error('--resume requires --reviews FILE');
  report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
  if (JSON.stringify(report.fingerprint) !== JSON.stringify(await fingerprint())) throw new Error('Harness or server changed; start a new run.');
  const actual = await inspectToolchain(report.toolchain.r8Jar, report.toolchain.javaHome);
  if (JSON.stringify(actual) !== JSON.stringify(report.toolchain)) throw new Error('Toolchain changed; start a new run.');
  const reviews = JSON.parse(await fs.readFile(path.resolve(values.reviews), 'utf8'));
  for (const row of report.rows) await advance(row, reviews);
} else {
  await fs.mkdir(out, { recursive: true });
  try { await fs.access(path.join(out, 'report.json')); throw new Error('Output already contains a run'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const toolchain = await inspectToolchain(values['r8-jar'] ?? process.env.MASON_EVAL_R8_JAR, values['java-home'] ?? process.env.MASON_EVAL_JAVA_HOME);
  console.log('Validating debug/release failure and two constructor-preserving repairs with ' + toolchain.r8Version);
  const preflight = {};
  const required = { requestedBackground: true, backgroundEnabled: true, schedulerDependency: true, jobs: ['forecast'] };
  for (const [name, app, rules, mode, expected] of [
    ['debug', initialApp, '', 'debug', true], ['release-regression', initialApp, '', 'release', false],
    ['removal', { ...initialApp, schedulerDependency: false }, '', 'release', true],
    ['reference', required, referenceRules, 'release', true],
    ['alternative', required, '-keepclassmembers class fixture.GeneratedDatabase { public <init>(); }', 'release', true],
  ]) {
    preflight[name] = await runStartup(appText(app), rules, toolchain, mode);
    if (preflight[name].pass !== expected || !expected && (preflight[name].phase !== 'startup' || !preflight[name].stderr.includes('NoSuchMethodException'))) throw new Error('Native fixture preflight failed: ' + name + JSON.stringify(preflight[name]));
  }
  const source = await fs.readFile(path.join(repo, 'src/mcp/init.ts'), 'utf8');
  const guidance = source.split('export const CLAUDE_MD_SECTION = `')[1].split('`;\n')[0].replaceAll('\\`', '`');
  report = { version: 1, mode: values.validate ? 'validation' : 'live', toolchain, preflight, limits, rows: [], fingerprint: await fingerprint(), guidanceDigest: digest(guidance),
    workspace: await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mason-lifecycle-'))),
    hostVersions: Object.fromEntries(hosts.map(h => { try { return [h, values.validate ? 'not-used' : execFileSync(h, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()]; } catch { return [h, 'unavailable']; } })),
    hooks: 'disabled', nativePrivateMemory: 'disabled', provenance: 'Reduced reconstruction of a removal, scheduler reintroduction and repeated release startup crash; no original logs or private repository files copied.',
  };
  console.log('Run: ' + out);
  console.log(values.validate ? 'Reference validation; no model calls.' : 'Up to four fresh sessions per arm; no automatic retries. Two independent reviews required. Claude budget cap applies per session; Codex usage has no dollar cap.');
  for (let repeat = 1; repeat <= repeats; repeat++) for (const host of hosts) for (const arm of repeat % 2 ? arms : [...arms].reverse()) {
    const row = { id: `${host}-r8-${repeat}-${arm}`, host, arm, stages: {}, root: path.join(report.workspace, `${host}-${repeat}-${arm}`) };
    report.rows.push(row);
    await runStage(row, 'capture', row.root, await fixture(row.root, { arm, guidance, toolchain }));
    const control = row.root + '-control';
    await runStage(row, 'control', control, await fixture(control, { arm, guidance, toolchain, control: true }));
    await advance(row);
  }
}
await save();
console.log('Report: ' + path.join(out, 'report.md'));
process.exitCode = report.summary.pendingReviews ? 2 : report.rows.length && report.rows.every(passed) ? 0 : 1;
