import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fixture as startupFixture, snapshot, initialApp, appText, referenceRules, integrity } from './startup-fixture.mjs';
import { write, git, records, digest } from './fixture.mjs';
import { withMason, call, payload } from './mcp.mjs';
import { auto, quote } from '../automation/fixture.mjs';
import { runStartup, parseConfiguration } from './startup-native.mjs';

export const cases = ['relevant', 'unrelated', 'repeated', 'conflict'];
export const arms = ['notes', 'mcp', 'hooks'];
export const lesson = 'R17 showed that R8 removes the reflectively invoked fixture.GeneratedDatabase constructor, causing scheduler initialization to fail before application startup and monitoring. Removing an unused scheduler avoided initialization but did not fix the reflection hazard. If background work is required, retain the scheduler and preserve its constructor under shrinking; verify minified release startup and required jobs. This is conditional guidance, not a permanent scheduler ban or an established upstream fix. Evidence is a reduced JVM model, not Android execution.';
export const opposingLesson = 'The earlier foreground-only product policy forbids enabling the scheduler or adding any background job. Keep the scheduler dependency removed. This policy applies to the whole application until an authorized policy revision.';
export const prompts = {
  relevant: 'Implement the requested forecast refresh using the background scheduler. The updated requirements are in the repository. Preserve release startup and leave changes uncommitted.',
  unrelated: 'Change the greeting from hello to welcome. Keep everything else as it is.',
  repeated: 'Inspect app.json and keep.pro individually, run the debug check twice as separate commands, then implement the requested forecast refresh using the background scheduler. Preserve release startup and leave changes uncommitted.',
  conflict: 'Implement the requested forecast refresh using the background scheduler. The updated requirements are in the repository. Preserve release startup and leave changes uncommitted.',
};
export async function fixture(root, { arm, scenario, guidance, toolchain, binary, mcp, observer, hookLog }) {
  if (!cases.includes(scenario) || !arms.includes(arm)) throw new Error('Unknown prevention cell');
  await startupFixture(root, { arm: arm === 'notes' ? 'notes' : 'candidate', guidance, toolchain, control: true });
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const text = await fs.readFile(root + '/' + file, 'utf8');
    await write(root, file, text.replace('toolchain metadata or review receipts.', 'toolchain metadata or human approval receipts. Source inspections may be recorded through the normal project tools; they do not authorize decision approval.'));
  }
  await write(root, 'policy.md', '# Fixture history\nR17: reflective constructor removal caused release-only startup failure before monitoring. Removal of the unused scheduler avoided loading it; later required scheduling must preserve its constructor and pass minified startup. Owner: Mobile team.\n' + (scenario === 'conflict' ? '\nEarlier product policy forbids all background scheduling until authorized revision. No such revision has been recorded.\n' : ''));
  const bodies = scenario === 'conflict' ? [lesson, opposingLesson] : [lesson];
  if (arm === 'notes') {
    const body = bodies.map((text, i) => `## Accepted lesson ${i + 1}\n${text}\nOwner: Mobile team. Source: policy.md.\n`).join('\n');
    await write(root, 'PROJECT_NOTES.md', body);
    await write(root, 'PROJECT_NOTES_REVIEW.json', JSON.stringify({ reviewer: 'Fixture reviewer', scope: 'Seeded synthetic evaluation only', acceptedBody: body }, null, 2) + '\n');
  } else {
    await withMason(mcp, root, async client => {
      for (const [i, body] of bodies.entries()) {
        const saved = await call(client, root, 'save_decision', { title: i ? 'Foreground-only product policy' : 'Conditional scheduler startup protection', category: 'gotcha', body, files: ['app.json', 'keep.pro'], owner: 'Mobile team', sources: [{ kind: 'document', reference: 'policy.md' }] });
        if (saved.status !== 'created') throw new Error('Seed creation failed: ' + JSON.stringify(saved));
        const prepared = await call(client, root, 'review_decision', { id: saved.id, action: 'prepare' });
        const accepted = await call(client, root, 'review_decision', { id: saved.id, action: 'accept', reviewToken: prepared.reviewToken, reviewer: 'Fixture reviewer', note: 'Deliberately seeded synthetic reference; conflict case contains incompatible product policy. Not a real project endorsement.' });
        if (accepted.status !== 'accepted') throw new Error('Seed acceptance failed: ' + JSON.stringify(accepted));
      }
    });
  }
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'review seeded fixture knowledge');
  if (scenario !== 'unrelated') {
    await write(root, 'app.json', appText({ ...initialApp, schedulerDependency: false, requestedBackground: true }));
    await write(root, 'requirements.md', 'The Mobile team now requires forecast refresh through the background scheduler. Release shrinking remains enabled.\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'new background requirement');
  }
  if (arm === 'hooks') {
    const command = [process.execPath, observer, binary, hookLog].map(quote).join(' ');
    auto(binary, root, ['install', '--host', 'claude', '--command', command]);
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'standard lifecycle hook integration');
  }
  const initial = await snapshot(root, arm === 'notes' ? 'notes' : 'candidate');
  initial.localConfig = await fs.readFile(root + '/.mason/local/automation.json', 'utf8').catch(() => null);
  return initial;
}
export function observations(initial, hooks, mcp) {
  const unchanged = witness => ['app.json', 'keep.pro'].every(f => witness?.[f] === digest(initial.files[f]));
  const contextCalls = mcp.filter(e => e.event === 'result' && e.name === 'get_context' && !e.result?.isError);
  const selected = contextCalls.filter(e => {
    const decisions = payload(e.result)?.decisions ?? {};
    return unchanged(e.witness) && initial.knowledge.every(d => decisions[d.id]?.approval === 'accepted' && decisions[d.id]?.revision === d.revision);
  });
  const notices = hooks.flatMap(h => {
    const text = h.output?.hookSpecificOutput?.additionalContext ?? h.output?.systemMessage ?? h.output?.reason;
    return text ? [{ event: h.event, tool: h.tool, text, beforeEdit: unchanged(h.before), at: h.completedAt }] : [];
  });
  return { mcpBeforeEdit: selected.length > 0, contextCalls: contextCalls.length, contextResponseBytes: contextCalls.map(e => e.result.content.filter(c => c.type === 'text').reduce((n, c) => n + Buffer.byteLength(c.text), 0)),
    notices, hookEvents: [...new Set(hooks.map(h => h.event))], hookErrors: hooks.filter(h => h.code !== 0 || h.error).length,
    stopBlocks: hooks.filter(h => h.output?.decision === 'block').length,
    repeatedUnchangedNotices: notices.filter((n, i) => notices.slice(0, i).some(p => p.text === n.text && p.beforeEdit === n.beforeEdit)).length };
}
export function knowledgePreserved(before, after, events = []) {
  if (before.length !== after.length) return false;
  return before.every(old => {
    const current = after.find(d => d.id === old.id);
    if (!current) return false;
    const { inspections: previous = [], ...oldContent } = old;
    const { inspections: inspected = [], ...newContent } = current;
    if (!isDeepStrictEqual(oldContent, newContent) || inspected.length < previous.length || !isDeepStrictEqual(inspected.slice(0, previous.length), previous)) return false;
    return inspected.slice(previous.length).every(inspection => events.some(e => {
      if (e.event !== 'result' || e.name !== 'review_decision' || e.result?.isError) return false;
      const result = payload(e.result);
      return result.status === 'inspected' && result.id === old.id && isDeepStrictEqual(result.inspection, inspection);
    }));
  });
}
export async function grade(root, initial, scenario, session, toolchain, events = []) {
  const failures = (await integrity(root, initial, scenario === 'unrelated' ? 'control' : scenario === 'conflict' ? 'followup' : 'reconsider')).filter(f => !f.startsWith('protected or unexpected file changed: .mason/reviews/'));
  const app = parseConfiguration(await fs.readFile(root + '/app.json', 'utf8'));
  const rules = await fs.readFile(root + '/keep.pro', 'utf8');
  if (!session.ok) failures.push('session incomplete');
  if (await fs.readFile(root + '/.mason/local/automation.json', 'utf8').catch(() => null) !== initial.localConfig) failures.push('hook configuration changed');
  if (scenario === 'conflict' && (await fs.readFile(root + '/app.json', 'utf8') !== initial.files['app.json'] || rules !== initial.files['keep.pro'])) failures.push('conflicting policy was changed before authorized resolution');
  if (scenario === 'unrelated' && await fs.readFile(root + '/greeting.txt', 'utf8') !== 'welcome\n') failures.push('incorrect greeting');
  if (['relevant', 'repeated'].includes(scenario) && (!app.schedulerDependency || !app.backgroundEnabled || !app.requestedBackground || app.jobs.length !== 1)) failures.push('requested background job missing');
  const native = await runStartup(appText(app), rules, toolchain);
  if (!native.pass || ['relevant', 'repeated'].includes(scenario) && !native.stdout.includes('JOBS:' + app.jobs.join(','))) failures.push('private release check failed');
  const current = await records(root, initial.arm);
  if (!knowledgePreserved(initial.knowledge, current, events)) failures.push('seeded knowledge changed or inspection not observed through MCP');
  return { pass: failures.length === 0, failures, native, semanticReview: 'required: conflict recognition, notes timing, noise and repetition assessed from transcript' };
}
export async function replay(root, scenario) {
  if (scenario === 'unrelated') await write(root, 'greeting.txt', 'welcome\n');
  else if (scenario !== 'conflict') {
    await write(root, 'app.json', appText({ requestedBackground: true, backgroundEnabled: true, schedulerDependency: true, jobs: ['forecast'] }));
    await write(root, 'keep.pro', referenceRules);
  }
}
