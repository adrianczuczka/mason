#!/usr/bin/env node
// Measure complete CLI invocations, including process startup and Git work.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  binary: { type: 'string', default: 'dist/mason.js' },
  samples: { type: 'string', default: '10' },
  label: { type: 'string', default: 'current' },
} });
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 2 || samples > 100) throw new Error('samples must be 2..100');
const binary = path.resolve(values.binary);
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mason-hook-bench-')));
const bin = path.join(root, 'bin');
const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
  GIT_AUTHOR_NAME: 'Mason benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
  GIT_COMMITTER_NAME: 'Mason benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid' };
for (const key of ['MASON_SETUP_ROOT', 'MASON_SETUP_HOST', 'MASON_SETUP_REVISION']) delete env[key];
function run(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(command, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Invocation exceeded 30 seconds')); }, 30000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ ms: performance.now() - start, stdout }) : reject(new Error(`${command} exited ${code}: ${stderr}`)); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const summarize = durations => {
  const sorted = [...durations].sort((a, b) => a - b);
  const percentile = p => Math.round(sorted[Math.ceil(p * sorted.length) - 1] * 10) / 10;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1) };
};
try {
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'mason.cmd' : 'mason'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${binary}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(binary)} "$@"\n`, { mode: 0o755 });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/main.ts'), 'export const answer = 42;\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Entry point: `src/main.ts`.\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'bin/\n.mason/\n');
  await run('git', ['init', '-q']);
  await run('git', ['add', '.']);
  await run('git', ['commit', '-qm', 'initial']);
  const version = (await run(process.execPath, [binary, '--version'])).stdout.trim();
  const result = { version: 1, label: values.label, masonVersion: version, platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version, fixture: 'one source file and managed instructions; cached checks; no model calls',
    scope: 'Complete local CLI invocations, not host dispatch or a large-repository benchmark.', hosts: {} };
  for (const host of ['claude', 'codex']) {
    await run(process.execPath, [binary, 'setup', '--host', host]);
    await run('git', ['add', '.']);
    await run('git', ['commit', '--allow-empty', '-qm', `configure ${host}`]);
    const invoke = async (name, tool = undefined, id = undefined) => {
      const outcome = await run(process.execPath, [binary, '--setup-host', host, 'auto', 'hook', '--host', host], JSON.stringify({
        cwd: root, session_id: `benchmark-${host}`, hook_event_name: name, tool_name: tool, tool_use_id: id,
      }));
      if (outcome.stdout.trim()) {
        JSON.parse(outcome.stdout);
        if (/automation unavailable|Verification was not established/.test(outcome.stdout)) throw new Error(outcome.stdout);
      }
      return outcome.ms;
    };
    const start = await invoke('SessionStart');
    await invoke('UserPromptSubmit');
    const read = [], mutation = [];
    for (let index = 0; index < samples; index++) {
      for (const event of ['PreToolUse', 'PostToolUse']) read.push(await invoke(event, host === 'claude' ? 'Read' : 'read_file', `read-${index}`));
      for (const event of ['PreToolUse', 'PostToolUse']) mutation.push(await invoke(event, 'Bash', `shell-${index}`));
    }
    result.hosts[host] = { sessionStartMs: Math.round(start), readOnly: summarize(read), cachedMutation: summarize(mutation), stopMs: Math.round(await invoke('Stop')) };
  }
  console.log(JSON.stringify(result, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
