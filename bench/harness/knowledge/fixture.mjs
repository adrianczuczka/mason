import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { withMason, call, payload } from './mcp.mjs';

export const variants = ['sandboxes', 'checkouts'];
export const prompts = {
  capture: 'Why are temporary Git checkouts appearing in two different places in this project? Investigate the history and explain what we should do going forward. Leave existing checkouts and application files intact.',
  reuse: 'Create an isolated Git worktree inside this repository on a new branch named task-change for the next change. Keep the current checkout intact and do not change application behavior.',
  control: 'Change the greeting from hello to welcome. Keep the existing module organization.',
};
export const git = (root, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
  cwd: root, encoding: 'utf8', timeout: 10000,
  env: { ...process.env, GIT_AUTHOR_NAME: 'Knowledge fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Knowledge fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-09-08T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-08T00:00:00Z' },
}).trim();
export const digest = text => createHash('sha256').update(text).digest('hex');
export async function write(root, file, content) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}
const instructions = `# Greeting project
Run node app.mjs to check behavior. Keep all work inside this disposable repository.
Operational history, when provided, is in .investigation/notes.md.
`;
const notesGuidance = `
Read PROJECT_NOTES.md when present for project lessons; PROJECT_NOTES_REVIEW.json records an independent review when one exists. When an investigation establishes reusable rationale or a constraint, save a concise sourced proposal there. Preserve uncertainty and unknown ownership. Do not invent approval or record code summaries, session trivia, or personal preferences. No qualifying lesson means no record.
`;

export async function fixture(root, { arm, guidance, variant = 'sandboxes', control = false }) {
  if (!variants.includes(variant)) throw new Error('Unknown fixture variant');
  const desired = '.' + variant;
  await fs.mkdir(root, { recursive: false });
  await write(root, 'app.mjs', "export const greeting = 'hello';\nconsole.log(greeting);\n");
  await write(root, '.gitignore', '.mason/reports/\n.mason/local/\n.investigation/\n.sandboxes/\n.checkouts/\n.worktrees/\n');
  for (const name of ['AGENTS.md', 'CLAUDE.md']) await write(root, name, instructions + (arm === 'notes' ? notesGuidance : guidance));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial fixture');
  if (!control) {
    git(root, 'worktree', 'add', '-q', '-b', 'earlier-checkout', desired + '/earlier');
    git(root, 'worktree', 'add', '-q', '-b', 'copied-recipe', '.worktrees/copied');
    await write(root, '.investigation/notes.md', `# Synthetic investigation evidence: incident K17

The Platform team owns local checkout conventions in this fixture.
An older assistant recipe used .worktrees/. Later sessions copied it.
Incident K17 established that the external build indexer scans .worktrees/ and indexes duplicate sources, causing duplicate-symbol errors. This indexer is outside this repository, so its behavior cannot be inferred from app.mjs.
The Platform team selected ${desired}/ for isolated Git worktrees because the indexer excludes it. The existing ${desired}/earlier checkout follows that choice; .worktrees/copied follows the outdated recipe.
We suspect an IDE automatically staged some checkout entries, but have no evidence identifying which process staged them. This is not an established cause.
This is evidence for an investigation, not permission for the assistant to approve a new knowledge record or move existing worktrees.
`);
  }
  return { desired, variant, control, arm, head: git(root, 'rev-parse', 'HEAD'), worktrees: git(root, 'worktree', 'list', '--porcelain'),
    protected: Object.fromEntries(await Promise.all(['AGENTS.md', 'CLAUDE.md', '.gitignore', 'app.mjs'].map(async f => [f, await fs.readFile(path.join(root, f), 'utf8')]))),
    source: control ? null : await fs.readFile(path.join(root, '.investigation/notes.md'), 'utf8') };
}

export async function records(root, arm) {
  if (arm === 'notes') {
    try { return [{ id: 'PROJECT_NOTES.md', body: await fs.readFile(path.join(root, 'PROJECT_NOTES.md'), 'utf8') }]; }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  const dir = path.join(root, '.mason/decisions');
  const files = await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  return Promise.all(files.filter(f => f.endsWith('.json')).map(async f => JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))));
}

