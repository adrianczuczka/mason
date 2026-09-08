import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, write, records, git, digest, gradeCapture, acceptReviewed, freshCheckout, gradeReuse, integrity } from '../bench/harness/knowledge/fixture.mjs';
import { withMason, call } from '../bench/harness/knowledge/mcp.mjs';
import { hostArguments, knowledgePermissions } from '../bench/harness/automation/session.mjs';
import { summarize } from '../bench/harness/knowledge/report.mjs';

const exec = promisify(execFile);
const binary = path.resolve('dist/mason-mcp.js');
const observer = path.resolve('bench/harness/knowledge/observe-mcp.mjs');
let dir: string, root: string, initial: any;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mason-knowledge-test-'));
  root = path.join(dir, 'project');
  initial = await fixture(root, { arm: 'candidate', guidance: '', variant: 'checkouts' });
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const lesson = {
  title: 'Git worktree location', category: 'convention', body: 'Use .checkouts/ for Git worktrees. The external indexer scans .worktrees/ and causes duplicate-source errors. Incident K17 selected the excluded .checkouts/ directory. IDE staging is suspected but unproven.',
  owner: 'Platform team', actor: 'Deterministic test', files: ['.gitignore'], sources: [{ kind: 'incident', reference: '.investigation/notes.md' }],
};
async function capture(input = lesson) {
  const result = await withMason(binary, root, client => call(client, root, 'save_decision', input));
  const observed = [{ event: 'result', name: 'save_decision', result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }];
  return { observed, grade: await gradeCapture(root, initial, { ok: true }, observed) };
}
const review = (saved: any) => ({ verdict: 'accept', reviewer: 'Independent test reviewer', reason: 'Verified against synthetic incident K17, including uncertainty and owner.', recordDigest: digest(JSON.stringify(saved)) });

it('validates all three arms and both directory variants through real MCP, review and fresh-checkout reuse', async () => {
  const output = path.join(dir, 'output');
  await exec(process.execPath, ['bench/harness/run-knowledge.mjs', '--validate', '--hosts', 'claude', '--output', output], { timeout: 60000 });
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  try {
    expect(report.mode).toBe('validation');
    expect(report.rows).toHaveLength(6);
    for (const row of report.rows) {
      expect(row.capture.eligibleForReview).toBe(true);
      expect(row.reuse.pass).toBe(true);
      expect(row.control.pass).toBe(true);
      expect(row.sessions.capture.kind).toBe('deterministic-replay');
      await expect(fs.access(path.join(row.fresh, '.investigation'))).rejects.toThrow();
      expect(git(row.fresh, 'remote')).toBe('');
    }
  } finally { await fs.rm(report.workspace, { recursive: true, force: true }); }
}, 65000);

it('refuses to rescue a missed capture with a seeded decision', async () => {
  const grade = await gradeCapture(root, initial, { ok: true });
  expect(grade.eligibleForReview).toBe(false);
  await expect(acceptReviewed(root, initial, binary, grade, review({}))).rejects.toThrow('cannot seed');
  expect(await records(root, 'candidate')).toEqual([]);
});

it('does not count a valid partial record from a failed session as success', async () => {
  const { observed } = await capture();
  const grade = await gradeCapture(root, initial, { ok: false }, observed);
  expect(grade.eligibleForReview).toBe(false);
  expect(grade.failures).toContain('capture session failed');
});

it('keeps missing MCP observation separate from an otherwise usable capture', async () => {
  await capture();
  const grade = await gradeCapture(root, initial, { ok: true }, []);
  expect(grade.failures).toContain('no successful decision capture observed through MCP');
});

it('grades failed MCP responses without crashing or hiding a later successful capture', async () => {
  const { observed } = await capture();
  const failed = { event: 'result', name: 'save_decision', result: { isError: true, content: [{ type: 'text', text: 'unavailable' }] } };
  expect((await gradeCapture(root, initial, { ok: true }, [failed])).eligibleForReview).toBe(false);
  expect((await gradeCapture(root, initial, { ok: true }, [failed, ...observed])).eligibleForReview).toBe(true);
  const reuse = await gradeReuse(root, initial, { ok: true }, 'absent', [{ ...failed, name: 'get_context', worktrees: '' }]);
  expect(reuse.retrievedBeforeAction).toBe(false);
});

it('rejects investigation changes to existing worktrees and their contents', async () => {
  const { observed } = await capture();
  await write(root, '.worktrees/copied/app.mjs', 'changed');
  expect((await gradeCapture(root, initial, { ok: true }, observed)).failures).toContain('existing checkout contents changed during investigation');
  git(root, 'worktree', 'remove', '--force', '.worktrees/copied');
  expect((await gradeCapture(root, initial, { ok: true }, observed)).failures).toContain('existing worktrees changed during investigation');
});

it('rejects unsupported ownership and sources', async () => {
  const { grade } = await capture({ ...lesson, owner: 'Assumed user', sources: [{ kind: 'incident', reference: 'invented incident' }] });
  expect(grade.failures).toContain('unsupported owner');
  expect(grade.failures).toContain('proposal lacks the supplied source');
});

