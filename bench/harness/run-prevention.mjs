// Independent seeded-lesson comparison against current Mason; no product changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { fixture, cases, arms, prompts, grade, replay, observations } from './knowledge/prevention-fixture.mjs';
import { inspectToolchain, runStartup } from './knowledge/startup-native.mjs';
import { appText, initialApp, referenceRules } from './knowledge/startup-fixture.mjs';
import { digest, receipts } from './knowledge/fixture.mjs';
import { runHost } from './automation/session.mjs';
import { withMason, call } from './knowledge/mcp.mjs';
const { values } = parseArgs({ options: { validate: { type: 'boolean' }, live: { type: 'boolean' }, output: { type: 'string' }, 'r8-jar': { type: 'string' }, 'java-home': { type: 'string' }, 'baseline-dir': { type: 'string' } } });
if (Number(!!values.validate) + Number(!!values.live) !== 1) throw new Error('Select --validate or --live');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const out = path.resolve(values.output ?? path.join(repo, 'bench/harness/results/prevention', new Date().toISOString().replaceAll(':', '-')));
await fs.mkdir(out, { recursive: true });
const guard = await fs.open(path.join(out, 'report.json'), 'wx'); await guard.close();
const binary = path.join(repo, 'dist/mason.js'), mcp = path.join(repo, 'dist/mason-mcp.js');
const baselineDir = values['baseline-dir'] ? await fs.realpath(path.resolve(values['baseline-dir'])) : null;
const baselineBinary = baselineDir ? path.join(baselineDir, 'mason.js') : binary;
const baselineMcp = baselineDir ? path.join(baselineDir, 'mason-mcp.js') : mcp;
const conditions = baselineDir ? [...arms, 'candidate'] : arms;
const observer = path.join(repo, 'bench/harness/knowledge/observe-prevention-hook.mjs');
const mcpObserver = path.join(repo, 'bench/harness/knowledge/observe-mcp.mjs');
const source = await fs.readFile(path.join(repo, 'src/mcp/init.ts'), 'utf8');
const guidance = source.split('export const CLAUDE_MD_SECTION = `')[1].split('`;\n')[0].replaceAll('\\`', '`');
const tracked = ['dist/mason.js', 'dist/mason-mcp.js', 'dist/mason-runtime.js', 'src/mcp/init.ts', 'bench/harness/run-prevention.mjs', 'bench/harness/knowledge/prevention-fixture.mjs', 'bench/harness/knowledge/observe-prevention-hook.mjs', 'bench/harness/knowledge/observe-mcp.mjs', 'bench/harness/knowledge/startup-fixture.mjs', 'bench/harness/knowledge/startup-native.mjs', 'bench/harness/knowledge/fixture.mjs', 'bench/harness/knowledge/mcp.mjs', 'bench/harness/automation/session.mjs', 'bench/harness/automation/fixture.mjs', 'bench/harness/knowledge/HOOK_PREVENTION_EXPERIMENT.md', ...(baselineDir ? [baselineBinary, baselineMcp, path.join(baselineDir, 'mason-runtime.js'), 'bench/harness/knowledge/STANDARD_DELIVERY_EXPERIMENT.md'] : [])];
const fingerprints = async () => Object.fromEntries(await Promise.all(tracked.map(async f => [f, digest(await fs.readFile(path.isAbsolute(f) ? f : path.join(repo, f)))])));
const toolchain = await inspectToolchain(values['r8-jar'] ?? process.env.MASON_EVAL_R8_JAR, values['java-home'] ?? process.env.MASON_EVAL_JAVA_HOME);
const preflight = {};
for (const [name, app, rules, mode, expected] of [
  ['debug', initialApp, '', 'debug', true], ['violation', initialApp, '', 'release', false],
  ['removal', { ...initialApp, schedulerDependency: false }, '', 'release', true],
  ['reference', { ...initialApp, backgroundEnabled: true, requestedBackground: true, jobs: ['forecast'] }, referenceRules, 'release', true],
  ['alternative', { ...initialApp, backgroundEnabled: true, requestedBackground: true, jobs: ['forecast'] }, '-keepclassmembers class fixture.GeneratedDatabase { public <init>(); }', 'release', true],
]) {
  preflight[name] = await runStartup(appText(app), rules, toolchain, mode);
  if (preflight[name].pass !== expected || !expected && !preflight[name].stderr.includes('NoSuchMethodException')) throw new Error('Native preflight failed: ' + name);
}
const report = { version: 1, mode: values.validate ? 'validation' : 'live', sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), hashes: await fingerprints(), toolchain, preflight,
  host: 'claude', hostVersion: values.live ? execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim() : 'not-used',
  limits: { budgetUsd: 1, timeoutMs: 180000, model: 'host default', effort: 'host default' }, maxConfiguredSpendUsd: values.live ? cases.length * conditions.length : 0, baselineDir,
  workspace: await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mason-prevention-'))),
  schedule: cases.flatMap((scenario, index) => conditions.map((_, i) => ({ scenario, arm: conditions[(i + index) % conditions.length] }))), rows: [], semanticReview: 'pending; separate unblinded transcript review required' };
