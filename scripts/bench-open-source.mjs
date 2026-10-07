#!/usr/bin/env node
// Real source trees, isolated fixture edits, public Mason tools; no Android builds or models.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const projects = {
  nowinandroid: { url: 'https://github.com/android/nowinandroid.git', sha: 'a49ed253d75e61a2b6ab80a8da677b57437b08eb',
    doc: 'docs/ArchitectureLearningJourney.md',
    golden: 'core/data/src/main/kotlin/com/google/samples/apps/nowinandroid/core/data/repository/OfflineFirstNewsRepository.kt',
    rule: 'News repository reads use local storage as the source of truth.', witness: 'newsResourceDao.getNewsResources' },
  'wordpress-android': { url: 'https://github.com/wordpress-mobile/WordPress-Android.git', sha: 'ceafcdcbb4812eb10856dd789a0b11d3fe95eaa8',
    doc: 'docs/accessibility-guidelines.md',
    golden: 'WordPress/src/main/java/org/wordpress/android/ui/media/MediaBrowserActivity.java',
    rule: 'The media browser retains its activity title for TalkBack announcements.', witness: 'actionBar.setTitle' },
};
const { values } = parseArgs({ options: {
  repository: { type: 'string', default: 'all' }, samples: { type: 'string', default: '3' },
  binary: { type: 'string', default: 'dist/mason.js' }, host: { type: 'string', default: 'claude' },
  cache: { type: 'string', default: '.mason/reports/benchmarks/oss-cache' },
  output: { type: 'string', default: '.mason/reports/benchmarks/open-source.json' },
} });
assert(values.repository === 'all' || projects[values.repository], 'Unknown repository');
assert(['claude', 'codex'].includes(values.host), 'Unknown host');
const samples = Number(values.samples);
assert(Number.isInteger(samples) && samples >= 2 && samples <= 50, 'samples must be 2..50');
const binary = path.resolve(values.binary), cache = path.resolve(values.cache), output = path.resolve(values.output);
const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mason-open-source-')));
const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(parent, 'empty-gitconfig'),
  GIT_AUTHOR_NAME: 'Mason benchmark fixture', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
  GIT_COMMITTER_NAME: 'Mason benchmark fixture', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid' };