export async function receipts(file) {
  return (await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export async function integrity(root, initial, { control = false, allowKnowledge = true } = {}) {
  const failures = [];
  if (git(root, 'rev-parse', 'HEAD') !== initial.head) failures.push('agent changed HEAD');
  if (initial.source && await fs.readFile(path.join(root, '.investigation/notes.md'), 'utf8').catch(() => null) !== initial.source) failures.push('investigation evidence changed');
  if (initial.source && initial.worktrees) {
    if (git(root, 'worktree', 'list', '--porcelain') !== initial.worktrees) failures.push('existing worktrees changed during investigation');
    for (const line of initial.worktrees.split('\n').filter(line => line.startsWith('worktree ')).slice(1)) {
      try {
        if (git(line.slice(9), 'status', '--porcelain', '--untracked-files=all')) failures.push('existing checkout contents changed during investigation');
      } catch { failures.push('existing checkout unavailable after investigation'); }
    }
  }
  for (const [file, original] of Object.entries(initial.protected)) {
    const current = await fs.readFile(path.join(root, file), 'utf8').catch(() => null);
    if (control && file === 'app.mjs') {
      if (current !== original.replaceAll('hello', 'welcome')) failures.push('incorrect control edit');
    } else if (current !== original) failures.push('protected file changed: ' + file);
  }
  const changed = git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  for (const file of changed) if (!(allowKnowledge && (initial.arm === 'notes' ? file === 'PROJECT_NOTES.md' : /^\.mason\/decisions\/[^/]+\.json$/.test(file)))) failures.push('unexpected file: ' + file);
  return failures;
}

export async function gradeCapture(root, initial, session, observations = []) {
  const failures = await integrity(root, initial), saved = await records(root, initial.arm);
  if (!session.ok) failures.push('capture session failed');
  if (saved.length !== 1) failures.push('expected one useful proposal; found ' + saved.length);
  const record = saved[0];
  if (record) {
    const text = [record.title, record.body].filter(Boolean).join('\n');
    // Necessary structural checks only. An independent semantic review remains required.
    if (![initial.desired, '.worktrees', 'index'].every(s => text.toLowerCase().includes(s)) || !/duplicat/i.test(text)) failures.push('proposal omits the operational reason or the relevant paths');
    if (initial.arm !== 'notes') {
      if (record.approval !== 'proposed' || record.status !== 'active' || record.history?.some(e => ['accepted', 'reaffirmed'].includes(e.kind))) failures.push('agent inferred approval');
      if (!record.sources?.some(s => /K17|\.investigation\/notes\.md/i.test(s.reference))) failures.push('proposal lacks the supplied source');
      if (record.owner && record.owner !== 'Platform team') failures.push('unsupported owner');
      if (!record.files?.includes('.gitignore')) failures.push('proposal lacks a relevant committed anchor');
      if (!observations.some(e => e.event === 'result' && e.name === 'save_decision' && !e.result?.isError && ['created', 'updated'].includes(payload(e.result)?.status))) failures.push('no successful decision capture observed through MCP');
    } else if (!/K17|\.investigation\/notes\.md/i.test(text)) failures.push('notes lack the supplied source');
  }
  return { eligibleForReview: failures.length === 0, failures, saved, semanticReview: 'required' };
}

/** A real reviewer supplies this verdict; no keyword check can grant acceptance. */
export async function acceptReviewed(root, initial, binary, capture, review) {
  if (!capture.eligibleForReview) throw new Error('Capture failed; cannot seed or repair the missing lesson.');
  if (!review || review.verdict !== 'accept' || !review.reviewer?.trim() || !review.reason?.trim() || review.recordDigest !== digest(JSON.stringify(capture.saved[0]))) throw new Error('A matching independent review is required.');
  if ((await integrity(root, initial)).length || digest(JSON.stringify((await records(root, initial.arm))[0])) !== review.recordDigest) throw new Error('Fixture or proposal changed after capture.');
  const record = capture.saved[0];
  if (initial.arm === 'notes') {
    // Preserve the actual captured bytes; store review separately from the agent's notes.
    await write(root, 'PROJECT_NOTES_REVIEW.json', JSON.stringify({ ...review, scope: 'Synthetic fixture only; approval applies to the captured notes digest.' }, null, 2) + '\n');
    git(root, 'add', '--', 'PROJECT_NOTES.md', 'PROJECT_NOTES_REVIEW.json');
  } else {
    await withMason(binary, root, async client => {
      const prepared = await call(client, root, 'review_decision', { id: record.id });
      if (prepared.status !== 'prepared') throw new Error('Review preparation failed: ' + JSON.stringify(prepared));
      const result = await call(client, root, 'review_decision', { id: record.id, action: 'accept', reviewToken: prepared.reviewToken,
        reviewer: review.reviewer, note: 'Evaluation review (synthetic fixture only): ' + review.reason });
      if (result.status !== 'accepted') throw new Error('Review acceptance failed: ' + JSON.stringify(result));
    });
    git(root, 'add', '--', '.mason/decisions');
  }
  git(root, 'commit', '-qm', 'retain independently reviewed lesson');
}

export async function freshCheckout(root, fresh) {
  git(path.dirname(root), 'clone', '-q', '--no-local', root, fresh);
  git(fresh, 'remote', 'remove', 'origin');
  // Ignored incident material and private host state do not cross the session boundary.
  const knowledge = await fs.access(path.join(fresh, '.investigation')).then(() => true, () => false);
  if (knowledge) throw new Error('Transient investigation evidence leaked into the second checkout.');
}

export async function gradeReuse(root, initial, session, acceptedId, observations = []) {
  const failures = await integrity(root, { ...initial, source: null }, { allowKnowledge: false });
  if (git(root, 'status', '--porcelain', '--untracked-files=all')) failures.push('current checkout changed during reuse');
  if (!session.ok) failures.push('reuse session failed');
  const list = git(root, 'worktree', 'list', '--porcelain');
  const entry = list.split('\n\n').find(block => block.includes('branch refs/heads/task-change'));
  const checkout = entry?.split('\n').find(line => line.startsWith('worktree '))?.slice(9);
  const rel = checkout ? path.relative(await fs.realpath(root), await fs.realpath(checkout)).split(path.sep).join('/') : null;
  if (!rel?.startsWith(initial.desired + '/')) failures.push('new worktree did not use the reviewed directory');
  else if (git(checkout, 'rev-parse', 'HEAD') !== initial.head || git(checkout, 'status', '--porcelain', '--untracked-files=all')) failures.push('new checkout changed application or knowledge state');
  let retrievedBeforeAction = null;
  if (initial.arm !== 'notes') {
    retrievedBeforeAction = observations.some(e => e.event === 'result' && e.name === 'get_context' && !e.result?.isError &&
      !e.worktrees.includes('branch refs/heads/task-change') && payload(e.result)?.decisions?.[acceptedId]?.approval === 'accepted');
    if (!retrievedBeforeAction) failures.push('reviewed decision was not retrieved before creating the worktree');
  }
  return { pass: failures.length === 0, failures, checkout: rel, retrievedBeforeAction };
}
