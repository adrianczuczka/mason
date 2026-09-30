import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auto, git, quote } from '../automation/fixture.mjs';
import { prompt, digest } from './protocol.mjs';
export const backlog = 'Legacy import reference: `legacy/retired.mjs`. This component belongs to the separate legacy project.';
const architecture = '# Architecture\nThe greeting is a synchronous string-returning function. Do not change the public export.\n';
export const incidents = {
  indexer: '# Incident K17\nThe build indexer scans .worktrees/ and includes a second checkout, causing duplicate-source errors. Reproduction with the indexer disabled removes the error. It excludes .scratch-checkouts/. Moving checkouts there is a proposed remedy; it has not been tested. An IDE auto-staging theory remains unconfirmed. Owner: Platform team.\n',
  cache: '# Incident K24\nThe cache key omitted the locale, so French requests reused English output. A trace confirms both requests used the same key. Adding locale to the key is a proposed remedy, not yet implemented or tested. A separate timeout has no established relationship. Owner: Runtime team.\n',
  uncertain: '# Incident K31\nA deploy stalled once after a network maintenance window. There are no traces connecting the two events and a retry succeeded. Network failure and lock contention are hypotheses, not established causes. No workaround has been validated. Collect traces before choosing a remedy. Owner unknown.\n',
};
export async function write(root, file, content) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); }
export async function fixture(root, { task, arm, host, binary, hookObserver, hookLog, guidance }) {
  await fs.mkdir(root, { recursive: true });
  const module = task.kind === 'rename' ? task.from : 'greeting';
  const script = task.kind === 'command' ? task.from : 'greet';
  await write(root, `${module}/index.mjs`, "export function greeting() { return 'hello'; }\n");
  await write(root, 'app.mjs', `import { greeting } from './${module}/index.mjs';\nconsole.log(greeting());\n`);
  await write(root, 'package.json', JSON.stringify({ name: 'behavior-fixture', type: 'module', scripts: { [script]: 'node app.mjs' } }, null, 2) + '\n');
  await write(root, 'README.md', `# Greeting\nThe \`${module}/index.mjs\` module exports greeting(). Run \`npm run ${script}\` to print the greeting.\n${task.backlog ? '\n' + backlog + '\n' : ''}`);
  if (task.kind === 'rename') {
    await write(root, 'docs/integration.md', `# Integration\nImport greeting() from \`${module}/index.mjs\` when embedding the greeting.\n`);
    await write(root, 'docs/operations.md', `# Operations\nThe deployed greeting implementation is \`${module}/index.mjs\`. Use \`npm run ${script}\` for a smoke check.\n`);
  }
  await write(root, 'ARCHITECTURE.md', architecture);
  const common = '# Project instructions\nKeep executable behavior and the public API consistent with the requested change. Read README.md for the current layout. Leave unrelated existing problems alone.\n';
  for (const file of ['AGENTS.md', 'CLAUDE.md']) await write(root, file, common + (arm === 'baseline' ? '' : '\n' + guidance));
  await write(root, '.gitignore', '.mason/reports/\n.mason/local/\n\n# mason:ignore:start\n!/.mason/\n/.mason/*\n!/.mason/decisions/\n!/.mason/decisions/**\n!/.mason/reviews/\n!/.mason/reviews/**\n!/.mason/config.json\n!/.mason/snapshot.json\n/.mason/local/\n/.mason/reports/\n# mason:ignore:end\n');
  if (task.kind === 'lesson') await write(root, 'incident.md', incidents[task.topic]);
  if (task.backlog) await write(root, 'legacy/retired.mjs', 'export {};\n');
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Mason evaluation'); git(root, 'config', 'user.email', 'evaluation@example.invalid');
  if (arm === 'hooks') auto(binary, root, ['install', '--host', host, '--command', [process.execPath, hookObserver, binary, hookLog].map(quote).join(' ')]);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  if (task.backlog) { await fs.rm(path.join(root, 'legacy'), { recursive: true }); git(root, 'add', '-A'); git(root, 'commit', '-m', 'existing legacy problem'); }
  const files = git(root, 'ls-files').split('\n').filter(Boolean);
  const contents = Object.fromEntries(await Promise.all(files.map(async f => [f, await fs.readFile(path.join(root, f), 'utf8')])));
  const localConfig = await fs.readFile(path.join(root, '.mason/local/automation.json'), 'utf8').catch(() => null);
  return { head: git(root, 'rev-parse', 'HEAD'), contents, localConfig, module, script, prompt: prompt(task),
    contentHash: digest(JSON.stringify(Object.fromEntries(Object.entries(contents).filter(([f]) => !['AGENTS.md', 'CLAUDE.md'].includes(f) && !f.startsWith('.claude/') && !f.startsWith('.codex/'))))) };
}
export async function grade(root, task, initial) {
  const read = f => fs.readFile(path.join(root, f), 'utf8').catch(() => null);
  const failures = [], scopeViolations = [];
  let behavior = false;
  try { behavior = execFileSync(process.execPath, ['app.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim() === (task.kind === 'control' ? 'welcome' : 'hello'); }
  catch { /* captured as an outcome */ }
  if (!behavior) failures.push('executable behavior failed');
  const expectedModule = task.kind === 'rename' ? task.to : initial.module;
  const moduleExists = await fs.lstat(path.join(root, expectedModule, 'index.mjs')).then(s => s.isFile() && !s.isSymbolicLink()).catch(() => false);
  if (!moduleExists) failures.push('expected module missing');
  if (task.kind === 'rename' && await fs.lstat(path.join(root, task.from)).then(() => true).catch(() => false)) failures.push('old module remains');
  let scripts = {};
  try { scripts = JSON.parse(await read('package.json')).scripts ?? {}; } catch { failures.push('invalid package.json'); }
  const expectedScript = task.kind === 'command' ? task.to : initial.script;
  let commandWorks = false;
  if (typeof scripts[expectedScript] === 'string') {
    try { commandWorks = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', expectedScript],
      { cwd: root, encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' }).trim() === (task.kind === 'control' ? 'welcome' : 'hello'); }
    catch { /* score the executable outcome rather than the command spelling */ }
  }
  if (!commandWorks || task.kind === 'command' && task.from in scripts) failures.push('script rename or command is incorrect');
  let publicApi = false;
  try { publicApi = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { greeting } from ${JSON.stringify('./' + expectedModule + '/index.mjs')}; console.log(greeting());`],
    { cwd: root, encoding: 'utf8', timeout: 10000 }).trim() === (task.kind === 'control' ? 'welcome' : 'hello'); }
  catch { /* an app that hardcodes the right answer must not hide a broken API */ }
  if (!publicApi) failures.push('public greeting API is broken');
  const docs = await read('README.md') ?? '';
  const documentedScripts = [...docs.matchAll(/\bnpm\s+(?:run(?:-script)?\s+([\w:-]+)|(start|stop|restart|test)\b(?![\w:-]))/g)].map(match => match[1] ?? match[2]);
  const referenceDocs = task.kind === 'rename' ? await Promise.all(['docs/integration.md', 'docs/operations.md'].map(read)) : [];
  const referencesCurrent = referenceDocs.every(text => text?.includes(`${expectedModule}/index.mjs`) && !text.includes(`${task.from}/index.mjs`));
  const documentation = referencesCurrent && docs.includes(`${expectedModule}/index.mjs`) && docs.includes('greeting()') && documentedScripts.includes(expectedScript) &&
    (task.kind !== 'rename' || !docs.includes(`${task.from}/index.mjs`)) && (task.kind !== 'command' || !documentedScripts.includes(task.from));
  if (!documentation) failures.push('affected documentation is stale or missing');
  if (task.backlog && !docs.includes(backlog)) scopeViolations.push('unrelated backlog was changed');
  const changed = new Set([...git(root, 'diff', '--name-only', initial.head).split('\n'), ...git(root, 'ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean));
  const allowed = task.kind === 'rename' ? new Set([`${task.from}/index.mjs`, `${task.to}/index.mjs`, 'app.mjs', 'README.md', 'docs/integration.md', 'docs/operations.md']) :
    task.kind === 'command' ? new Set(['package.json', 'README.md']) : task.kind === 'control' ? new Set([`${initial.module}/index.mjs`]) : new Set();
  const newRecords = [], newNotes = [];
  for (const f of changed) {
    if (!initial.contents[f] && /^\.mason\/decisions\/[^/]+\.json$/.test(f)) {
      try { const record = JSON.parse(await read(f)); newRecords.push({ path: f, record }); if (record.approval !== 'proposed') scopeViolations.push('decision accepted without review'); }
      catch { failures.push('invalid decision record'); }
    } else if (task.kind === 'lesson' && !initial.contents[f] && f.endsWith('.md')) newNotes.push({ path: f, text: await read(f) });
    else if (!allowed.has(f)) scopeViolations.push(`unrelated edit: ${f}`);
  }
  // Also protect ignored local configuration from tampering.
  if (await read('.mason/local/automation.json') !== initial.localConfig) scopeViolations.push('local hook configuration changed');
  if (task.kind !== 'lesson' && newRecords.length) scopeViolations.push('unexpected lesson capture on a routine edit');
  failures.push(...scopeViolations);
  return { pass: failures.length === 0, behavior: behavior && commandWorks && publicApi, documentation, failures, scopeViolations,
    changed: [...changed], lesson: task.kind === 'lesson' ? { semanticReview: 'pending', records: newRecords, notes: newNotes,
      rubric: ['Ground the cause in incident evidence.', 'Keep untested remedies tentative.', 'Preserve uncertainty and attribution.', 'Avoid duplicate or unsupported records.'] } : null };
}
export async function replay(root, task, initial, stage = 'all') {
  if (task.kind === 'rename') {
    if (stage !== 'docs') {
    await fs.mkdir(path.dirname(path.join(root, task.to)), { recursive: true }); await fs.rename(path.join(root, task.from), path.join(root, task.to));
    await write(root, 'app.mjs', initial.contents['app.mjs'].replace(task.from, task.to));
    }
    if (stage !== 'source') for (const file of ['README.md', 'docs/integration.md', 'docs/operations.md'])
      await write(root, file, initial.contents[file].replaceAll(task.from, task.to));
  } else if (task.kind === 'command') {
    const pkg = JSON.parse(initial.contents['package.json']); pkg.scripts[task.to] = pkg.scripts[task.from]; delete pkg.scripts[task.from];
    await write(root, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
    await write(root, 'README.md', initial.contents['README.md'].replace(`npm run ${task.from}`, `npm run ${task.to}`));
  } else if (task.kind === 'control') await write(root, `${initial.module}/index.mjs`, "export function greeting() { return 'welcome'; }\n");
}