it('does not let keyword eligibility substitute for independent semantic review', async () => {
  const { grade } = await capture({ ...lesson, body: 'Always use .worktrees/ instead of .checkouts/. The indexer causes duplicate-source errors there. K17.' });
  expect(grade.eligibleForReview).toBe(true);
  expect(grade.semanticReview).toBe('required');
  await expect(acceptReviewed(root, initial, binary, grade, null)).rejects.toThrow('independent review');
  expect((await records(root, 'candidate'))[0].approval).toBe('proposed');
});

it('rejects approval performed by the capture agent', async () => {
  const { grade, observed } = await capture();
  await acceptReviewed(root, initial, binary, grade, review(grade.saved[0]));
  const result = await gradeCapture(root, { ...initial, head: git(root, 'rev-parse', 'HEAD') }, { ok: true }, observed);
  expect(result.failures).toContain('agent inferred approval');
});

it('rejects a stale review after the saved proposal changes', async () => {
  const { grade } = await capture();
  const verdict = review(grade.saved[0]);
  await withMason(binary, root, client => call(client, root, 'save_decision', { ...lesson, id: grade.saved[0].id, body: lesson.body + ' Additional claim.' }));
  await expect(acceptReviewed(root, initial, binary, grade, verdict)).rejects.toThrow('changed after capture');
});

it('fails the repeated mistake even when the agent retrieves the decision afterward', async () => {
  const { grade } = await capture();
  await acceptReviewed(root, initial, binary, grade, review(grade.saved[0]));
  const fresh = path.join(dir, 'fresh');
  await freshCheckout(root, fresh);
  git(fresh, 'worktree', 'add', '-q', '-b', 'task-change', '.worktrees/wrong');
  const context = await withMason(binary, fresh, client => call(client, fresh, 'get_context', { task: 'Create isolated Git worktree', files: ['.gitignore'] }));
  const observations = [{ event: 'result', name: 'get_context', worktrees: git(fresh, 'worktree', 'list', '--porcelain'), result: { content: [{ type: 'text', text: JSON.stringify(context) }] } }];
  const result = await gradeReuse(fresh, { ...initial, head: git(root, 'rev-parse', 'HEAD') }, { ok: true }, grade.saved[0].id, observations);
  expect(result.pass).toBe(false);
  expect(result.retrievedBeforeAction).toBe(false);
  expect(result.failures).toContain('new worktree did not use the reviewed directory');
});

it('rejects an unnecessary decision on a control even when the greeting edit is correct', async () => {
  const control = path.join(dir, 'control');
  const base = await fixture(control, { arm: 'candidate', guidance: '', control: true });
  await write(control, 'app.mjs', base.protected['app.mjs'].replaceAll('hello', 'welcome'));
  await withMason(binary, control, client => call(client, control, 'save_decision', lesson));
  expect(await integrity(control, base, { control: true, allowKnowledge: false })).toContain('unexpected file: .mason/decisions/git-worktree-location.json');
});

it('enables only the explicit MCP config and disables conversation persistence and auto-memory in controlled sessions', () => {
  const options = { arm: 'instructions', cwd: '/tmp/fixture', prompt: 'Ordinary task', isolated: true, mcpConfig: { mcpServers: { mason: { command: 'node', args: ['server.mjs'] } } } };
  const claude = hostArguments({ ...options, host: 'claude' });
  expect(claude).toContain('--no-session-persistence');
  expect(claude).toContain(JSON.stringify(options.mcpConfig));
  expect(claude.some(s => s.includes('"autoMemoryEnabled":false'))).toBe(true);
  const codex = hostArguments({ ...options, host: 'codex' });
  expect(codex).toContain('--ephemeral');
  expect(codex).toContain('--ignore-user-config');
  expect(codex).toContain('memories');
  expect(codex.some(s => s.startsWith('mcp_servers=') && s.includes('server.mjs'))).toBe(true);
  expect(codex).not.toContain('--dangerously-bypass-hook-trust');
  expect(codex).not.toContain('--sandbox');
  expect(codex).toContain(knowledgePermissions);
  expect(knowledgePermissions).toBe('permissions.knowledge_eval={extends=":workspace",filesystem={":workspace_roots"={".git"="write"}}}');
});

it('keeps review rejection, failed integration, unknown cost and missing reuse visible in aggregates', () => {
  const groups = summarize([{ host: 'codex', arm: 'candidate', capture: { eligibleForReview: true },
    review: { verdict: 'reject' }, control: { pass: false, records: 1 },
    sessions: { capture: { ok: true, costUsd: null, elapsedMs: 10, mcpFailures: [{ tool: 'get_context' }] }, control: { ok: false, costUsd: null } } }]);
  expect(groups['codex/candidate']).toMatchObject({ runs: 1, acceptedCaptures: 0, rejectedCaptures: 1, reuseAttempts: 0, reusePasses: 0,
    completedControls: 0, controlsWithUnnecessaryRecords: 1, sessionFailures: 1, failedMcpCalls: 1, sessionsWithUnknownCost: 2, knownCostUsd: 0 });
});

it('preserves server instructions and tool definitions through the MCP observer', async () => {
  const original = await withMason(binary, root, async client => ({ instructions: client.getInstructions(), tools: (await client.listTools()).tools }));
  const observed = await withMason(observer, root, async client => ({ instructions: client.getInstructions(), tools: (await client.listTools()).tools }), [observer, binary, root, path.join(dir, 'mcp.jsonl')]);
  expect(observed).toEqual(original);
  expect(observed.instructions).toContain('Save learned rationale');
});
