import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, grade, integrity, reviewPacket, accept, appText, initialApp } from '../bench/harness/knowledge/startup-fixture.mjs';
import { inspectToolchain, validateKeepRules, parseConfiguration } from '../bench/harness/knowledge/startup-native.mjs';
import { write, digest, receipts, records, git } from '../bench/harness/knowledge/fixture.mjs';
import { withMason, call } from '../bench/harness/knowledge/mcp.mjs';

const exec = promisify(execFile), binary = path.resolve('dist/mason-mcp.js');
const observer = path.resolve('bench/harness/knowledge/observe-mcp.mjs');
const r8 = process.env.MASON_EVAL_R8_JAR, jdk = process.env.MASON_EVAL_JAVA_HOME;
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mason-lifecycle-test-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it('refuses shrinker bypasses, included configuration and hidden application flags', () => {
  for (const rules of ['-dontshrink', '-include /tmp/other.pro', '@other.pro', '-printconfiguration /tmp/output', '-keep class fixture.GeneratedDatabase { <init>(); }\n-dontoptimize']) {
    expect(() => validateKeepRules(rules)).toThrow('Unsupported keep rule');
  }
  expect(() => parseConfiguration(JSON.stringify({ ...initialApp, skipStartup: true }))).toThrow();
});

it('keeps the native toolchain unavailable until explicitly supplied', async () => {
  await expect(inspectToolchain(undefined, undefined)).rejects.toThrow('No automatic downloads');
});

it('rejects checker tampering and knowledge capture on the unrelated control', async () => {
  const root = path.join(dir, 'control');
  const before = await fixture(root, { arm: 'notes', guidance: '', toolchain: {}, control: true });
  await write(root, 'greeting.txt', 'welcome\n');
  expect((await grade(root, before, 'control', { ok: true }, [], {})).pass).toBe(true);
  await write(root, 'PROJECT_NOTES.md', 'A new greeting was added.');
  const falseCapture = await grade(root, before, 'control', { ok: true }, [], {});
  expect(falseCapture.pass).toBe(false);
  expect(falseCapture.failures).toContain('unnecessary knowledge change');
  await write(root, 'check.mjs', 'process.exit(0)');
  expect(await integrity(root, before, 'control')).toContain('protected or unexpected file changed: check.mjs');
});

it('observes file state at retrieval and preserves the underlying MCP response', async () => {
  const root = path.join(dir, 'observed'), log = path.join(dir, 'calls.jsonl');
  const before = await fixture(root, { arm: 'candidate', guidance: '', toolchain: {} });
  const response = await withMason(observer, root, c => call(c, root, 'get_context', { task: 'background scheduler', files: ['app.json'] }), [observer, binary, root, log, '["app.json","keep.pro"]']);
  const observed = (await receipts(log)).find((e: any) => e.event === 'result');
  expect(JSON.parse(observed.result.content[0].text)).toEqual(response);
  expect(observed.witness).toEqual({ 'app.json': digest(before.files['app.json']), 'keep.pro': digest('') });
});

it.skipIf(!r8 || !jdk)('validates both arms through actual shrinking, two reviews, final commits and fresh checkouts', async () => {
  const output = path.join(dir, 'output');
  await exec(process.execPath, ['bench/harness/run-lifecycle.mjs', '--validate', '--output', output], { timeout: 120000 });
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  try {
    expect(report.summary).toEqual({ passed: 2, total: 2, pendingReviews: 0 });
    expect(report.preflight['release-regression'].stderr).toContain('NoSuchMethodException');
    expect(report.preflight.alternative.pass).toBe(true);
    const retained = await fs.readFile(path.join(output, 'report.json'), 'utf8');
    await expect(exec(process.execPath, ['bench/harness/run-lifecycle.mjs', '--regrade', output, '--reason', 'A reviewed run must remain immutable.'])).rejects.toThrow();
    expect(await fs.readFile(path.join(output, 'report.json'), 'utf8')).toBe(retained);
    for (const row of report.rows) {
      expect(row.stages.followup.grade.native.stdout).toContain('JOBS:forecast,cleanup');
      const fresh = row.stages.followup.root;
      await expect(fs.access(path.join(fresh, '.investigation'))).rejects.toThrow();
      expect(git(fresh, 'remote')).toBe('');
      if (row.arm === 'candidate') {
        expect(row.stages.reconsider.grade.retrievedBeforeAction).toBe(true);
        expect(row.stages.followup.grade.retrievedBeforeAction).toBe(true);
        const record = (await records(fresh, row.arm))[0];
        expect(record.approval).toBe('accepted');
        expect(record.revision).toBe(2);
        expect(record.history.filter((e: any) => e.kind === 'accepted')).toHaveLength(2);
        const events = await receipts(row.stages.followup.log);
        const late = events.map((e: any) => ({ ...e, witness: { ...e.witness, 'app.json': 'after-edit' } }));
        const failed = await grade(fresh, row.stages.followup.before, 'followup', { ok: true }, late, report.toolchain);
        expect(failed.failures).toContain('accepted revision was not retrieved before application edits');
        const config = JSON.parse(await fs.readFile(path.join(fresh, 'app.json'), 'utf8'));
        await write(fresh, 'app.json', appText({ ...config, jobs: ['forecast', 'cachecleanup'] }));
        expect((await grade(fresh, row.stages.followup.before, 'followup', { ok: true }, events, report.toolchain)).pass).toBe(true);
        await write(fresh, 'app.json', appText({ ...config, jobs: ['cachecleanup', 'anotherjob'] }));
        expect((await grade(fresh, row.stages.followup.before, 'followup', { ok: true }, events, report.toolchain)).failures).toContain('requested background jobs are not configured');
      } else {
        const reviews = JSON.parse(await fs.readFile(path.join(fresh, 'PROJECT_NOTES_REVIEW.json'), 'utf8'));
        expect(reviews.history).toHaveLength(2);
        expect(reviews.acceptedBody).toContain('now required');
      }
    }
  } finally { await fs.rm(report.workspace, { recursive: true, force: true }); }
}, 130000);

it.skipIf(!r8 || !jdk)('rejects stale semantic approval and refuses to rescue a failed capture', async () => {
  const toolchain = await inspectToolchain(r8, jdk), root = path.join(dir, 'review');
  const before = await fixture(root, { arm: 'notes', guidance: '', toolchain });
  await write(root, 'app.json', appText({ ...initialApp, schedulerDependency: false }));
  await write(root, 'PROJECT_NOTES.md', 'Proposed: remove the unused integration; verify minified startup if reintroduced. Source: R17. Owner: Mobile team.');
  const result = await grade(root, before, 'capture', { ok: true }, [], toolchain);
  const packet = await reviewPacket(root, before, result, 'capture');
  const review = { verdict: 'accept', reviewer: 'Synthetic test reviewer', reason: 'Inspected fixture evidence.', reviewDigest: packet.reviewDigest };
  await write(root, 'PROJECT_NOTES.md', 'Proposed: permanently ban scheduling. Source: R17. Owner: Mobile team.');
  await expect(accept(root, before, result, 'capture', review, binary, [], toolchain)).rejects.toThrow('absent or stale');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head);
  const failed = await grade(root, before, 'capture', { ok: false }, [], toolchain);
  expect(failed.eligibleForReview).toBe(false);
  await expect(accept(root, before, failed, 'capture', review, binary, [], toolchain)).rejects.toThrow('cannot be seeded');
}, 30000);
