import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { runHost } from './automation/session.mjs';
import { summarize } from './knowledge/report.mjs';
import { withMason, call } from './knowledge/mcp.mjs';
import { fixture, variants, prompts, write, git, digest, records, receipts, integrity, gradeCapture, acceptReviewed, freshCheckout, gradeReuse } from './knowledge/fixture.mjs';

const { values } = parseArgs({ options: {
  validate: { type: 'boolean' }, live: { type: 'boolean' }, resume: { type: 'string' }, reviews: { type: 'string' },
  hosts: { type: 'string', default: 'claude,codex' }, arms: { type: 'string', default: 'current,candidate,notes' },
  variants: { type: 'string', default: variants.join(',') }, repeats: { type: 'string', default: '1' },
  model: { type: 'string' }, 'timeout-ms': { type: 'string', default: '180000' }, 'budget-usd': { type: 'string', default: '1' },
  output: { type: 'string' }, 'current-server': { type: 'string' },
} });
if ([values.validate, values.live, values.resume].filter(Boolean).length !== 1) throw new Error('Choose --validate, --live, or --resume RUN --reviews FILE.');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const observer = fileURLToPath(new URL('./knowledge/observe-mcp.mjs', import.meta.url));
const candidate = path.join(repo, 'dist/mason-mcp.js');
const selectedHosts = values.hosts.split(','), selectedArms = values.arms.split(','), selectedVariants = values.variants.split(',');
const repeats = Number(values.repeats), timeoutMs = Number(values['timeout-ms']), budgetUsd = Number(values['budget-usd']);
if (selectedHosts.some(h => !['codex', 'claude'].includes(h)) || selectedArms.some(a => !['current', 'candidate', 'notes'].includes(a)) ||
  selectedVariants.some(v => !variants.includes(v)) || !Number.isInteger(repeats) || repeats < 1 || repeats > 20 ||
  !Number.isFinite(timeoutMs) || timeoutMs < 1000 || !Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('Invalid run matrix or limits.');
let report;
const out = values.resume ? path.resolve(values.resume) : values.output ? path.resolve(values.output) :
  path.join(repo, 'bench/harness/results/knowledge', new Date().toISOString().replaceAll(':', '-'));
await fs.mkdir(out, { recursive: true });
const save = async () => {
  report.summary = summarize(report.rows);
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const rows = report.rows;
  await fs.writeFile(path.join(out, 'report.md'), [
    '# Knowledge capture and reuse evaluation', '',
    report.mode === 'validation' ? 'Deterministic mechanism validation. No agent-performance evidence.' :
      'Live ordinary prompts. Fresh conversations and checkouts; automatic private memory disabled. Hooks are disabled to isolate instruction and MCP use.', '',
    'Current versus candidate compares guidance on the same server unless --current-server supplies the released server. Notes is an explicit portable file-memory baseline, not a measurement of native host auto-memory.', '',
    '| Run | Capture | MCP available | Review | Reuse | Control |', '|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${r.capture?.eligibleForReview ? 'eligible' : 'failed'} | ${r.activation ?? 'not applicable'} | ${r.review?.verdict ?? 'pending'} | ${r.reuse ? r.reuse.pass ? 'pass' : 'fail' : 'not run'} | ${r.control?.pass ? 'pass' : 'fail'} |`), '',
    ...rows.flatMap(r => [r.capture?.failures, r.control?.failures, r.reuse?.failures].flatMap(failures => (failures ?? []).map(f => `- ${r.id}: ${f}`))), '',
    'Eligibility checks are necessary structure checks, not semantic approval. Inspect captured records, source evidence and transcripts; supply a digest-bound independent review before reuse. Missing capture is never repaired by the harness.', '',
    'Single runs are smoke tests. Review false captures, failed sessions, retrieval-before-action, behavior, elapsed time and usage before claiming improvement. Native hook activation is not measured here; use bench:automation for lifecycle checks.', '',
  ].join('\n'));
};

async function session(row, stage, root, binary, deterministic = false) {
  const log = path.join(out, row.id + '-' + stage + '-mcp.jsonl');
  if (deterministic) return { log, result: { ok: true, kind: 'deterministic-replay', elapsedMs: 0, costUsd: 0 } };
  const mcpConfig = { mcpServers: row.arm === 'notes' ? {} : { mason: { command: process.execPath, args: [observer, binary, root, log],
    ...(row.host === 'codex' ? { required: true, tools: Object.fromEntries(['get_context', 'get_impact', 'save_decision'].map(name => [name, { approval_mode: 'approve' }])) } : {}),
  } } };
  const result = await runHost({ host: row.host, arm: 'instructions', cwd: root, prompt: prompts[stage],
    mcpConfig, isolated: true, transcript: path.join(out, row.id + '-' + stage + '-transcript.jsonl'), ...report.limits });
  return { log, result };
}

async function replayCapture(row, binary, log) {
  const input = { title: 'Isolated Git checkout location', category: 'convention', owner: 'Platform team', actor: 'Deterministic validator',
    body: `Use ${row.initial.desired}/ for isolated Git worktrees. Incident K17 found that the external build indexer scans .worktrees/ and creates duplicate-source errors; it excludes ${row.initial.desired}/. IDE auto-staging remains suspected, not established.`,
    files: ['.gitignore'], sources: [{ kind: 'incident', reference: '.investigation/notes.md', note: 'Synthetic incident K17' }] };
  if (row.arm === 'notes') await write(row.root, 'PROJECT_NOTES.md', '# Proposed project lesson\n' + input.body + '\nSource: .investigation/notes.md, K17. Owner: Platform team.\n');
  else await withMason(observer, row.root, client => call(client, row.root, 'save_decision', input), [observer, binary, row.root, log]);
}

async function reuse(row, review) {
  const binary = report.binaries[row.arm === 'current' ? 'current' : 'candidate'].path;
  if (digest(await fs.readFile(binary)) !== report.binaries[row.arm === 'current' ? 'current' : 'candidate'].digest) throw new Error('Server changed since capture; start a new run.');
  await acceptReviewed(row.root, row.initial, binary, row.capture, review);
  row.review = review;
  row.capture.semanticReview = review.verdict;
  const fresh = row.root + '-fresh';
  await freshCheckout(row.root, fresh);
  row.fresh = fresh;
  const accepted = (await records(fresh, row.arm))[0];
  const beforeKnowledge = digest(JSON.stringify(await records(fresh, row.arm)));
  const second = await session(row, 'reuse', fresh, binary, report.mode === 'validation');
  if (report.mode === 'validation') {
    if (row.arm !== 'notes') await withMason(observer, fresh, client => call(client, fresh, 'get_context', { task: prompts.reuse, files: ['.gitignore'] }), [observer, binary, fresh, second.log]);
    git(fresh, 'worktree', 'add', '-q', '-b', 'task-change', row.initial.desired + '/task-change');
  }
  row.sessions.reuse = second.result;
  row.reuse = await gradeReuse(fresh, { ...row.initial, head: git(row.root, 'rev-parse', 'HEAD') }, second.result, accepted.id, await receipts(second.log));
  if (report.mode === 'live' && (!second.result.sessionId || second.result.sessionId === row.sessions.capture.sessionId)) {
    row.reuse.pass = false; row.reuse.failures.push('a distinct fresh session was not established');
  }
  if (digest(JSON.stringify(await records(fresh, row.arm))) !== beforeKnowledge) { row.reuse.pass = false; row.reuse.failures.push('agent modified reviewed knowledge during reuse'); }
}

if (values.resume) {
  if (!values.reviews) throw new Error('--resume requires --reviews FILE');
  report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
  const reviews = JSON.parse(await fs.readFile(path.resolve(values.reviews), 'utf8'));
  for (const row of report.rows) {
    if (row.reuse || !row.capture?.eligibleForReview) continue;
    const review = reviews[row.id];
    if (!review) continue;
    if (review.recordDigest !== digest(JSON.stringify(row.capture.saved[0]))) throw new Error('Review digest mismatch: ' + row.id);
    if (!['accept', 'reject'].includes(review.verdict) || !review.reviewer?.trim() || !review.reason?.trim()) throw new Error('Review needs verdict, actual reviewer and reason: ' + row.id);
    if (review.verdict === 'reject') { row.review = review; row.capture.semanticReview = 'reject'; }
    else { console.log('[' + row.id + '] reviewed reuse running'); await reuse(row, review); }
    await save();
  }
} else {
  await fs.access(candidate);
  const current = values['current-server'] ? path.resolve(values['current-server']) : candidate;
  const source = await fs.readFile(path.join(repo, 'src/mcp/init.ts'), 'utf8');
  const candidateGuidance = source.split('export const CLAUDE_MD_SECTION = `')[1].split('`;\n')[0].replaceAll('\\`', '`');
  const currentGuidance = await fs.readFile(new URL('./knowledge/current-guidance.md', import.meta.url), 'utf8');
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mason-knowledge-')));
  report = { version: 1, mode: values.validate ? 'validation' : 'live', workspace, rows: [],
    limits: { timeoutMs, budgetUsd, ...(values.model ? { model: values.model } : {}) },
    hostVersions: Object.fromEntries(selectedHosts.map(h => { try { return [h, values.validate ? 'not-used' : execFileSync(h, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()]; } catch { return [h, 'unavailable']; } })),
    binaries: Object.fromEntries(await Promise.all(Object.entries({ current, candidate }).map(async ([arm, binary]) => [arm, { path: binary, digest: digest(await fs.readFile(binary)) }]))),
    guidanceDigests: { current: digest(currentGuidance), candidate: digest(candidateGuidance) },
    hooks: 'disabled for instruction/MCP evaluation', nativePrivateMemory: 'disabled; no conversation resume',
  };
  console.log('Run: ' + out);
  console.log(values.validate ? 'Deterministic validation; no models.' : `Live sessions: ${timeoutMs / 1000}s each; Claude cap $${budgetUsd}/session, Codex usage recorded without a dollar cap. No automatic retries. Independent review required before reuse.`);
  for (let repeat = 1; repeat <= repeats; repeat++) for (const host of selectedHosts) for (const variant of selectedVariants) {
    // Alternate arm order across repetitions/variants to reduce fixed-order effects.
    const ordered = (repeat + variants.indexOf(variant)) % 2 ? selectedArms : [...selectedArms].reverse();
    for (const arm of ordered) {
      const id = `${host}-${variant}-${repeat}-${arm}`, root = path.join(workspace, id);
      const binary = arm === 'current' ? current : candidate;
      console.log('[' + id + '] capture running');
      const row = { id, host, arm, variant, root, sessions: {} };
      const guidance = arm === 'current' ? currentGuidance : candidateGuidance;
      row.initial = await fixture(root, { arm, guidance, variant });
      const first = await session(row, 'capture', root, binary, values.validate);
      if (values.validate) await replayCapture(row, binary, first.log);
      row.sessions.capture = first.result;
      const observed = await receipts(first.log);
      row.activation = arm === 'notes' ? 'not applicable' : observed.some(e => e.event === 'result' && !e.result?.isError) ? 'tools-used' : observed.some(e => e.event === 'tools-listed') ? 'listed-only' : 'unobserved';
      row.capture = await gradeCapture(root, row.initial, first.result, observed);
      const controlRoot = root + '-control';
      const controlInitial = await fixture(controlRoot, { arm, guidance, variant, control: true });
      const control = await session(row, 'control', controlRoot, binary, values.validate);
      if (values.validate) await write(controlRoot, 'app.mjs', controlInitial.protected['app.mjs'].replaceAll('hello', 'welcome'));
      row.sessions.control = control.result;
      const failures = await integrity(controlRoot, controlInitial, { control: true, allowKnowledge: false });
      const controlRecords = await records(controlRoot, arm);
      if (!control.result.ok) failures.push('control session failed');
      if (controlRecords.length) failures.push('unnecessary knowledge captured on control');
      row.control = { pass: !failures.length, failures, records: controlRecords.length };
      report.rows.push(row);
      if (values.validate) await reuse(row, { verdict: 'accept', reviewer: 'Deterministic validator', reason: 'Known reference proposal in a synthetic mechanism test; not agent performance evidence.', recordDigest: digest(JSON.stringify(row.capture.saved[0])) });
      await save();
      console.log('[' + id + '] capture=' + (row.capture.eligibleForReview ? 'eligible for review' : row.capture.failures.join('; ')) + ' control=' + row.control.pass);
    }
  }
}
await fs.writeFile(path.join(out, 'review-requests.json'), JSON.stringify(Object.fromEntries(report.rows.filter(r => r.capture?.eligibleForReview && !r.review).map(r => [r.id, {
  recordDigest: digest(JSON.stringify(r.capture.saved[0])), proposal: r.capture.saved[0], source: r.initial.source,
  instructions: 'Review usefulness, correct preferred directory/rationale, uncertainty about IDE attribution, supported ownership, and scope. Accept or reject with your actual reviewer identity and reason. Do not edit the proposal to make it pass.',
}])), null, 2));
await save();
const pending = report.rows.some(r => r.capture?.eligibleForReview && !r.review);
console.log('Report: ' + path.join(out, 'report.md'));
process.exitCode = pending ? 2 : report.rows.every(r => r.capture?.eligibleForReview && r.control?.pass && r.reuse?.pass) ? 0 : 1;
