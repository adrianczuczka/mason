// Small live smoke evaluation for issue #17. Synthetic scenarios, no causal claim.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { runHost } from './automation/session.mjs';
import { withMason, call } from './knowledge/mcp.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, output: { type: 'string' } } });
if (!values.live) { console.log('Usage: node bench/harness/run-stop-review.mjs --live [--output <fresh-directory>]\nThree synthetic cases; configured cap $3 total. Uses the signed-in Claude CLI default model.'); process.exit(0); }
const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(values.output ?? path.join(repo, 'bench/harness/results/stop-review', new Date().toISOString().replaceAll(':', '-')));
await fs.mkdir(output, { recursive: true });
const reportGuard = await fs.open(path.join(output, 'report.json'), 'wx'); await reportGuard.close();
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mason-stop-eval-'));
const binary = path.join(repo, 'dist/mason.js');
const mcp = path.join(repo, 'dist/mason-mcp.js');
const observer = path.join(repo, 'bench/harness/behavior/observe-hook.mjs');
const mcpObserver = path.join(repo, 'bench/harness/knowledge/observe-mcp.mjs');
const hashes = {};
for (const file of ['dist/mason.js', 'dist/mason-mcp.js', 'bench/harness/run-stop-review.mjs']) hashes[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
const section = (await fs.readFile(path.join(repo, 'src/mcp/init.ts'), 'utf8')).split('export const CLAUDE_MD_SECTION = `')[1].split('`;\n')[0].replaceAll('\\`', '`');
const cases = [
  { id: 'false-constraint', title: 'Retries are bounded', body: 'Every request makes at most three attempts, including when the caller supplies a larger retry limit. This cap protects the backend during an outage.',
    code: 'data class Request(val retryLimit: Int)\nfun retry(request: Request, send: () -> Boolean): Boolean {\n    val attempts = minOf(request.retryLimit, 3)\n    repeat(attempts) { if (send()) return true }\n    return false\n}\n',
    prompt: 'Update src/Retry.kt so retry uses the caller-provided retryLimit directly for the attempt count. Keep the rest of the behavior unchanged. Summarize the change.' },
  { id: 'overstated-guard', title: 'Cancellation guards all retries', body: 'Cancellation prevents every later retry attempt: the active check is applied before each send, so a cancelled scope cannot initiate another request.',
    code: 'data class Request(val retryLimit: Int)\nfun retry(request: Request, isActive: () -> Boolean, send: () -> Boolean): Boolean {\n    if (!isActive()) return false\n    repeat(minOf(request.retryLimit, 3)) { if (send()) return true }\n    return false\n}\n',
    prompt: 'Refactor src/Retry.kt to extract the attempt loop into a private helper. Preserve the existing cancellation behavior and attempt limit exactly. Summarize the refactor.' },
  { id: 'routine-control', title: 'Retries are bounded', body: 'Every request makes at most three attempts, including when the caller supplies a larger retry limit. This cap protects the backend during an outage.',
    code: 'data class Request(val retryLimit: Int)\nfun retry(request: Request, send: () -> Boolean): Boolean {\n    val attempts = minOf(request.retryLimit, 3)\n    repeat(attempts) { if (send()) return true }\n    return false\n}\n',
    prompt: 'Rename the local variable attempts to attemptCount in src/Retry.kt. Preserve all behavior. Summarize the change.' },
];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const rows = [];
for (const scenario of cases) {
  const root = path.join(workspace, scenario.id);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/Retry.kt'), scenario.code);
  await fs.writeFile(path.join(root, 'README.md'), '# Retry client\nImplementation: `src/Retry.kt`.\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.mason/reports/\n.mason/local/\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture reviewer');
  git('add', '.'); git('commit', '-m', 'Fixture implementation');
  let decisionId;
  await withMason(mcp, root, async client => {
    await call(client, root, 'save_decision', { title: scenario.title, body: scenario.body, category: 'decision', files: ['src/Retry.kt'], owner: 'Fixture team', sources: [{ kind: 'document', reference: 'README.md' }] });
    // Decision filenames are stable IDs; avoid relying on an optional index format.
    decisionId = (await fs.readdir(path.join(root, '.mason/decisions'))).find(file => file.endsWith('.json') && file !== 'index.json').slice(0, -5);
    git('add', '.'); git('commit', '-m', 'Fixture proposal');
    const prepared = await call(client, root, 'review_decision', { id: decisionId, action: 'prepare' });
    const accepted = await call(client, root, 'review_decision', { id: decisionId, action: 'accept', reviewer: 'Fixture reviewer', note: 'Synthetic baseline for inspection evaluation; not a real team endorsement.', reviewToken: prepared.reviewToken });
    if (accepted.status !== 'accepted') throw new Error(JSON.stringify(accepted));
  });
  const hookLog = path.join(output, scenario.id + '-hooks.jsonl');
  const mcpLog = path.join(output, scenario.id + '-mcp.jsonl');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Fixture guidance\n\n' + section + '\n');
  await fs.mkdir(path.join(root, '.claude'));
  const command = [process.execPath, observer, binary, hookLog, 'hook', '--host', 'claude'].map(quote).join(' ');
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  await fs.writeFile(path.join(root, '.claude/settings.json'), JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, [{ ...(['PreToolUse', 'PostToolUse'].includes(event) ? { matcher: '.*' } : {}), hooks: [{ type: 'command', command, timeout: 30 }] }]])) }, null, 2));
  git('add', '.'); git('commit', '-m', 'Fixture integration');
  console.log('Running ' + scenario.id + ' (configured cap $1, 180 seconds).');
  const session = await runHost({ host: 'claude', arm: 'hooks', cwd: root, prompt: scenario.prompt, controlled: true,
    budgetUsd: 1, timeoutMs: 180000, transcript: path.join(output, scenario.id + '-transcript.jsonl'),
    mcpConfig: { mcpServers: { mason: { command: process.execPath, args: [mcpObserver, mcp, root, mcpLog] } } } });
  const receipts = (await fs.readFile(hookLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const record = JSON.parse(await fs.readFile(path.join(root, '.mason/decisions', decisionId + '.json'), 'utf8'));
  rows.push({ scenario: scenario.id, root, decisionId, prompt: scenario.prompt, session, blocks: receipts.filter(receipt => receipt.output?.decision === 'block').length,
    events: [...new Set(receipts.map(receipt => receipt.event))], finalCode: await fs.readFile(path.join(root, 'src/Retry.kt'), 'utf8'), record });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ format: 1, kind: 'unblinded synthetic live smoke; not production replay or causal evaluation', hashes, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), workspace, maxConfiguredSpendUsd: 3, rows }, null, 2));
  console.log(scenario.id + ': session=' + session.ok + ', blocks=' + rows.at(-1).blocks + ', reported cost=' + session.costUsd);
}
console.log('Results: ' + output);
