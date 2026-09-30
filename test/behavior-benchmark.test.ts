import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { arms, tasks, schedule, summarize } from '../bench/harness/behavior/protocol.mjs';
import { fixture, grade, replay, write } from '../bench/harness/behavior/fixture.mjs';
import { hostArguments } from '../bench/harness/automation/session.mjs';
const exec = promisify(execFile);
let temp: string;
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mason-behavior-test-')); });
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
const options = (task: any, arm = 'baseline') => ({ task, arm, host: 'claude', binary: path.resolve('dist/mason.js'),
  hookObserver: path.resolve('bench/harness/behavior/observe-hook.mjs'), hookLog: path.join(temp, 'hooks.jsonl'), guidance: 'Use Mason when relevant.' });

it('preregisters 90 reproducible cells with each matched block containing every arm', () => {
  const rows = schedule('example');
  expect(rows).toHaveLength(90);
  expect(rows).toEqual(schedule('example'));
  expect(rows).not.toEqual(schedule('other'));
  expect(new Set(rows.map((r: any) => r.id)).size).toBe(90);
  for (const task of tasks) for (let repeat = 0; repeat < 3; repeat++) {
    expect(rows.filter((r: any) => r.task === task.id && r.repeat === repeat).map((r: any) => r.arm).sort()).toEqual([...arms].sort());
  }
});

it.each(tasks)('independently grades the correct deterministic outcome for $id', async task => {
  const root = path.join(temp, 'project'); const initial = await fixture(root, options(task));
  await replay(root, task, initial);
  expect(await grade(root, task, initial)).toMatchObject({ pass: true, behavior: true, documentation: true });
  // Grading a baseline must not create Mason audit state.
  await expect(fs.access(path.join(root, '.mason'))).rejects.toThrow();
});

it('rejects stale docs, unrelated backlog repair, and implementation breakage independently', async () => {
  const task = tasks.find((t: any) => t.id === 'rename-backlog'); const root = path.join(temp, 'project');
  const initial = await fixture(root, options(task)); await replay(root, task, initial);
  await write(root, 'README.md', initial.contents['README.md']);
  expect((await grade(root, task, initial)).failures).toContain('affected documentation is stale or missing');
  await write(root, 'README.md', `The \`${task.to}/index.mjs\` module exports greeting(). Run \`npm run greet\`.\n`);
  expect((await grade(root, task, initial)).scopeViolations).toContain('unrelated backlog was changed');
  await write(root, 'app.mjs', "console.log('broken')");
  expect((await grade(root, task, initial)).behavior).toBe(false);
});

it('does not treat missing or syntactically valid proposals as semantically reviewed', async () => {
  const task = tasks.find((t: any) => t.id === 'lesson-indexer'); const root = path.join(temp, 'project');
  const initial = await fixture(root, options(task));
  expect((await grade(root, task, initial)).lesson.semanticReview).toBe('pending');
  await write(root, '.mason/decisions/bad.json', JSON.stringify({ approval: 'accepted', body: 'Invented cause' }));
  expect((await grade(root, task, initial)).scopeViolations).toContain('decision accepted without review');
});

it('counts failed agent sessions as failures and keeps lesson review out of automated success rates', () => {
  const rows = [
    { task: 'rename-root', repeat: 0, arm: 'baseline', status: 'complete', taskKind: 'rename', session: { ok: true }, grade: { pass: true } },
    { task: 'rename-root', repeat: 0, arm: 'instructions', status: 'complete', taskKind: 'rename', session: { ok: false }, grade: { pass: true } },
    { task: 'lesson-indexer', repeat: 0, arm: 'instructions', status: 'complete', taskKind: 'lesson', session: { ok: true }, grade: { pass: true } },
  ];
  const result = summarize(rows);
  expect(result.rates.instructions.successRate).toBe(0);
  expect(result.rates.instructions.lessonReviewPending).toBe(1);
  expect(result.comparisons[0].difference).toBe(-1);
});

it('isolates memory and fixes effort equally while enabling hooks only in their arm', () => {
  for (const arm of arms) {
    const args = hostArguments({ host: 'claude', arm, cwd: temp, prompt: 'task', controlled: true, effort: 'medium' });
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('medium');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ autoMemoryEnabled: false, disableAllHooks: arm !== 'hooks' });
  }
});

it('creates a paid-run plan without invoking models or creating populated fixtures', async () => {
  const out = path.join(temp, 'plan');
  await exec(process.execPath, ['bench/harness/run-behavior.mjs', '--plan', '--output', out]);
  const report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
  try {
    expect(report.mode).toBe('plan'); expect(report.rows).toHaveLength(90);
    expect(report.rows.every((r: any) => r.status === 'pending')).toBe(true);
    expect(await fs.readdir(report.workspace)).toEqual([]);
    await expect(fs.access(path.join(out, 'run.lock'))).rejects.toThrow();
  } finally { await fs.rm(report.workspace, { recursive: true, force: true }); }
});

