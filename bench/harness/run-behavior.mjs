import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { runHost } from './automation/session.mjs';
import { arms, tasks, schedule, summarize, digest } from './behavior/protocol.mjs';
import { fixture, grade, replay } from './behavior/fixture.mjs';

const { values } = parseArgs({ options: {
  plan: { type: 'boolean' }, validate: { type: 'boolean' }, live: { type: 'boolean' }, resume: { type: 'string' },
  output: { type: 'string' }, seed: { type: 'string', default: 'mason-behavior-pilot-v1' }, repeats: { type: 'string', default: '3' },
  tasks: { type: 'string' }, limit: { type: 'string' }, model: { type: 'string', default: 'claude-opus-5-5' }, effort: { type: 'string', default: 'medium' },
  'budget-usd': { type: 'string', default: '0.5' }, 'timeout-ms': { type: 'string', default: '180000' },
} });
if ([values.plan, values.validate, values.live].filter(Boolean).length !== 1) throw new Error('Select --plan, --validate, or --live. --resume reuses an existing plan/run.');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = path.join(repo, 'dist/mason.js'), mcpBinary = path.join(repo, 'dist/mason-mcp.js');
const hookObserver = path.join(repo, 'bench/harness/behavior/observe-hook.mjs');
const mcpObserver = path.join(repo, 'bench/harness/knowledge/observe-mcp.mjs');
const limit = values.limit === undefined ? Infinity : Number(values.limit);
if (!(limit > 0 && (limit === Infinity || Number.isInteger(limit)))) throw new Error('limit must be a positive integer');
const out = path.resolve(values.resume ?? values.output ?? path.join(repo, 'bench/harness/results/behavior', new Date().toISOString().replaceAll(':', '-')));
await fs.mkdir(out, { recursive: true });
const lockPath = path.join(out, 'run.lock');
try { const lock = await fs.open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); await lock.close(); }
catch { throw new Error('Run is locked. Confirm its owner has exited before removing run.lock.'); }
process.once('exit', () => { try { unlinkSync(lockPath); } catch {} });
let stopRequested = false;
process.on('SIGINT', () => { stopRequested = true; });
process.on('SIGTERM', () => { stopRequested = true; });
const hashes = {};
for (const file of ['dist/mason.js', 'dist/mason-mcp.js', 'bench/harness/run-behavior.mjs', 'bench/harness/behavior/protocol.mjs', 'bench/harness/behavior/fixture.mjs', 'bench/harness/behavior/observe-hook.mjs', 'bench/harness/automation/session.mjs', 'bench/harness/automation/fixture.mjs', 'bench/harness/knowledge/observe-mcp.mjs', 'bench/harness/knowledge/mcp.mjs', 'package-lock.json', 'src/mcp/init.ts']) hashes[file] = digest(await fs.readFile(path.join(repo, file)));
let report;
if (values.resume) {
  if (process.argv.slice(2).some(arg => ['--tasks', '--output', '--seed', '--repeats', '--model', '--effort', '--budget-usd', '--timeout-ms'].some(key => arg === key || arg.startsWith(key + '=')))) throw new Error('Resume uses the saved protocol and limits; create a new plan to change them.');
  report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
  if (JSON.stringify(hashes) !== JSON.stringify(report.hashes)) throw new Error('Protocol or build changed; start a new experiment instead of mixing versions.');
  if (report.stopReason) throw new Error('Experiment was stopped: ' + report.stopReason + ' Start a new plan.');
  if (report.mode === 'validation' || values.validate) throw new Error('Validation cannot resume into paid evidence.');
  for (const row of report.rows) if (row.status === 'running') { row.status = 'interrupted'; row.error = 'Previous process stopped; no automatic retry.'; }
  if (values.live) report.mode = 'live';
} else {
  await fs.mkdir(out, { recursive: true });
  const guard = await fs.open(path.join(out, 'report.json'), 'wx'); await guard.close();
  const budgetUsd = Number(values['budget-usd']), timeoutMs = Number(values['timeout-ms']);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || !['low', 'medium', 'high'].includes(values.effort)) throw new Error('Invalid limits or effort');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mason-behavior-'));
  report = { version: 1, mode: values.validate ? 'validation' : values.live ? 'live' : 'plan', createdAt: new Date().toISOString(),
    seed: values.seed, hashes, workspace, host: 'claude', nodeVersion: process.version,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), limits: { model: values.model, effort: values.effort, budgetUsd, timeoutMs },
    rows: schedule(values.seed, Number(values.repeats), values.tasks?.split(',')).map(row => ({ ...row, taskKind: tasks.find(t => t.id === row.task).kind, status: 'pending' })) };
}
const save = async () => {
  report.summary = summarize(report.rows);
  const temp = path.join(out, 'report.next.json'); await fs.writeFile(temp, JSON.stringify(report, null, 2)); await fs.rename(temp, path.join(out, 'report.json'));
  await fs.writeFile(path.join(out, 'report.md'), ['# Mason behavior pilot', '',
    report.mode === 'validation' ? 'Deterministic grader validation, not agent-performance evidence.' : `Mode: ${report.mode}. ${report.rows.length} planned sessions; ${report.summary.complete} completed.`, '',
    `Model: ${report.limits.model}; effort: ${report.limits.effort}; per-run cap: $${report.limits.budgetUsd}; maximum planned spend: $${(report.rows.length * report.limits.budgetUsd).toFixed(2)}.`, '',
    '| Arm | Scored tasks | Passes | Scope violations | Cost reported |', '|---|---:|---:|---:|---:|',
    ...arms.map(arm => { const s = report.summary.rates[arm]; return `| ${arm} | ${s.objectivelyScored} | ${s.passed} | ${s.scopeViolations} | ${s.costUsd === null ? 'unavailable' : '$' + s.costUsd.toFixed(2)} (${s.costCoverage}/${s.attempted} runs) |`; }), '',
    ...arms.map(arm => `- ${arm}: ${report.summary.rates[arm].activationFailures} activation failures; ${report.summary.rates[arm].modelMismatches} model mismatches. Investigate either before interpreting differences.`), '',
    'Lesson outcomes require independent semantic review. Automated outcome scores exclude lesson tasks. Failed agent sessions count as failures; interrupted infrastructure runs are shown separately. No causal claims from a notice followed by an edit.', '',
    'Paired comparisons (exploratory task-cluster bootstrap):', ...report.summary.comparisons.map(c => `- ${c.a} minus ${c.b}: ${c.difference === null ? 'not available' : c.difference.toFixed(3)}; interval ${JSON.stringify(c.interval)}; ${c.taskFamilies} task families.`), '',
    'Review packets omit arm labels, but outputs can reveal Mason use. Randomized repeats of a few synthetic tasks do not establish general effectiveness.', '',
  ].join('\n'));
};
await save();
console.log(`Report: ${out}\n${report.rows.length} planned runs; maximum $${(report.rows.length * report.limits.budgetUsd).toFixed(2)}. Mode: ${report.mode}.`);
if (values.plan) process.exit(0);
if (values.live) report.hostVersion = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
const source = await fs.readFile(path.join(repo, 'src/mcp/init.ts'), 'utf8');
const guidance = source.split('export const CLAUDE_MD_SECTION = `')[1].split('`;\n')[0].replaceAll('\\`', '`');
let count = 0;
for (const row of report.rows) {
  if (stopRequested) break;
  if (row.status !== 'pending' || count >= limit) continue;
  const changed = [];
  for (const [file, hash] of Object.entries(report.hashes)) if (digest(await fs.readFile(path.join(repo, file))) !== hash) changed.push(file);
  if (changed.length) { report.stopReason = 'Protocol changed during execution: ' + changed.join(', '); await save(); break; }
  count++;
  const task = tasks.find(t => t.id === row.task);
  row.root = path.join(report.workspace, row.id); row.status = 'running'; row.startedAt = new Date().toISOString(); await save();
  console.log(`[${count}] ${row.id} ${row.task}/${row.arm}`);
  try {
    const hookLog = path.join(out, `${row.id}-hooks.jsonl`), mcpLog = path.join(out, `${row.id}-mcp.jsonl`);
    row.initial = await fixture(row.root, { task, arm: row.arm, host: report.host, binary, hookObserver, hookLog, guidance });
    const peer = report.rows.find(r => r.task === row.task && r.id !== row.id && r.initial);
    if (peer && peer.initial.contentHash !== row.initial.contentHash) throw new Error('Task content differs between matched conditions.');
    if (values.validate) {
      const fire = event => {
        if (row.arm !== 'hooks') return;
        execFileSync(process.execPath, [hookObserver, binary, hookLog, 'hook', '--host', report.host], {
          cwd: row.root, encoding: 'utf8', input: JSON.stringify({ cwd: row.root, session_id: row.id,
            hook_event_name: event, tool_name: 'Bash', tool_use_id: 'change' }), timeout: 40000,
        });
      };
      fire('SessionStart'); fire('PreToolUse');
      if (task.kind === 'rename') {
        await replay(row.root, task, row.initial, 'source'); fire('PostToolUse'); fire('PreToolUse');
        await replay(row.root, task, row.initial, 'docs');
      } else await replay(row.root, task, row.initial);
      fire('PostToolUse'); fire('Stop');
      row.session = { ok: true, kind: 'deterministic-replay', elapsedMs: 0, costUsd: 0 };
    } else {
      const mcpConfig = { mcpServers: row.arm === 'baseline' ? {} : { mason: { command: process.execPath, args: [mcpObserver, mcpBinary, row.root, mcpLog] } } };
      row.session = await runHost({ host: report.host, arm: row.arm, cwd: row.root, prompt: row.initial.prompt, controlled: true,
        mcpConfig, transcript: path.join(out, `${row.id}-transcript.jsonl`), ...report.limits });
    }
    row.modelVerified = values.validate || (row.session.models?.length > 0 && row.session.models.every(m => m.replace(/\[.*\]$/, '') === report.limits.model));
    row.grade = await grade(row.root, task, row.initial);
    const receipts = (await fs.readFile(hookLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    row.observation = { events: [...new Set(receipts.map(r => r.event))],
      agentNotices: receipts.filter(r => r.output?.hookSpecificOutput?.additionalContext?.includes('new or worsened')).map(r => ({ at: r.completedAt, toolId: r.toolId, text: r.output.hookSpecificOutput.additionalContext })),
      completionNotices: receipts.filter(r => r.event === 'Stop' && r.output?.systemMessage?.includes('new or worsened')).length,
      errors: receipts.filter(r => r.code !== 0 || r.error).length,
      mcpAvailable: (await fs.readFile(mcpLog, 'utf8').catch(() => '')).includes('tools-listed') };
    row.integrationValid = (values.validate || row.arm === 'baseline' || row.observation.mcpAvailable) && (row.arm !== 'hooks' || ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].every(e => row.observation.events.includes(e)) && row.observation.errors === 0);
    const patch = execFileSync('git', ['diff', row.initial.head, '--', '.', ':!AGENTS.md', ':!CLAUDE.md', ':!.mason'], { cwd: row.root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    await fs.mkdir(path.join(out, 'review'), { recursive: true });
    await fs.writeFile(path.join(out, 'review', `${row.id}.json`), JSON.stringify({ id: row.id, prompt: row.initial.prompt,
      sourceEvidence: row.initial.contents['incident.md'] ?? null, response: row.session.result ?? null, patch,
      proposedKnowledge: row.grade.lesson, rubric: ['Correct requested behavior?', 'Affected documentation accurate?', 'Unrelated changes?', 'Evidence supports claims?', 'Would you accept this proposal without revision?'] }, null, 2));
    row.status = 'complete'; row.completedAt = new Date().toISOString();
    console.log(`  session=${row.session.ok} outcome=${row.grade.pass} integration=${row.integrationValid}`);
  } catch (error) { row.status = 'interrupted'; row.error = String(error.stack ?? error); console.error(row.error); }
  await save();
  if (values.live && row.session?.ok && !row.modelVerified) { report.stopReason = 'Observed model differs from the requested model; inspect before continuing.'; await save(); break; }
}
console.log(`Finished ${count} attempted cells. Results: ${out}`);
if (values.validate && report.rows.some(r => r.status === 'interrupted' || r.status === 'complete' && (!r.grade.pass || !r.integrationValid))) process.exitCode = 1;

if (report.stopReason) { console.error(report.stopReason); process.exitCode = 2; }
