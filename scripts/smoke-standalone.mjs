#!/usr/bin/env node
// Real installer, packaged MCP and hook commands with Node/npm absent from PATH.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32', target = `${process.platform}-${process.arch}`;
const bundle = path.join(root, '.standalone', `mason-${target}`);
const original = JSON.parse(await fs.readFile(path.join(bundle, 'bundle.json'), 'utf8'));
const archiveName = `mason-${target}.${windows ? 'zip' : 'tar.gz'}`;
const archive = path.join(root, '.standalone', archiveName);
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mason-standalone-')));
const home = path.join(temp, "Mason's $installation"), bin = path.join(temp, 'user bin');
const repo = path.join(temp, "project's $files"), nativeBin = path.join(temp, 'native');
await fs.mkdir(nativeBin);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const resolve = command => execFileSync(windows ? 'where.exe' : '/bin/sh', windows ? [command] : ['-c', 'command -v "$1"', 'resolve', command], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
let nativePath;
if (windows) nativePath = [path.dirname(resolve('git.exe')), path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter);
else {
  for (const command of ['sh', 'git', 'uname', 'curl', 'grep', 'awk', 'tar', 'gzip', 'mktemp', 'rm', 'dirname', 'cat', ...(process.platform === 'darwin' ? ['shasum'] : ['sha256sum'])]) await fs.symlink(resolve(command), path.join(nativeBin, command));
  nativePath = nativeBin;
}
const env = { ...process.env, PATH: nativePath, MASON_HOME: home, MASON_BIN_DIR: bin, MASON_VERSION: original.version,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'empty-gitconfig'), GIT_AUTHOR_NAME: 'Mason test', GIT_AUTHOR_EMAIL: 'mason@example.invalid', GIT_COMMITTER_NAME: 'Mason test', GIT_COMMITTER_EMAIL: 'mason@example.invalid' };
for (const key of ['MASON_SETUP_ROOT', 'MASON_SETUP_HOST', 'MASON_SETUP_REVISION', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? temp, env, windowsHide: true, ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${command} ${args.join(' ')}`)); }, options.timeoutMs ?? 120000);
    child.on('close', code => { clearTimeout(timer); if (code !== 0 && !options.allowFailure) reject(new Error(`${command} exited ${code}: ${stderr}\n${stdout}`)); else resolve({ code, stdout, stderr }); });
    // Short-lived commands may close stdin before a write completes. Their exit
    // status and the protocol assertions below still determine success.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(options.input);
  });
}
const mason = (...args) => windows ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(bin, 'mason.ps1'), ...args]) : run(path.join(bin, 'mason'), args);
const git = (...args) => run('git', args, { cwd: repo });
const commit = async message => { await git('add', '-A'); await git('commit', '-m', message); };
let corrupt = false;
const releases = new Map([[original.version, archive]]);
const server = http.createServer(async (request, response) => {
  try {
    const parts = new URL(request.url, 'http://localhost').pathname.split('/');
    const version = parts[1]?.replace(/^v/, ''), file = releases.get(version);
    if (!file) { response.writeHead(404).end(); return; }
    if (parts[2] === 'SHA256SUMS') response.end(digest(await fs.readFile(file)) + '  ' + archiveName + '\n');
    else if (parts[2] === archiveName) {
      if (corrupt) response.end('corrupt download'); else createReadStream(file).pipe(response);
    } else response.writeHead(404).end();
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
env.MASON_RELEASE_BASE = `http://127.0.0.1:${server.address().port}`;
const install = () => windows ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install.ps1')]) : run('sh', [path.join(root, 'install.sh')]);
async function context(host, directory = repo) {
  const config = host === 'codex' ? parse(await fs.readFile(path.join(directory, '.codex/config.toml'), 'utf8')).mcp_servers.mason
    : JSON.parse(await fs.readFile(path.join(directory, '.mcp.json'), 'utf8')).mcpServers.mason;
  assert.notEqual(config.command, 'node');
  const transport = new StdioClientTransport({ ...config, env, cwd: path.join(directory, 'src'), stderr: 'pipe' });
  const client = new Client({ name: 'standalone-smoke', version: '1' });
  try { await client.connect(transport); const result = await client.callTool({ name: 'get_context', arguments: { dir: directory, task: 'Rename the entry module', files: ['src/old.ts'] } }); assert(!result.isError); }
  finally { await client.close(); }
}
async function hook(host, event, directory = repo) {
  const config = JSON.parse(await fs.readFile(path.join(directory, host === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'), 'utf8'));
  const handler = config.hooks[event][0].hooks[0], command = handler.command;
  const input = JSON.stringify({ cwd: directory, session_id: 'ordinary-' + host, hook_event_name: event, tool_name: 'Edit', tool_use_id: event });
  // Match Node's shell launch: cmd.exe needs the whole command quoted verbatim,
  // otherwise argument escaping inserts literal backslashes into PowerShell.
  const output = await run(windows ? 'cmd.exe' : 'sh', windows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], { cwd: path.join(directory, 'src'), input, windowsVerbatimArguments: windows, timeoutMs: handler.timeout * 1000 });
  if (output.stdout.trim()) assert.doesNotThrow(() => JSON.parse(output.stdout));
  return output.stdout.trim() ? JSON.parse(output.stdout) : null;
}
async function baselineBytes(directory = repo) {
  const repairs = path.join(directory, '.mason/reports/repairs');
  return Object.fromEntries(await Promise.all((await fs.readdir(repairs)).filter(f => f.endsWith('.json')).map(async f => [f, await fs.readFile(path.join(repairs, f), 'utf8')])));
}
try {
  const probe = await run(windows ? 'powershell.exe' : 'sh', windows ? ['-NoProfile', '-Command', 'if ((Get-Command node,npm -ErrorAction SilentlyContinue)) { exit 1 }'] : ['-c', 'if command -v node || command -v npm; then exit 1; fi']);
  assert.equal(probe.code, 0);
  console.log('Node and npm absent from child PATH. Installing through the release installer…');
  await install();
  assert.equal((await mason('--version')).stdout.trim(), original.version);
  await install(); // Idempotent download/install.
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await git('init');
  await fs.writeFile(path.join(repo, 'src/old.ts'), 'export const answer = 42;\n');
  await fs.writeFile(path.join(repo, 'AGENTS.md'), 'Entry module: `src/old.ts`.\n');
  await commit('initial');
  for (const host of ['codex', 'claude']) {
    const result = JSON.parse((await mason('setup', '--dir', repo, '--host', host, '--json')).stdout);
    assert.equal(result.activation.status, 'pending');
    assert.equal(result.runtime.bundle.target, target);
  }
  await commit('configure Mason');
  const before = JSON.parse(await fs.readFile(path.join(repo, '.mason/setup.json'), 'utf8'));
  console.log('Setup installed both hosts in a non-npm repo. Exercising MCP and retained repair evidence…');
  await context('codex');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse']) await hook('codex', event);
  await git('mv', 'src/old.ts', 'src/new.ts');
  await commit('rename entry');
  await hook('codex', 'PostToolUse');
  const baselines = await baselineBytes();
  assert(Object.values(baselines).some(text => text.includes('src/old.ts') && text.includes('deleted-reference')));
  const agents = await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8');
  await hook('codex', 'PreToolUse');
  await fs.writeFile(path.join(repo, 'AGENTS.md'), agents.replace('src/old.ts', 'src/new.ts'));
  await commit('update instructions');
  await hook('codex', 'PostToolUse');
  await hook('codex', 'Stop');
  for (const [name, bytes] of Object.entries(baselines)) assert.equal((await baselineBytes())[name], bytes);
  await context('claude');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) await hook('claude', event);
  const status = JSON.parse((await mason('status', '--dir', repo, '--json')).stdout);
  assert.equal(status.setup.status, 'active');
  assert.equal(status.setup.hosts.codex.verificationStatus, 'incomplete');
  const report = JSON.parse(await fs.readFile(path.join(repo, status.reportPath), 'utf8'));
  assert.equal(report.counts.unresolved, 0);
  assert(report.counts.resolved > 0);
  assert.equal((await mason('audit', '--dir', repo)).code, 0);
  assert.equal((await mason('review', '--dir', repo, '--base', 'HEAD')).code, 0);
  console.log('Both packaged MCP servers and all five hooks passed; original findings survived the final commit.');

  // A local next-release fixture exercises the real upgrade installer and version pinning.
  const next = original.version.split('-')[0].split('.').map(Number); next[2]++;
  const nextVersion = next.join('.') + '-smoke';
  const nextOut = path.join(temp, 'next'); await fs.mkdir(nextOut);
  const nextBundle = path.join(nextOut, `mason-${target}`);
  await fs.cp(bundle, nextBundle, { recursive: true });
  const nextManifest = structuredClone(original); nextManifest.version = nextVersion;
  const changed = ['app/package.json', ...(await fs.readdir(path.join(nextBundle, 'app/dist'))).filter(f => f.endsWith('.js')).map(f => 'app/dist/' + f)];
  for (const file of changed) {
    const full = path.join(nextBundle, file);
    const text = (await fs.readFile(full, 'utf8')).replaceAll(original.version, nextVersion);
    await fs.writeFile(full, text); nextManifest.files[file] = digest(text);
  }
  await fs.writeFile(path.join(nextBundle, 'bundle.json'), JSON.stringify(nextManifest, null, 2) + '\n');
  const nextArchive = path.join(nextOut, archiveName);
  execFileSync('tar', windows ? ['-a', '-cf', nextArchive, '-C', nextOut, `mason-${target}`] : ['-czf', nextArchive, '-C', nextOut, `mason-${target}`]);
  releases.set(nextVersion, nextArchive);
  await mason('upgrade', nextVersion);
  assert.equal((await mason('--version')).stdout.trim(), nextVersion);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(repo, '.mason/setup.json'), 'utf8')), before);
  await context('codex'); await hook('codex', 'Stop');
  const cloned = path.join(temp, 'fresh clone');
  await git('clone', repo, cloned);
  const pending = JSON.parse((await mason('status', '--dir', cloned, '--json')).stdout);
  assert.notEqual(pending.setup.status, 'active');
  const missingRuntime = await hook('codex', 'Stop', cloned);
  assert(missingRuntime.systemMessage.includes('runtime unavailable'));
  await mason('setup', '--dir', cloned, '--host', 'codex');
  await context('codex', cloned);
  const upgraded = JSON.parse((await mason('setup', '--dir', repo, '--host', 'codex', '--json')).stdout);
  assert.equal(upgraded.runtime.version, nextVersion);
  assert.notEqual(upgraded.runtime.id, before.hosts.codex.runtime.id);
  assert.equal(upgraded.activation.hosts.codex.status, 'pending');
  for (const [name, bytes] of Object.entries(baselines)) assert.equal((await baselineBytes())[name], bytes);
  console.log('Global upgrade retained project pins; explicit setup upgraded one host; fresh clone recovered without inherited activation.');

  corrupt = true;
  const failure = await mason('upgrade', nextVersion).then(() => null, error => error);
  assert(failure && failure.message.includes('checksum mismatch'));
  assert.equal((await mason('--version')).stdout.trim(), nextVersion);
  corrupt = false;
  const record = JSON.parse(await fs.readFile(path.join(home, 'install.json'), 'utf8'));
  const launcher = path.join(bin, windows ? 'mason.ps1' : 'mason');
  await fs.appendFile(launcher, '\n# user edit\n');
  const refused = await install().then(() => null, error => error);
  assert(refused && refused.message.includes('unrelated or edited launcher'));
  await fs.writeFile(launcher, record.launchers[path.basename(launcher)], { mode: 0o755 });
  await mason('uninstall');
  console.log('Uninstall returned; waiting for deferred Windows runtime cleanup…');
  for (let i = 0; i < 240 && await fs.access(home).then(() => true, () => false); i++) await new Promise(resolve => setTimeout(resolve, 250));
  const remaining = await fs.readdir(home, { recursive: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const cleanupStatus = await fs.readFile(path.join(home, '.uninstall-status.txt'), 'utf8').catch(() => 'unavailable');
  assert(remaining === null, `Installation cleanup ${cleanupStatus}; left ${remaining?.length} entries: ${remaining?.slice(0, 20).join(', ')}`);
  await context('codex'); await hook('codex', 'Stop');
  console.log('Corrupt upgrade and edited launcher rejected; uninstall retained working project runtimes.');
  console.log(`Standalone smoke passed on ${target}. Native host trust/activation UI is outside this protocol test.`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (process.env.MASON_KEEP_SMOKE) console.log('Kept smoke directory: ' + temp);
  else await fs.rm(temp, { recursive: true, force: true });
}
