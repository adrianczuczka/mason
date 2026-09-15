#!/usr/bin/env node
// Whole CLI invocations in isolated repositories; no models or caller project reads.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  binary: { type: 'string', default: 'dist/mason.js' },
  samples: { type: 'string', default: '10' },
  label: { type: 'string', default: 'current' },
  fixture: { type: 'string', default: 'all' },
  host: { type: 'string', default: 'all' },
  profile: { type: 'boolean', default: false },
  'git-metrics': { type: 'boolean', default: false },
  'partial-check': { type: 'boolean', default: false },
  'git-delay-ms': { type: 'string', default: '0' },
  'git-delay-command': { type: 'string', default: 'all' },
  runtime: { type: 'string', default: process.execPath },
} });
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 2 || samples > 100) throw new Error('samples must be 2..100');
if (!['small', 'large', 'wide', 'all'].includes(values.fixture)) throw new Error('fixture must be small, large, wide or all');
if (!['claude', 'codex', 'all'].includes(values.host)) throw new Error('host must be claude, codex or all');
const binary = path.resolve(values.binary);
const runtime = path.resolve(values.runtime);
const gitDelayMs = Number(values['git-delay-ms']);
if (!Number.isInteger(gitDelayMs) || gitDelayMs < 0 || gitDelayMs > 500) throw new Error('git-delay-ms must be 0..500');
if (!['all', 'inventory'].includes(values['git-delay-command'])) throw new Error('git-delay-command must be all or inventory');
const gitMetrics = values['git-metrics'] || gitDelayMs > 0;
const preload = fileURLToPath(new URL('./support/bench-git.cjs', import.meta.url));
const realGit = gitMetrics ? execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : '';

