import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initialState, transition, gradeActions } from '../bench/harness/knowledge/publish-model.mjs';
import { fixture, grade, packet, accept, referenceNotes } from '../bench/harness/knowledge/upload-fixture.mjs';
import { digest, records, git, write } from '../bench/harness/knowledge/fixture.mjs';

const exec = promisify(execFile), binary = path.resolve('dist/mason-mcp.js');
const release = { editId: 'original-edit', version: 42, sha256: digest('artifact') };
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mason-upload-test-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
function replay(scenario: string, steps: [string, any][], identity = release) {
  const state = initialState(scenario, identity);
  return steps.map(([name, args]) => ({ event: 'publish-result', name, args, response: transition(state, name, args, identity) }));
}
const expiredSteps: [string, any][] = [['inspect_edit', { editId: 'original-edit' }], ['create_edit', {}],
  ...['upload_bundle', 'attach_mapping', 'finish_edit'].map(name => [name, { editId: 'recovery-1' }] as [string, any])];

it('distinguishes expired-edit recovery, a first upload, and reuse of an already matching bundle', () => {
  expect(gradeActions(replay('expired', expiredSteps), release, 'expired').pass).toBe(true);
  const activeSteps = ['inspect_edit', 'upload_bundle', 'attach_mapping', 'finish_edit'].map(name => [name, { editId: release.editId }] as [string, any]);
  expect(gradeActions(replay('empty', activeSteps), release, 'empty').pass).toBe(true);
  const matchedSteps = activeSteps.filter(([name]) => name !== 'upload_bundle');
  expect(gradeActions(replay('matched', matchedSteps), release, 'matched').pass).toBe(true);
});

it('rejects repeating side effects before inspecting the retained edit', () => {
  const actions = replay('expired', expiredSteps.slice(1));
  expect(gradeActions(actions, release, 'expired').failures).toContain('original edit not inspected before side effects');
  const repeated = replay('matched', ['inspect_edit', 'upload_bundle', 'attach_mapping', 'finish_edit'].map(name => [name, { editId: release.editId }]));
  expect(repeated[1].response).toEqual({ error: 'bundle_already_present' });
  expect(gradeActions(repeated, release, 'matched').pass).toBe(false);
});

it('does not complete a mismatched artifact or accept forged success receipts', () => {
  const actions = replay('mismatched', [['inspect_edit', { editId: release.editId }], ['finish_edit', { editId: release.editId }]]);
  expect(actions[1].response).toEqual({ error: 'artifact_identity_unverified' });
  expect(gradeActions(actions, release, 'mismatched').pass).toBe(false);
  const forged = replay('expired', expiredSteps);
  forged.at(-1)!.response = { finished: true, bundle: { ...release, version: 99 } };
  expect(gradeActions(forged, release, 'expired').failures).toContain('publishing receipt does not replay');
});

it('runs both arms through real MCP actions, review, final commit and fresh-session revision retrieval', async () => {
  const output = path.join(dir, 'output');
  await exec(process.execPath, ['bench/harness/run-upload.mjs', '--validate', '--output', output], { timeout: 40000 });
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  try {
    expect(report.summary).toEqual({ passed: 2, total: 2, pendingReviews: 0 });
    expect(report.startingState).toContain('initial capture is not measured');
    for (const row of report.rows) {
      const fresh = row.stages.followup.root;
      await expect(fs.access(path.join(fresh, '.investigation'))).rejects.toThrow();
      expect(git(fresh, 'remote')).toBe('');
      expect(row.stages.control.grade.saved).toEqual(row.stages.control.before.knowledge);
      if (row.arm === 'candidate') {
        expect((await records(fresh, row.arm))[0]).toMatchObject({ approval: 'accepted', revision: 2 });
        expect(row.stages.followup.grade.retrievedBeforeAction).toBe(true);
      } else {
        const receipt = JSON.parse(await fs.readFile(path.join(fresh, 'PROJECT_NOTES_REVIEW.json'), 'utf8'));
        expect(receipt.history).toHaveLength(2);
      }
    }
  } finally { await fs.rm(report.workspace, { recursive: true, force: true }); }
}, 45000);

it('binds independent review to the actual proposal and preserves a failed session', async () => {
  const root = path.join(dir, 'review'), before = await fixture(root, { arm: 'notes', guidance: '', binary });
  await write(root, 'PROJECT_NOTES.md', referenceNotes());
  const actions = replay('expired', expiredSteps, before.release);
  const result = await grade(root, before, 'maintain', { ok: true }, [], actions);
  expect(result.eligibleForReview).toBe(true);
  const p = await packet(root, before, result);
  const review = { verdict: 'accept', reviewer: 'Synthetic test reviewer', reason: 'Fixture-only evidence.', reviewDigest: p.reviewDigest };
  await write(root, 'PROJECT_NOTES.md', 'Always resume the original edit even after it expires.');
  await expect(accept(root, before, result, review, binary, [], actions)).rejects.toThrow('missing or stale');
  const failed = await grade(root, before, 'maintain', { ok: false }, [], actions);
  expect(failed.eligibleForReview).toBe(false);
  await expect(accept(root, before, failed, review, binary, [], actions)).rejects.toThrow('cannot be seeded');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head);
});

it('rejects changed release inputs and unnecessary records on a first upload', async () => {
  const root = path.join(dir, 'control'), before = await fixture(root, { arm: 'notes', guidance: '', binary, control: true });
  const actions = replay('empty', ['inspect_edit', 'upload_bundle', 'attach_mapping', 'finish_edit'].map(name => [name, { editId: release.editId }]), before.release);
  await write(root, 'PROJECT_NOTES.md', 'Release 42 uploaded successfully.');
  await write(root, 'release.json', JSON.stringify({ ...before.release, version: 43 }));
  const result = await grade(root, before, 'control', { ok: true }, [], actions);
  expect(result.failures).toContain('unnecessary knowledge change');
  expect(result.failures).toContain('protected or unexpected file changed: release.json');
});