it('accepts equivalent command spelling and rejects a broken API hidden by hardcoded output', async () => {
  const task = tasks.find((t: any) => t.id === 'command-backlog'); const root = path.join(temp, 'project');
  const initial = await fixture(root, options(task)); await replay(root, task, initial);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.scripts[task.to] = 'node ./app.mjs'; await write(root, 'package.json', JSON.stringify(pkg));
  expect((await grade(root, task, initial)).pass).toBe(true);
  const docs = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  await write(root, 'README.md', docs.replace('npm run start', 'npm start'));
  expect((await grade(root, task, initial)).pass).toBe(true);
  await write(root, 'README.md', docs.replace('npm run start', 'npm start-old'));
  expect((await grade(root, task, initial)).documentation).toBe(false);
  await write(root, 'README.md', docs + '\nOld command: npm run start-old\n');
  expect((await grade(root, task, initial)).documentation).toBe(false);
  await write(root, 'README.md', docs);
  await write(root, 'app.mjs', "console.log('hello')");
  await write(root, `${initial.module}/index.mjs`, "export function greeting() { return 'wrong'; }");
  expect((await grade(root, task, initial)).failures).toContain('public greeting API is broken');
});

it('refuses a silent budget change when resuming a frozen plan', async () => {
  const out = path.join(temp, 'plan');
  await exec(process.execPath, ['bench/harness/run-behavior.mjs', '--plan', '--output', out]);
  const report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
  try {
    await expect(exec(process.execPath, ['bench/harness/run-behavior.mjs', '--live', '--resume', out, '--budget-usd', '5'])).rejects.toThrow('Resume uses the saved protocol');
    expect(JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8')).mode).toBe('plan');
  } finally { await fs.rm(report.workspace, { recursive: true, force: true }); }
});

it('keeps task files identical across conditions apart from guidance and hook wiring', async () => {
  const inputs = [];
  for (const arm of arms) inputs.push(await fixture(path.join(temp, arm), options(tasks[0], arm)));
  expect(new Set(inputs.map(x => x.contentHash)).size).toBe(1);
});

it('validates a matched block through the actual observer without any model calls', async () => {
  const out = path.join(temp, 'validate');
  await exec(process.execPath, ['bench/harness/run-behavior.mjs', '--validate', '--tasks', 'rename-nested', '--repeats', '1', '--limit', '3', '--output', out], { timeout: 60000 });
  const report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
  try {
    const completed = report.rows.filter((r: any) => r.status === 'complete');
    expect(completed).toHaveLength(3);
    expect(completed.every((r: any) => r.grade.pass && r.integrationValid && r.session.costUsd === 0)).toBe(true);
    const hooked = completed.find((r: any) => r.arm === 'hooks');
    expect(hooked.observation.agentNotices.length).toBeGreaterThan(0);
    expect(hooked.observation.agentNotices[0].text).toContain('src/message/index.mjs');
    expect(hooked.observation.events).toEqual(expect.arrayContaining(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']));
    expect(new Set(completed.map((r: any) => r.initial.contentHash)).size).toBe(1);
  } finally { await fs.rm(report.workspace, { recursive: true, force: true }); }
}, 65000);

it('selects complete matched blocks and rejects invalid selections', () => {
  const selected = ['rename-root', 'rename-nested', 'rename-backlog'];
  const rows = schedule('delivery-v2', 1, selected);
  expect(rows).toHaveLength(9);
  for (const task of selected) expect(rows.filter((r: any) => r.task === task).map((r: any) => r.arm).sort()).toEqual([...arms].sort());
  expect(() => schedule('test', 1, ['unknown'])).toThrow();
  expect(() => schedule('test', 1, [])).toThrow();
});

it('requires secondary reference documents to follow a staged source migration', async () => {
  const task = tasks.find((t: any) => t.id === 'rename-nested');
  const root = path.join(temp, 'project'); const initial = await fixture(root, options(task));
  await replay(root, task, initial, 'source');
  expect(await grade(root, task, initial)).toMatchObject({ behavior: true, documentation: false });
  await replay(root, task, initial, 'docs');
  expect((await grade(root, task, initial)).pass).toBe(true);
  await write(root, 'docs/operations.md', initial.contents['docs/operations.md']);
  expect((await grade(root, task, initial)).documentation).toBe(false);
});
