#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { target: { type: 'string' }, out: { type: 'string' } } });
const target = values.target ?? `${process.platform}-${process.arch}`;
const config = JSON.parse(await fs.readFile(path.join(root, 'scripts/standalone-node.json'), 'utf8'));
const selected = config.archives[target];
if (!selected) throw new Error('Unsupported target: ' + target);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const out = path.resolve(values.out ?? path.join(root, '.standalone'));
const name = `mason-${target}`, bundle = path.join(out, name);
const cache = path.join(out, '.cache');
await fs.mkdir(cache, { recursive: true });
const archive = path.join(cache, selected.file);
let bytes = await fs.readFile(archive).catch(() => null);
if (!bytes || digest(bytes) !== selected.sha256) {
  const response = await fetch(`https://nodejs.org/dist/v${config.version}/${selected.file}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Node download failed: ' + response.status);
  bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== selected.sha256) throw new Error('Node archive checksum mismatch.');
  await fs.writeFile(archive, bytes);
}
await fs.rm(bundle, { recursive: true, force: true });
const app = path.join(bundle, 'app');
await fs.mkdir(app, { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'LICENSE']) await fs.copyFile(path.join(root, file), path.join(app, file));
await fs.cp(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
// Invoke npm's JS entry point directly; Windows cannot exec npm.cmd without a shell.
const npmCli = process.env.npm_execpath;
if (npmCli) execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit' });
else execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
await fs.rm(path.join(app, 'node_modules/.bin'), { recursive: true, force: true });
const unpack = await fs.mkdtemp(path.join(cache, 'node-'));
try {
  if (selected.file.endsWith('.zip') && process.platform !== 'win32') execFileSync('unzip', ['-q', archive, '-d', unpack]);
  else execFileSync('tar', ['-xf', archive, '-C', unpack]);
  const nodeRoot = path.join(unpack, selected.file.replace(/\.tar\.gz$|\.zip$/, ''));
  const windows = target.startsWith('win32-');
  await fs.copyFile(path.join(nodeRoot, windows ? 'node.exe' : 'bin/node'), path.join(bundle, windows ? 'node.exe' : 'node'));
  if (!windows) await fs.chmod(path.join(bundle, 'node'), 0o755);
  await fs.copyFile(path.join(nodeRoot, 'LICENSE'), path.join(bundle, 'NODE-LICENSE'));
} finally { await fs.rm(unpack, { recursive: true, force: true }); }
for (const file of ['install.sh', 'install.ps1']) await fs.copyFile(path.join(root, file), path.join(bundle, file));
const files = {};
async function inventory(dir, prefix = '') {
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Standalone bundle cannot contain symlinks: ' + file);
    if (entry.isDirectory()) await inventory(path.join(dir, entry.name), file + '/');
    else {
      if (file.endsWith('.node')) throw new Error('Native dependency requires a target-specific build: ' + file);
      files[file] = digest(await fs.readFile(path.join(dir, entry.name)));
    }
  }
}
await inventory(bundle);
const pkg = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'));
await fs.writeFile(path.join(bundle, 'bundle.json'), JSON.stringify({ format: 1, version: pkg.version, target, nodeVersion: config.version, files }, null, 2) + '\n');
const filename = name + (target.startsWith('win32-') ? '.zip' : '.tar.gz');
const output = path.join(out, filename);
await fs.rm(output, { force: true });
if (filename.endsWith('.zip') && process.platform !== 'win32') execFileSync('zip', ['-qr', output, name], { cwd: out });
else execFileSync('tar', filename.endsWith('.zip') ? ['-a', '-cf', output, '-C', out, name] : ['-czf', output, '-C', out, name]);
await fs.writeFile(output + '.sha256', digest(await fs.readFile(output)) + '  ' + filename + '\n');
console.log(`Built ${output}; bundled Node ${config.version}, ${Object.keys(files).length} verified files.`);