const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mason-hook-bench-')));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const summarize = durations => {
  const sorted = [...durations].sort((a, b) => a - b);
  const percentile = p => Math.round(sorted[Math.ceil(p * sorted.length) - 1] * 10) / 10;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1) };
};
const summarizeRuns = runs => {
  const phases = {};
  for (const label of new Set(runs.flatMap(r => Object.keys(r.profile?.phases ?? {})))) {
    phases[label] = { ...summarize(runs.map(r => r.profile?.phases[label]?.totalMs ?? 0)),
      calls: runs.map(r => r.profile?.phases[label]?.calls ?? 0) };
  }
  const git = {};
  if (gitMetrics) for (const command of new Set(runs.flatMap(run => run.git.map(entry => entry.command)))) {
    git[command] = { calls: runs.map(run => run.git.filter(entry => entry.command === command).length),
      ...summarize(runs.map(run => run.git.filter(entry => entry.command === command).reduce((total, entry) => total + entry.ms, 0))) };
  }
  return { ...summarize(runs.map(r => r.ms)), ...(values.profile ? { phases } : {}),
    ...(gitMetrics ? { git, inventoryCalls: runs.map(run => run.git.filter(entry => entry.inventory).length) } : {}) };
};
async function benchmark(fixture, host) {
  const root = path.join(parent, fixture + '-' + host);
  const expanded = fixture !== 'small';
  const prefix = index => fixture === 'wide' ? `module-${index}` : `packages/pkg-${index}`;
  const bin = path.join(root, 'bin');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(parent, 'empty-gitconfig'),
    GIT_AUTHOR_NAME: 'Mason benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
    GIT_COMMITTER_NAME: 'Mason benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid' };
  if (gitMetrics) Object.assign(env, {
    NODE_OPTIONS: [env.NODE_OPTIONS, '--require ' + JSON.stringify(preload)].filter(Boolean).join(' '),
    MASON_BENCH_GIT_DELAY_MS: String(gitDelayMs), MASON_BENCH_REAL_GIT: realGit,
    MASON_BENCH_GIT_DELAY_COMMAND: values['git-delay-command'],
  });
  let runId = 0;
  for (const key of ['MASON_SETUP_ROOT', 'MASON_SETUP_HOST', 'MASON_SETUP_REVISION']) delete env[key];
  const write = async (file, content) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  };
  function run(command, args, input = '') {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const gitLog = path.join(parent, `${fixture}-${host}-${runId++}.ndjson`);
      const child = spawn(command, args, { cwd: root, env: { ...env, ...(gitMetrics ? { MASON_BENCH_GIT_LOG: gitLog } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Invocation exceeded 30 seconds')); }, 30000);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', async code => {
        clearTimeout(timer);
        const ms = performance.now() - start;
        try {
          let git = [];
          if (gitMetrics) {
            try { git = (await fs.readFile(gitLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fs.rm(gitLog, { force: true });
          }
          code === 0 ? resolve({ ms, stdout, stderr, git }) : reject(new Error(`${command} exited ${code}: ${stderr}`));
        } catch (error) { reject(error); }
      });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.stdin.end(input);
    });
  }
  await fs.mkdir(bin, { recursive: true });
  const launcher = path.join(bin, process.platform === 'win32' ? 'mason.cmd' : 'mason');
  await fs.writeFile(launcher, process.platform === 'win32'
    ? `@echo off\r\n"${runtime}" "${binary}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexec ${quote(runtime)} ${quote(binary)} "$@"\n`, { mode: 0o755 });
  await write('.gitignore', 'bin/\n.mason/reports/\n.mason/local/\n.gradle/\nbuild/\n');
  await write('package.json', JSON.stringify({ private: true, scripts: { test: 'node --test' }, ...(expanded ? { workspaces: [fixture === 'wide' ? 'module-*' : 'packages/*'] } : {}) }));
  await write('src/main.ts', 'export const answer = 42;\n');
  const instructions = 'Entry point: `src/main.ts`. Run `npm run test`.\n'
    + (values['partial-check'] ? 'Run `cd "$PROJECT_DIR" && npm run test`.\n' : '');
  await write('AGENTS.md', instructions + (fixture === 'large' ? 'Packages live in packages/.\n' : ''));
  const packages = fixture === 'wide' ? 12 : fixture === 'large' ? 20 : 0;
  const dimensions = { packages, sourceFiles: 1 + packages * 50, decisions: packages, ignoredFiles: expanded ? 10000 : 0 };
  if (expanded) {
    for (let p = 0; p < dimensions.packages; p++) {
      const module = prefix(p);
      await write(`${module}/package.json`, JSON.stringify({ name: `pkg-${p}`, scripts: { test: 'node --test' } }));
      await write(`${module}/README.md`, 'Entry: `src/file-0.ts`. Run `npm run test`.\n');
      await write(`${module}/.gitignore`, 'generated/\n');
      await Promise.all(Array.from({ length: 50 }, (_, i) => write(`${module}/src/file-${i}.ts`, `export const value${i} = ${i};\n`)));
    }
    // Ignored inventories should not drive audit work, but remain present on disk.
    for (let d = 0; d < 100; d++) await Promise.all(Array.from({ length: 100 }, (_, i) => write(`.gradle/cache-${d}/entry-${i}`, 'generated\n')));
  }
  await run('git', ['init', '-q']);
  await run('git', ['add', '.']);
  await run('git', ['commit', '-qm', 'initial']);
  const head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  for (let i = 0; i < dimensions.decisions; i++) await write(`.mason/decisions/lesson-${i}.json`, JSON.stringify({
    version: 1, id: `lesson-${i}`, title: `Constraint ${i}`, body: 'Keep retries bounded because callers have a deadline.',
    category: 'decision', status: 'active', files: [`${prefix(i)}/src/file-0.ts`], tags: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', refreshedHash: head,
  }));
  const masonVersion = (await run(runtime, [binary, '--version'])).stdout.trim();
  const runtimeVersion = (await run(runtime, ['--version'])).stdout.trim();
  await run(runtime, [binary, 'setup', '--host', host]);
  await run('git', ['add', '.']);
  await run('git', ['commit', '--allow-empty', '-qm', `configure ${host}`]);
  const invoke = async (name, tool = undefined, id = undefined) => {
    const outcome = await run(runtime, [binary, '--setup-host', host, 'auto', 'hook', '--host', host, ...(values.profile ? ['--profile'] : [])], JSON.stringify({
      cwd: root, session_id: `benchmark-${host}`, hook_event_name: name, tool_name: tool, tool_use_id: id,
    }));
    if (outcome.stdout.trim()) {
      JSON.parse(outcome.stdout);
      if (/automation unavailable|Verification was not established/.test(outcome.stdout)) throw new Error(outcome.stdout);
    }
    const profile = outcome.stderr.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).find(r => r?.kind === 'mason-profile');
    if (values.profile && !profile) throw new Error('Profile output missing: ' + outcome.stderr);
    return { ...outcome, profile };
  };
  const latest = async () => {
    const directory = (await fs.readdir(path.join(root, '.mason/reports/automation')))[0];
    const state = JSON.parse(await fs.readFile(path.join(root, '.mason/reports/automation', directory, 'state.json'), 'utf8'));
    return { state, report: JSON.parse(await fs.readFile(path.join(root, state.latest), 'utf8')) };
  };
  const start = await invoke('SessionStart');
  await invoke('UserPromptSubmit');
  const read = [], mutation = [], pairs = [];
  for (let index = 0; index < samples; index++) {
    for (const event of ['PreToolUse', 'PostToolUse']) read.push(await invoke(event, host === 'claude' ? 'Read' : 'read_file', `read-${index}`));
    const pre = await invoke('PreToolUse', 'Bash', `shell-${index}`);
    const post = await invoke('PostToolUse', 'Bash', `shell-${index}`);
    mutation.push(pre, post); pairs.push(pre.ms + post.ms);
  }
  const initial = await latest();
  const skipped = initial.report.checks.skipped;
  const expectedPartial = values['partial-check'] && skipped.length === 1 && skipped[0].check === 'dead-command' && skipped[0].doc === 'AGENTS.md';
  if ((!expectedPartial && skipped.length) || (values['partial-check'] && !expectedPartial) || initial.report.diagnostics.length) {
    throw new Error('Initial benchmark checks differ from the selected scenario: ' + JSON.stringify(initial.report));
  }
  const oneBaseline = initial.state.baselines.length;
  // Retain actual findings from sequential source deletions, never forge baselines.
  const edited = [];
  for (let i = 0; i < (expanded ? 3 : 1); i++) {
    await invoke('PreToolUse', 'Bash', `delete-${i}`);
    await fs.rm(path.join(root, expanded ? `${prefix(i)}/src/file-0.ts` : 'src/main.ts'));
    edited.push(await invoke('PostToolUse', 'Bash', `delete-${i}`));
  }
  const retained = await latest();
  if (retained.state.baselines.length <= oneBaseline || !retained.report.findings.some(f => f.status !== 'resolved')) throw new Error('Deletion did not retain original evidence');
  const baselineBytes = await Promise.all(retained.state.baselines.map(b => fs.readFile(path.join(root, b.path), 'utf8')));
  const multiple = [], multiplePairs = [];
  for (let i = 0; i < samples; i++) {
    const pre = await invoke('PreToolUse', 'Bash', `retained-${i}`);
    const post = await invoke('PostToolUse', 'Bash', `retained-${i}`);
    multiple.push(pre, post); multiplePairs.push(pre.ms + post.ms);
  }
  await invoke('PreToolUse', host === 'claude' ? 'Edit' : 'apply_patch', 'repair');
  if (expanded) for (let i = 0; i < 3; i++) await write(`${prefix(i)}/README.md`, 'Entry: `src/file-1.ts`. Run `npm run test`.\n');
  else await write('AGENTS.md', (await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).replace('Entry point: `src/main.ts`.', 'The entry point was removed.'));
  const dirtyRepair = await invoke('PostToolUse', 'Bash', 'repair');
  await run('git', ['add', '.']);
  await run('git', ['commit', '-qm', 'repair references']);
  const final = await invoke('Stop');
  const done = await latest();
  if (done.report.counts.unresolved || done.report.counts.resolved !== (expanded ? 3 : 1)
      || done.report.counts['review-required'] !== (expanded ? 3 : 0) || done.report.counts.unverified) {
    throw new Error('Final repair did not preserve the expected reference and decision outcomes');
  }
  if (JSON.stringify(done.report.checks.skipped) !== JSON.stringify(skipped)
      || done.report.status !== (expanded || values['partial-check'] ? 'incomplete' : 'verified')) {
    throw new Error('Final repair changed the expected skipped checks or verification status');
  }
  if (JSON.stringify(baselineBytes) !== JSON.stringify(await Promise.all(retained.state.baselines.map(b => fs.readFile(path.join(root, b.path), 'utf8'))))) throw new Error('Original evidence changed');
  return { fixture, host, masonVersion, runtimeVersion, dimensions, partialCheck: values['partial-check'], initialSkipped: skipped, initialBaselines: oneBaseline, retainedBaselines: retained.state.baselines.length,
    sessionStart: summarizeRuns([start]), readOnly: summarizeRuns(read), cachedMutation: summarizeRuns(mutation), cachedPair: summarize(pairs),
    retainedMutation: summarizeRuns(multiple), retainedPair: summarize(multiplePairs), changedInputs: summarizeRuns(edited),
    dirtyRepair: summarizeRuns([dirtyRepair]), finalCommit: summarizeRuns([final]), finalStatus: done.report.status, finalCounts: done.report.counts };
}
try {
  const results = [];
  for (const fixture of values.fixture === 'all' ? ['small', 'large', 'wide'] : [values.fixture]) {
    for (const host of values.host === 'all' ? ['claude', 'codex'] : [values.host]) {
      process.stderr.write(`Benchmarking ${fixture}/${host} (${values.label})\n`);
      results.push(await benchmark(fixture, host));
    }
  }
  console.log(JSON.stringify({ version: 3, label: values.label, binary, runtime, gitMetrics, gitDelayMs, gitDelayCommand: values['git-delay-command'], platform: `${process.platform}-${process.arch}`, nodeVersion: process.version,
    scope: 'Sequential local CLI invocations, including startup; excludes host dispatch and outer shell guard. Synthetic workloads, no model calls. Phase and Git subprocess times can overlap; do not sum them. Delayed Git adds a worker process per call as well as the requested delay; use it for comparative stress measurements, not native latency.', results }, null, 2));
} finally { await fs.rm(parent, { recursive: true, force: true }); }
