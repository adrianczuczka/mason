import fs from 'node:fs/promises';
import path from 'node:path';
import { git, write, records, digest, freshCheckout } from './fixture.mjs';
import { withMason, call, payload } from './mcp.mjs';
import { gradeActions } from './publish-model.mjs';

export const prompts = {
  maintain: 'Investigate the interrupted release using the supplied incident evidence and finish it through the local publishing simulator. Keep the release artifact and build number unchanged. Leave repository changes uncommitted.',
  followup: 'Finish this interrupted release through the local publishing simulator. The intended artifact, version and original edit are in release.json. Keep the artifact and build number unchanged; leave repository changes uncommitted.',
  control: 'Perform the first upload for this release and finish its existing edit through the local publishing simulator. Use release.json and keep the artifact and build number unchanged. Leave repository changes uncommitted.',
};
export const originalLesson = {
  title: 'Recover interrupted uploads from verified publishing state', category: 'gotcha', owner: 'Release team', actor: 'Deterministic fixture setup',
  body: 'After an upload acknowledgement is lost, inspect the original publishing edit and compare bundle version and SHA-256 with the intended artifact before repeating the side effect or changing build numbers. In U12 the retained edit was active and already held the matching bundle; attaching its mapping and finishing that edit avoided a duplicate upload. This procedure was established for an active retained edit; expired-edit recovery was not established. The transport cause remained unknown. A smaller successful chunk size was an incident-specific fallback, not a universal requirement.',
  files: ['release.json', 'publishing.md'], sources: [{ kind: 'incident', reference: 'U12', note: 'Reconstructed prior incident used as reviewed fixture starting state, not original logs.' }],
};
export const revisedBody = 'After a lost upload acknowledgement, inspect the original edit and compare bundle version and SHA-256 before repeating side effects. Reuse an active edit only when the intended bundle identity matches; attach its mapping and finish it. U29 changes the retained-edit assumption: an expired edit cannot be resumed or used to establish its former contents. Create a replacement edit and upload the unchanged artifact with the same build number, verify its returned identity, then attach the mapping and finish. Do not infer a transport cause or turn U12\'s successful small chunk size into a universal rule. This is a local protocol reconstruction, not a production Play verification.';
const incident = `# U29 — reconstructed retention change, not original logs
The Release team owns this publishing workflow. The service now expires inactive edits; the original retained-edit assumption no longer covers every recovery.
An upload acknowledgement was lost, and inspection returned expired for the original edit. Its former bundle contents are unavailable, not proven absent.
The recovery created a replacement edit and uploaded the unchanged artifact with the same build number. The service returned its expected version and SHA-256; mapping attachment and completion succeeded.
This does not require rebuilding or increasing the build number. The transport cause remains unknown. There is no evidence for a universal chunk size.
These are synthetic protocol observations derived from the earlier interrupted-upload scenario. They do not approve any new knowledge proposal.
`;
const notesGuidance = '\nRead PROJECT_NOTES.md and PROJECT_NOTES_REVIEW.json when present. The review receipt retains acceptedBody; edits remain proposals until independently reviewed. Capture reusable rationale with sources and known ownership; revise an existing lesson when its conditions change. Do not infer approval or record ordinary code summaries.\n';
const notesText = body => '# Proposed publishing rationale\n\nOwner: Release team.\n\n' + body + '\n\nSources: U12 (reviewed fixture starting state); .investigation/retention.md (U29 when supplied); publishing.md.\n';
export async function snapshot(root, arm, source = null) {
  const files = git(root, 'ls-files', '-z').split('\0').filter(Boolean);
  return { arm, source, head: git(root, 'rev-parse', 'HEAD'), knowledge: await records(root, arm),
    files: Object.fromEntries(await Promise.all(files.map(async f => [f, await fs.readFile(path.join(root, f), 'utf8')]))),
    release: JSON.parse(await fs.readFile(path.join(root, 'release.json'), 'utf8')) };
}
async function reviewKnowledge(root, arm, binary, review) {
  if (arm === 'notes') {
    const body = (await records(root, arm))[0].body;
    const prior = JSON.parse(await fs.readFile(path.join(root, 'PROJECT_NOTES_REVIEW.json'), 'utf8').catch(() => '{"history":[]}'));
    const entry = { ...review, acceptedBody: body, scope: 'Synthetic fixture only' };
    await write(root, 'PROJECT_NOTES_REVIEW.json', JSON.stringify({ ...entry, history: [...prior.history, entry] }, null, 2) + '\n');
    git(root, 'add', '--', 'PROJECT_NOTES.md', 'PROJECT_NOTES_REVIEW.json');
  } else {
    const id = (await records(root, arm))[0].id;
    await withMason(binary, root, async c => {
      const prepared = await call(c, root, 'review_decision', { id });
      const accepted = await call(c, root, 'review_decision', { id, action: 'accept', reviewToken: prepared.reviewToken, reviewer: review.reviewer, note: review.reason });
      if (accepted.status !== 'accepted') throw new Error('Knowledge review failed: ' + JSON.stringify(accepted));
    });
    git(root, 'add', '--', '.mason/decisions');
  }
  git(root, 'commit', '-qm', 'retain reviewed publishing knowledge');
}
export async function fixture(root, { arm, guidance, binary, control = false }) {
  await fs.mkdir(root);
  const instructions = '# Publishing fixture\nThe Release team owns this workflow. release.json describes the immutable artifact, intended version and existing edit. The publishing MCP tools operate only a local protocol simulator; no real release or credentials are involved.\nRead publishing.md and any supplied .investigation/retention.md. Do not modify release inputs, instructions or review receipts. Leave commits to the evaluator.\n';
  for (const file of ['AGENTS.md', 'CLAUDE.md']) await write(root, file, instructions + (arm === 'notes' ? notesGuidance : guidance));
  await write(root, '.gitignore', '.investigation/\n.mason/reports/\n.mason/local/\n');
  await write(root, 'artifact.bundle', 'synthetic-release-artifact\n');
  await write(root, 'release.json', JSON.stringify({ editId: 'original-edit', version: 42, artifact: 'artifact.bundle', sha256: digest('synthetic-release-artifact\n') }, null, 2) + '\n');
  await write(root, 'publishing.md', 'The publishing tools inspect edits, create edits, upload the fixed artifact, attach its mapping and finish the edit. The known U12 incident retained an active edit after a lost upload acknowledgement. Other retention outcomes have not been established in the prior lesson.\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'publishing fixture inputs');
  // Deliberate reviewed starting state: this probe measures maintenance of
  // existing knowledge, not spontaneous initial capture or raw incident replay.
  if (arm === 'notes') await write(root, 'PROJECT_NOTES.md', '# Publishing rationale\nOwner: Release team.\n' + originalLesson.body + '\nSource: U12, reconstructed prior incident.\n');
  else await withMason(binary, root, c => call(c, root, 'save_decision', originalLesson));
  await reviewKnowledge(root, arm, binary, { reviewer: 'Deterministic fixture setup', reason: 'Known reference lesson in a synthetic reviewed starting state; not an agent capture or a real-project approval.' });
  if (!control) {
    await write(root, 'publishing.md', 'The local publishing service now expires inactive edits. An expired edit cannot accept writes and its former bundle contents are unavailable. A new edit accepts the unchanged artifact version. Upload returns bundle version and SHA-256. Active edits require the intended bundle and mapping before finish. No transport diagnosis or chunk-size policy follows from these responses.\n');
    git(root, 'add', 'publishing.md'); git(root, 'commit', '-qm', 'change publishing edit retention');
    await write(root, '.investigation/retention.md', incident);
  }
  return snapshot(root, arm, control ? null : incident);
}
export async function fresh(root, target, arm) {
  await freshCheckout(root, target);
  const release = JSON.parse(await fs.readFile(path.join(target, 'release.json'), 'utf8'));
  await write(target, 'release.json', JSON.stringify({ ...release, editId: 'later-edit', version: 43 }, null, 2) + '\n');
  git(target, 'add', 'release.json'); git(target, 'commit', '-qm', 'next publishing task');
  return snapshot(target, arm);
}
export async function grade(root, before, stage, session, observed, publishEvents) {
  const failures = [];
  if (!session.ok) failures.push('agent session failed');
  if (git(root, 'rev-parse', 'HEAD') !== before.head) failures.push('agent changed HEAD');
  if (before.source && await fs.readFile(path.join(root, '.investigation/retention.md'), 'utf8').catch(() => null) !== before.source) failures.push('incident evidence changed');
  for (const file of new Set([...Object.keys(before.files), ...git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)])) {
    const stat = await fs.lstat(path.join(root, file)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) { failures.push('missing or unsafe file: ' + file); continue; }
    const knowledgeFile = before.arm === 'notes' ? file === 'PROJECT_NOTES.md' : /^\.mason\/decisions\/[a-z0-9_-]+\.json$/.test(file);
    if (stage === 'maintain' && knowledgeFile) continue;
    if (await fs.readFile(path.join(root, file), 'utf8') !== before.files[file]) failures.push('protected or unexpected file changed: ' + file);
  }
  const behavior = gradeActions(publishEvents, before.release, stage === 'control' ? 'empty' : 'expired');
  failures.push(...behavior.failures);
  const saved = await records(root, before.arm), prior = before.knowledge[0], current = saved[0];
  if (stage === 'maintain') {
    if (saved.length !== 1) failures.push('existing lesson was not revised as a single record');
    if (before.arm === 'notes') {
      if (!current || current.body === prior.body) failures.push('existing notes were not revised');
    } else if (current) {
      if (current.id !== prior.id || current.revision <= prior.revision || current.approval !== 'proposed' || current.status !== 'active') failures.push('existing accepted record was not revised as a proposal');
      if (JSON.stringify(current.history?.slice(0, prior.history.length)) !== JSON.stringify(prior.history)
        || current.history?.slice(prior.history.length).some(e => e.kind !== 'revised')) failures.push('reviewed history or approval boundary changed');
      // Source support and equivalent incident labels belong to semantic review.
      if (!current.owner?.trim() || !current.files?.includes('release.json') || !current.sources?.length) failures.push('missing attribution or release anchor');
      if (!observed.some(e => e.event === 'result' && e.name === 'save_decision' && !e.result?.isError && payload(e.result)?.status === 'updated')) failures.push('revision not observed through MCP');
    }
  } else if (digest(JSON.stringify(saved)) !== digest(JSON.stringify(before.knowledge))) failures.push('unnecessary knowledge change');
  let retrievedBeforeAction = null;
  if (before.arm !== 'notes') {
    const firstWrite = publishEvents.find(e => e.event === 'publish-result' && e.name !== 'inspect_edit');
    retrievedBeforeAction = !!firstWrite && observed.some(e => e.event === 'result' && e.name === 'get_context' && !e.result?.isError
      && e.at < firstWrite.at && e.witness?.['release.json'] === digest(before.files['release.json'])
      && payload(e.result)?.decisions?.[prior.id]?.revision === prior.revision && payload(e.result)?.decisions?.[prior.id]?.approval === 'accepted');
    if (!retrievedBeforeAction) failures.push('accepted guidance not retrieved before publishing side effects');
  }
  return { pass: !failures.length, eligibleForReview: stage === 'maintain' && !failures.length, failures, behavior, saved, retrievedBeforeAction };
}
export async function packet(root, before, result) {
  const evidence = { head: before.head, source: before.source, prior: before.knowledge[0], proposal: (await records(root, before.arm))[0],
    release: before.release, publishing: before.files['publishing.md'], behavior: result.behavior };
  return { ...evidence, reviewDigest: digest(JSON.stringify(evidence)), instructions: 'Independently assess this revision: preserve verify-before-retry and artifact identity; add the expired-edit replacement branch with unchanged version; distinguish unavailable past contents from absence. Preserve unknown transport cause and avoid a universal chunk size. Keep prior accepted history; reject unsupported claims. Do not rewrite the agent proposal. Synthetic fixture only.' };
}
export async function accept(root, before, result, review, binary, observed, publishEvents) {
  const checked = await grade(root, before, 'maintain', { ok: true }, observed, publishEvents);
  const current = await packet(root, before, checked);
  if (!result.eligibleForReview || !checked.eligibleForReview) throw new Error('Failed maintenance cannot be seeded or rescued by review');
  if (review.verdict !== 'accept' || !review.reviewer?.trim() || !review.reason?.trim() || review.reviewDigest !== current.reviewDigest) throw new Error('Independent review is missing or stale');
  await reviewKnowledge(root, before.arm, binary, review);
}
export const referenceNotes = () => notesText(revisedBody);
