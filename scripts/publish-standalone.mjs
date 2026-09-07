// Run only in the tag publish workflow after all native bundle smoke tests pass.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${pkg.version}`) throw new Error('Release tag and package version differ.');
const dir = '.standalone-release';
const checksums = [];
const assets = [];
for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']) {
  const name = `mason-${target}.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`;
  const file = path.join(dir, name), bytes = await fs.readFile(file);
  const line = createHash('sha256').update(bytes).digest('hex') + '  ' + name;
  if ((await fs.readFile(file + '.sha256', 'utf8')).trim() !== line) throw new Error('Release artifact checksum mismatch: ' + name);
  checksums.push(line); assets.push(file);
}
await fs.writeFile(path.join(dir, 'SHA256SUMS'), checksums.join('\n') + '\n');
assets.push(path.join(dir, 'SHA256SUMS'), 'install.sh', 'install.ps1');
const gh = args => execFileSync('gh', args, { stdio: 'inherit' });
try { execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' }); }
catch { gh(['release', 'create', tag, '--verify-tag', '--draft', '--generate-notes', ...(pkg.version.includes('-') ? ['--prerelease'] : [])]); }
// Never overwrite an already published archive for a version.
gh(['release', 'upload', tag, ...assets]);
gh(['release', 'edit', tag, '--draft=false']);