for (const key of ['MASON_SETUP_ROOT', 'MASON_SETUP_HOST', 'MASON_SETUP_REVISION']) delete env[key];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const run = async (cwd, command, args, input) => {
  const started = performance.now();
  const child = exec(command, args, { cwd, env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (input !== undefined) { child.child.stdin.on('error', () => {}); child.child.stdin.end(input); }
  const result = await child;
  return { ...result, ms: performance.now() - started };
};
const git = async (root, ...args) => (await run(root, 'git', args)).stdout.trim();
const commit = async (root, message) => { await git(root, 'add', '-A'); return git(root, '-c', 'core.hooksPath=' + path.join(parent, 'no-hooks'), 'commit', '-qm', message); };
const stats = runs => {
  const times = runs.map(run => typeof run === 'number' ? run : run.ms).sort((a,b) => a-b);
  const quantile = p => Math.round(times[Math.ceil(times.length*p)-1]*10)/10;
  return { samples: times.length, p50Ms: quantile(.5), p95Ms: quantile(.95), maxMs: quantile(1) };
};
const sensitive = file => /(?:^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519)|\.(?:pem|key|p12|pfx|jks|keystore)$|credentials\.|secret|local\.properties/i.test(file);
const source = file => /\.(kt|java)$/.test(file) && !sensitive(file);
const marker = phase => `\n// MASON_OSS_BENCHMARK: ${phase}; comment-only fixture change.\n`;
async function fixture(name, project, scope) {
  const root = path.join(parent, name + '-' + scope);
  await run(parent, 'git', ['clone', '--no-hardlinks', '--no-checkout', path.join(cache, name), root]);
  await git(root, 'checkout', '--detach', project.sha);
  assert.equal(await git(root, 'rev-parse', 'HEAD'), project.sha);
  assert.equal(await git(root, 'rev-parse', '--is-shallow-repository'), 'false', 'Full history is required');
  await fs.appendFile(path.join(root, '.git/info/exclude'), '\n.mason/reports/\n.mason/local/\n.mason/benchmark-bin/\n');
  const inventory = (await run(root, 'git', ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
  const production = inventory.filter(file => source(file) && /\/src\/main\//.test(file)).sort();
  const directories = new Map();
  for (const file of production) { const dir = path.posix.dirname(file); if (!directories.has(dir)) directories.set(dir, []); directories.get(dir).push(file); }
  const selected = [project.golden];
  const used = new Set([path.posix.dirname(project.golden)]);
  for (const [dir, files] of [...directories].sort((a,b) => b[1].length-a[1].length || a[0].localeCompare(b[0]))) {
    if (used.has(dir)) continue;
    const contents = inventory.filter(file => file.startsWith(dir + '/'));
    if (contents.length > 1000 || contents.some(file => !source(file))) continue;
    selected.push(files[0]); used.add(dir);
    if (selected.length === 20) break;
  }
  assert.equal(selected.length, 20, 'Need 20 representative, readable scopes');
  const scopes = selected.map(file => scope === 'file' ? file : path.posix.dirname(file));
  const anchoredFiles = new Set(inventory.filter(file => scopes.some(anchor => file === anchor || file.startsWith(anchor + '/'))));
  const sourceBefore = await fs.readFile(path.join(root, project.golden), 'utf8');
  assert(sourceBefore.includes(project.witness), 'Documented rule witness changed at the pinned revision');
  await fs.appendFile(path.join(root, project.golden), marker('before-save'));
  const client = new Client({ name: 'mason-open-source-benchmark', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [binary, 'mcp'], cwd: root, env, stderr: 'pipe' }));
  const call = async (tool, args) => {
    const result = await client.callTool({ name: tool, arguments: { dir: root, ...args } }, undefined, { timeout: 120000 });
    assert(!result.isError, JSON.stringify(result));
    const payload = JSON.parse(result.content.find(block => block.type === 'text').text);
    assert(!['error', 'conflict', 'unavailable'].includes(payload.status), JSON.stringify(payload));
    return payload;
  };
  try {
    const ids = [];
    for (const [index, anchor] of scopes.entries()) {
      const saved = await call('save_decision', { title: `OSS fixture ${name} ${scope} ${index}`, category: 'decision', files: [anchor],
        body: index === 0 ? project.rule + ' Test-local proposal grounded in upstream documentation; no maintainer approval is claimed.'
          : 'Benchmark-only anchored-change tracking proposal. Fixture comments preserve executable source; this is not a project maintainer constraint.',
        actor: 'Mason OSS benchmark', sources: [{ kind: 'document', reference: `https://github.com/${name === 'nowinandroid' ? 'android/nowinandroid' : 'wordpress-mobile/WordPress-Android'}/blob/${project.sha}/${project.doc}` }], force: true });
      assert.equal(saved.status, 'created'); ids.push(saved.id);
    }
    const audit = async () => {
      const result = await call('mason_repair', { action: 'prepare', checks: ['decision-anchor-drift'] });
      assert.equal(result.report.skippedChecks.length, 0, JSON.stringify(result.report.skippedChecks));
      return result;
    };
    const ownAdvisories = result => result.report.advisories.filter(f => ids.includes(f.evidence.decisionId));
    assert.equal(ownAdvisories(await audit()).length, 0, 'Saving dirty code must capture its current content');
    await commit(root, 'fixture: capture code and decision records together');
    assert.equal(ownAdvisories(await audit()).length, 0, 'Commit of already captured content must not create drift');
    await fs.writeFile(path.join(root, 'mason-benchmark-unrelated.txt'), 'Unrelated fixture commit\n');
    await commit(root, 'fixture: unrelated change');
    assert.equal(ownAdvisories(await audit()).length, 0, 'Unrelated commit must remain quiet');
    await fs.appendFile(path.join(root, project.golden), marker('after-save'));
    await commit(root, 'fixture: relevant source edit');
    const baseline = await audit();
    assert(ownAdvisories(baseline).some(f => f.evidence.decisionId === ids[0]), 'Relevant edit must reopen drift');
    const baselineBytes = await fs.readFile(path.join(root, baseline.baselinePath));
    const originalRecord = JSON.parse(await fs.readFile(path.join(root, `.mason/decisions/${ids[0]}.json`), 'utf8'));
    assert.equal(await fs.readFile(path.join(root, project.golden), 'utf8'), sourceBefore + marker('before-save') + marker('after-save'));
    const prepared = await call('review_decision', { id: ids[0] });
    assert.equal(prepared.status, 'prepared');
    const inspected = await call('review_decision', { id: ids[0], action: 'inspect', inspector: 'Deterministic OSS fixture runner',
      note: 'Verified byte-for-byte that only the two fixture comments were appended. Executable source and the documented rule witness are unchanged.', reviewToken: prepared.reviewToken });
    assert.equal(inspected.status, 'inspected');
    const afterRecord = JSON.parse(await fs.readFile(path.join(root, `.mason/decisions/${ids[0]}.json`), 'utf8'));
    assert.equal(afterRecord.approval, 'proposed'); assert.equal(afterRecord.refreshedHash, originalRecord.refreshedHash);
    assert.deepEqual(afterRecord.history, originalRecord.history);
    await commit(root, 'fixture: record source inspection');
    assert.equal(ownAdvisories(await audit()).length, 0, 'Inspection must clear covered drift');
    const verified = await call('mason_repair', { action: 'verify', baselinePath: baseline.baselinePath });
    assert(verified.findings.every(f => f.status === 'resolved'), 'Original drift evidence must be resolved by separate inspection');
    assert.deepEqual(await fs.readFile(path.join(root, baseline.baselinePath)), baselineBytes);

    // Actual managed hooks: all repository documentation remains in scope.
    const bin = path.join(root, '.mason/benchmark-bin'); await fs.mkdir(bin, { recursive: true });
    const launcher = path.join(bin, process.platform === 'win32' ? 'mason.cmd' : 'mason');
    await fs.writeFile(launcher, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${binary}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(binary)} "$@"\n`, { mode: 0o755 });
    const oldPath = env.PATH; env.PATH = bin + path.delimiter + oldPath;
    try {
      const setup = await run(root, process.execPath, [binary, 'setup', '--host', values.host]);
      await commit(root, 'fixture: activate managed hooks');
      const invoke = async (event, tool, toolId) => {
        const result = await run(root, process.execPath, [binary, '--setup-host', values.host, 'auto', 'hook', '--host', values.host, '--profile'],
          JSON.stringify({ cwd: root, session_id: `${name}-${scope}`, hook_event_name: event, tool_name: tool, tool_use_id: toolId }));
        if (result.stdout.trim()) { JSON.parse(result.stdout); assert(!/automation unavailable|Verification was not established/.test(result.stdout), result.stdout); }
        return result;
      };
      await invoke('SessionStart'); await invoke('UserPromptSubmit');
      const read = [], pairs = [];
      for (let index = 0; index < samples; index++) {
        const readTool = values.host === 'claude' ? 'Read' : 'read_file';
        read.push(await invoke('PreToolUse', readTool, `read-${index}`)); read.push(await invoke('PostToolUse', readTool, `read-${index}`));
        const pre = await invoke('PreToolUse', 'Bash', `shell-${index}`), post = await invoke('PostToolUse', 'Bash', `shell-${index}`);
        pairs.push(pre.ms + post.ms);
      }
      await invoke('Stop');
      const status = await call('mason_automation', { action: 'status' });
      const checks = await call('mason_automation', { action: 'check' });
      const full = JSON.parse(await fs.readFile(path.join(root, checks.reportPath), 'utf8'));
      assert(!full.findings.some(f => f.status !== 'resolved' && ids.includes((f.current ?? f.original).evidence.decisionId)), 'Managed hooks introduced false decision drift');
      assert.deepEqual(await fs.readFile(path.join(root, baseline.baselinePath)), baselineBytes);
      // A further edit must reopen the inspected rule too.
      await fs.appendFile(path.join(root, project.golden), marker('after-inspection')); await commit(root, 'fixture: later relevant edit');
      assert(ownAdvisories(await audit()).some(f => f.evidence.decisionId === ids[0]), 'Inspection must reopen after another relevant edit');
      return { repository: name, url: project.url, commit: project.sha, history: 'full', scope, rules: ids.length,
        trackedFiles: inventory.length, kotlinJavaFiles: inventory.filter(file => /\.(kt|java)$/.test(file)).length, eligibleKotlinJavaFiles: inventory.filter(source).length, anchoredFiles: anchoredFiles.size,
        ruleSource: project.doc, goldenAnchor: project.golden, anchors: scopes, samples,
        correctness: { capturedCommitQuiet: true, unrelatedCommitQuiet: true, relevantEditReopens: true,
          inspectionResolves: true, humanApprovalUnchanged: true, laterEditReopensInspection: true, originalBaselinePreserved: true },
        setupMs: setup.ms, readOnly: stats(read), unchangedPair: stats(pairs),
        existingAudit: { status: full.status, counts: full.counts, skipped: full.checks.skipped, diagnostics: full.diagnostics,
          ran: full.checks.ran, reused: full.checks.reused }, lastStatus: status.verificationStatus };
    } finally { env.PATH = oldPath; }
  } finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); }
}
const report = { version: 1, binary, binarySha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex'),
  runtime: process.version, platform: `${process.platform}-${process.arch}`, host: values.host,
  scope: 'Pinned public source trees with full Git history. Test-local proposals and comment-only edits; no project builds, live agents, network timing or maintainer approval. Whole CLI timings exclude host dispatch.', results: [] };
try {
  await fs.mkdir(cache, { recursive: true }); await fs.mkdir(path.dirname(output), { recursive: true });
  for (const [name, project] of Object.entries(projects)) {
    if (values.repository !== 'all' && values.repository !== name) continue;
    const checkout = path.join(cache, name);
    try { await fs.access(path.join(checkout, '.git')); }
    catch { await run(parent, 'git', ['clone', '--no-checkout', project.url, checkout]); }
    await git(checkout, 'cat-file', '-e', `${project.sha}^{commit}`);
    assert.equal(await git(checkout, 'rev-parse', '--is-shallow-repository'), 'false', 'Fetch complete history into the cache first');
    for (const scope of ['file', 'directory']) {
      console.error(`Benchmarking ${name}/${scope} at ${project.sha.slice(0,12)}`);
      const result = await fixture(name, project, scope); report.results.push(result);
      await fs.writeFile(output, JSON.stringify(report, null, 2));
      console.error(`${name}/${scope}: correctness passed, pair p50 ${result.unchangedPair.p50Ms} ms`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await fs.rm(parent, { recursive: true, force: true }); }
