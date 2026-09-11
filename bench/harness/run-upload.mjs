import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { runHost } from './automation/session.mjs';
import { withMason, call, payload } from './knowledge/mcp.mjs';
import { digest, write, receipts } from './knowledge/fixture.mjs';
import { operations } from './knowledge/publish-model.mjs';
import { fixture, fresh, prompts, grade, packet, accept, originalLesson, revisedBody, referenceNotes } from './knowledge/upload-fixture.mjs';

const { values } = parseArgs({ options: { validate: { type: 'boolean' }, live: { type: 'boolean' }, resume: { type: 'string' }, reviews: { type: 'string' },
  hosts: { type: 'string', default: 'codex' }, arms: { type: 'string', default: 'candidate,notes' }, output: { type: 'string' },
  model: { type: 'string' }, 'timeout-ms': { type: 'string', default: '180000' }, 'budget-usd': { type: 'string', default: '1' } } });
if ([values.validate, values.live, values.resume].filter(Boolean).length !== 1) throw new Error('Choose --validate, --live or --resume RUN --reviews FILE');
const hosts = values.hosts.split(','), arms = values.arms.split(',');
const limits = { timeoutMs: Number(values['timeout-ms']), budgetUsd: Number(values['budget-usd']), ...(values.model ? { model: values.model } : {}) };
if (hosts.some(h => !['codex', 'claude'].includes(h)) || arms.some(a => !['candidate', 'notes'].includes(a)) || new Set(hosts).size !== hosts.length || new Set(arms).size !== arms.length
  || !Number.isFinite(limits.timeoutMs) || limits.timeoutMs < 1000 || !Number.isFinite(limits.budgetUsd) || limits.budgetUsd <= 0) throw new Error('Invalid matrix or limits');