const save = async () => {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'report.md'), ['# Seeded hook prevention comparison', '', `Mode: ${report.mode}. Maximum configured spend: $${report.maxConfiguredSpendUsd}.`, '',
    '| Case | Arm | Session | Mechanical grade | MCP before edit | Hook errors | Stop blocks |', '|---|---|---|---|---|---:|---:|',
    ...report.rows.map(r => `| ${r.scenario} | ${r.arm} | ${r.session?.ok ?? 'incomplete'} | ${r.grade?.pass ?? 'incomplete'} | ${r.observation?.mcpBeforeEdit ?? 'unknown'} | ${r.observation?.hookErrors ?? 'unknown'} | ${r.observation?.stopBlocks ?? 'unknown'} |`), '',
    'Mechanical grades do not establish semantic conflict recognition, notes timing, useful hook delivery, or causality. Separate transcript review is required. Standard lifecycle hooks are used; candidate selects the current build while hooks selects the saved baseline when --baseline-dir is supplied. The standalone mason-hook is not installed. No model retries or pooled comparison with Codex.', '',
  ].join('\n'));
};
await save(); console.log('Output: ' + out + `; ${report.schedule.length} cells, $1 and 180 seconds per live session.`);
let stopRequested = false;
process.on('SIGINT', () => { stopRequested = true; });
process.on('SIGTERM', () => { stopRequested = true; });
for (const cell of report.schedule) {
  if (stopRequested) { report.stopReason = 'Interrupted by signal; no automatic retries.'; break; }
  if (JSON.stringify(await fingerprints()) !== JSON.stringify(report.hashes)) throw new Error('Execution fingerprint changed; start a new run');
  const id = cell.scenario + '-' + cell.arm;
  const root = path.join(report.workspace, id), hookLog = path.join(out, id + '-hooks.jsonl'), mcpLog = path.join(out, id + '-mcp.jsonl');
  const cellBinary = cell.arm === 'candidate' ? binary : baselineBinary;
  const cellMcp = cell.arm === 'candidate' ? mcp : baselineMcp;
  const hooked = ['hooks', 'candidate'].includes(cell.arm);
  const row = { ...cell, root, hookLog, mcpLog, binary: cellBinary, mcp: cellMcp, status: 'running' }; report.rows.push(row); await save();
  console.log('Running ' + id);
  try {
    row.initial = await fixture(root, { ...cell, arm: cell.arm === 'candidate' ? 'hooks' : cell.arm, guidance, toolchain, binary: cellBinary, mcp: cellMcp, observer, hookLog });
    const observerArgs = [mcpObserver, cellMcp, root, mcpLog, '["app.json","keep.pro"]'];
    if (values.validate) {
      const fire = (event, tool, toolId) => {
        if (hooked) execFileSync(process.execPath, [observer, cellBinary, hookLog, 'hook', '--host', 'claude'], { cwd: root, encoding: 'utf8', timeout: 40000,
          input: JSON.stringify({ cwd: root, session_id: id, hook_event_name: event, tool_name: tool, tool_use_id: toolId, tool_input: { file_path: path.join(root, cell.scenario === 'unrelated' ? 'greeting.txt' : 'app.json') } }) });
      };
      fire('SessionStart'); fire('UserPromptSubmit');
      for (let i = 0; i < (cell.scenario === 'repeated' ? 3 : 1); i++) { fire('PreToolUse', 'Read', 'read-' + i); fire('PostToolUse', 'Read', 'read-' + i); }
      if (cell.arm !== 'notes' && cell.scenario !== 'unrelated') await withMason(mcpObserver, root, c => call(c, root, 'get_context', { task: prompts[cell.scenario], files: ['app.json', 'keep.pro'] }), observerArgs);
      fire('PreToolUse', 'Edit', 'edit'); await replay(root, cell.scenario); fire('PostToolUse', 'Edit', 'edit'); fire('Stop');
      row.session = { ok: true, kind: 'reference replay', costUsd: 0, elapsedMs: 0 };
    } else row.session = await runHost({ host: 'claude', arm: hooked ? 'hooks' : 'instructions', cwd: root, prompt: prompts[cell.scenario], controlled: true,
      budgetUsd: 1, timeoutMs: 180000, transcript: path.join(out, id + '-transcript.jsonl'), mcpConfig: { mcpServers: cell.arm === 'notes' ? {} : { mason: { command: process.execPath, args: observerArgs } } } });
    const mcpEvents = await receipts(mcpLog);
    row.grade = await grade(root, row.initial, cell.scenario, row.session, toolchain, mcpEvents);
    row.observation = observations(row.initial, await receipts(hookLog), mcpEvents);
    if (values.validate && baselineDir) {
      const bodies = row.initial.knowledge.map(d => d.body);
      const fullLessons = row.observation.notices.filter(n => n.beforeEdit && bodies.every(body => n.text.includes(body)));
      const expected = cell.arm === 'candidate' && cell.scenario !== 'unrelated' ? 1 : 0;
      row.deliveryValidated = fullLessons.length === expected;
      if (!row.deliveryValidated) { row.grade.pass = false; row.grade.failures.push('Unexpected pre-edit lesson count: ' + fullLessons.length + '; expected ' + expected); }
    }
    row.integrationValid = !hooked || ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].every(e => row.observation.hookEvents.includes(e)) && row.observation.hookErrors === 0;
    row.status = 'complete';
    console.log(id + ': mechanical=' + row.grade.pass + ', integration=' + row.integrationValid + ', cost=' + row.session.costUsd);
  } catch (e) { row.status = 'failed'; row.error = String(e.stack ?? e); console.error(row.error); }
  await save();
}
report.summary = { attempted: report.rows.length, mechanicalPasses: report.rows.filter(r => r.grade?.pass && r.integrationValid).length, reportedCostUsd: report.rows.reduce((n, r) => n + (r.session?.costUsd ?? 0), 0), costCoverage: report.rows.filter(r => r.session?.costUsd != null).length };
await save();
if (report.rows.some(r => !r.grade?.pass || !r.integrationValid)) process.exitCode = 1;