const repo = fileURLToPath(new URL('../../', import.meta.url)), binary = path.join(repo, 'dist/mason-mcp.js');
const observer = fileURLToPath(new URL('./knowledge/observe-mcp.mjs', import.meta.url)), publisher = fileURLToPath(new URL('./knowledge/publish-server.mjs', import.meta.url));
const files = [fileURLToPath(import.meta.url), binary, observer, publisher, ...['upload-fixture.mjs', 'publish-model.mjs', 'fixture.mjs', 'mcp.mjs'].map(f => fileURLToPath(new URL('./knowledge/' + f, import.meta.url))), fileURLToPath(new URL('./automation/session.mjs', import.meta.url))];
const fingerprint = async () => Object.fromEntries(await Promise.all(files.map(async f => [f, digest(await fs.readFile(f))])));
const out = path.resolve(values.resume ?? values.output ?? path.join(repo, 'bench/harness/results/upload', new Date().toISOString().replaceAll(':', '-')));
let report;
const status = s => !s ? 'not run' : s.error ? 'error' : s.grade ? s.grade.pass ? 'pass' : 'fail' : 'running';
const passed = r => ['maintain', 'control', 'followup'].every(stage => r.stages[stage]?.grade?.pass) && r.reviewApplied;
async function save() {
  const requests = Object.fromEntries(report.rows.filter(r => r.stages.maintain?.grade?.eligibleForReview && !r.review).map(r => [r.id, r.stages.maintain.packet]));
  report.summary = { passed: report.rows.filter(passed).length, total: report.rows.length, pendingReviews: Object.keys(requests).length };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'review-requests.json'), JSON.stringify(requests, null, 2));
  await fs.writeFile(path.join(out, 'report.md'), ['# Interrupted-upload maintenance probe', '',
    report.mode === 'validation' ? 'Reference mechanism validation; no model calls.' : 'Live ordinary requests with a deliberately seeded, reviewed starting lesson. Measures maintenance, not initial capture.', '',
    'The publishing service is a local protocol simulator. No real account, upload or release. The expired-edit branch is a constructed extension of a recorded incident, not original logs or a production API reproduction.', '',
    '| Run | Maintenance | Review | Fresh reuse | First-upload control |', '|---|---|---|---|---|',
    ...report.rows.map(r => `| ${r.id} | ${status(r.stages.maintain)} | ${r.review?.verdict ?? 'not recorded'} | ${status(r.stages.followup)} | ${status(r.stages.control)} |`), '',
    ...report.rows.flatMap(r => Object.entries(r.stages).flatMap(([k, s]) => [...s.grade?.failures ?? [], ...s.error ? [s.error] : []].map(f => `- ${r.id}/${k}: ${f}`))), '',
    'Independent semantic review is required before follow-up; missing revisions are never seeded or repaired. Hooks and native private memory are disabled. One trial does not establish general superiority or a false-positive rate. See report.json, review receipts, transcripts and publishing/MCP journals for scope, usage and unknown costs.', '',
  ].join('\n'));
}
const observerArgs = (root, log) => [observer, binary, root, log, '["release.json"]'];
async function runStage(row, stage, root, before) {
  const prefix = path.join(out, row.id + '-' + stage), log = prefix + '-mcp.jsonl', publishLog = prefix + '-publish.jsonl', seed = prefix + '-service.json';
  await fs.writeFile(seed, JSON.stringify({ scenario: stage === 'control' ? 'empty' : 'expired', release: before.release }));
  const s = row.stages[stage] = { root, before, log, publishLog, seed };
  await save(); console.log('[' + row.id + '/' + stage + '] running');
  try {
    if (report.mode === 'validation') {
      if (row.arm !== 'notes') await withMason(observer, root, c => call(c, root, 'get_context', { task: prompts[stage], files: ['release.json', 'publishing.md'] }), observerArgs(root, log));
      await withMason(publisher, root, async c => {
        const invoke = async (name, args = {}) => payload(await c.callTool({ name, arguments: args }));
        await invoke('inspect_edit', { editId: before.release.editId });
        const editId = stage === 'control' ? before.release.editId : (await invoke('create_edit')).editId;
        for (const name of ['upload_bundle', 'attach_mapping', 'finish_edit']) await invoke(name, { editId });
      }, [publisher, seed, publishLog]);
      if (stage === 'maintain') {
        if (row.arm === 'notes') await write(root, 'PROJECT_NOTES.md', referenceNotes());
        else await withMason(observer, root, c => call(c, root, 'save_decision', { ...originalLesson, id: before.knowledge[0].id, body: revisedBody,
          sources: [...originalLesson.sources, { kind: 'incident', reference: '.investigation/retention.md' }] }), observerArgs(root, log));
      }
      s.session = { ok: true, kind: 'deterministic-replay', elapsedMs: 0, costUsd: 0 };
    } else {
      const config = (args, names) => ({ command: process.execPath, args, ...(row.host === 'codex' ? { required: true, tools: Object.fromEntries(names.map(name => [name, { approval_mode: 'approve' }])) } : {}) });
      const mcpServers = { publishing: config([publisher, seed, publishLog], operations), ...(row.arm === 'notes' ? {} : { mason: config(observerArgs(root, log), ['get_context', 'get_impact', 'save_decision']) }) };
      s.session = await runHost({ host: row.host, arm: 'instructions', cwd: root, prompt: prompts[stage], mcpConfig: { mcpServers }, isolated: true,
        transcript: prefix + '-transcript.jsonl', ...report.limits });
    }
    s.grade = await grade(root, before, stage, s.session, await receipts(log), await receipts(publishLog));
    if (report.mode === 'live' && (!s.session.sessionId || Object.values(row.stages).some(other => other !== s && other.session?.sessionId === s.session.sessionId))) {
      s.grade.failures.push('distinct fresh session not established'); s.grade.pass = s.grade.eligibleForReview = false;
    }
    if (s.grade.eligibleForReview) s.packet = await packet(root, before, s.grade);
  } catch (e) { s.error = e.stack; }
  await save(); console.log('[' + row.id + '/' + stage + '] ' + status(s));
}
async function advance(row, review) {
  const s = row.stages.maintain;
  if (!s.grade?.eligibleForReview || row.review || row.stages.followup) return;
  if (report.mode === 'validation') review = { verdict: 'accept', reviewer: 'Deterministic validator', reason: 'Known reference revision in a synthetic mechanism test; not agent performance.', reviewDigest: s.packet.reviewDigest };
  if (!review) return;
  if (!['accept', 'reject'].includes(review.verdict) || !review.reviewer?.trim() || !review.reason?.trim() || review.reviewDigest !== s.packet.reviewDigest) throw new Error('Invalid independent review');
  row.review = review;
  await save(); // An interrupted review is incomplete and is never retried silently.
  if (review.verdict === 'reject') return;
  try {
    await accept(s.root, s.before, s.grade, review, binary, await receipts(s.log), await receipts(s.publishLog));
    row.reviewApplied = true;
    await save();
    const next = row.root + '-followup', before = await fresh(s.root, next, row.arm);
    await runStage(row, 'followup', next, before);
  } catch (e) { s.error = e.stack; await save(); }
}
if (values.resume) {
  if (!values.reviews) throw new Error('--resume requires --reviews FILE');
  report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
  if (JSON.stringify(report.fingerprint) !== JSON.stringify(await fingerprint())) throw new Error('Harness or server changed; start a new run');
  const reviews = JSON.parse(await fs.readFile(path.resolve(values.reviews), 'utf8'));
  for (const row of report.rows) await advance(row, reviews[row.id]);
} else {
  await fs.mkdir(out, { recursive: true });
  try { await fs.access(path.join(out, 'report.json')); throw new Error('Output already contains a run'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const source = await fs.readFile(path.join(repo, 'src/mcp/init.ts'), 'utf8');
  const guidance = source.split('export const CLAUDE_MD_SECTION = `')[1].split('`;\n')[0].replaceAll('\\`', '`');
  report = { version: 1, mode: values.validate ? 'validation' : 'live', limits, guidanceDigest: digest(guidance), fingerprint: await fingerprint(),
    rows: [], workspace: await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mason-upload-'))),
    hostVersions: Object.fromEntries(hosts.map(h => { try { return [h, values.validate ? 'not-used' : execFileSync(h, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()]; } catch { return [h, 'unavailable']; } })),
    hooks: 'disabled', nativePrivateMemory: 'disabled', startingState: 'Explicitly seeded and reviewed synthetic U12 lesson; initial capture is not measured.',
  };
  console.log('Run: ' + out);
  console.log(values.validate ? 'Deterministic local protocol validation; no models.' : 'Up to three fresh sessions per arm. No automatic retries. Independent review required. Claude budget cap applies per session; Codex costs remain unbounded and reported if available.');
  for (const host of hosts) for (const arm of arms) {
    const row = { id: `${host}-upload-${arm}`, host, arm, root: path.join(report.workspace, `${host}-${arm}`), stages: {} };
    report.rows.push(row);
    await runStage(row, 'maintain', row.root, await fixture(row.root, { arm, guidance, binary }));
    const control = row.root + '-control';
    await runStage(row, 'control', control, await fixture(control, { arm, guidance, binary, control: true }));
    await advance(row);
  }
}
await save();
console.log('Report: ' + path.join(out, 'report.md'));
process.exitCode = report.summary.pendingReviews ? 2 : report.rows.length && report.rows.every(passed) ? 0 : 1;
