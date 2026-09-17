// Run only in the tag publish workflow after all native bundle smoke tests pass.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sign, verify } from 'sigstore';
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${pkg.version}`) throw new Error('Release tag and package version differ.');
const dir = '.standalone-release';
const checksums = [];
const signedAssets = {};
const assets = [];
for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']) {
  const name = `mason-${target}.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`;
  const file = path.join(dir, name), bytes = await fs.readFile(file);
  const line = createHash('sha256').update(bytes).digest('hex') + '  ' + name;
  if ((await fs.readFile(file + '.sha256', 'utf8')).trim() !== line) throw new Error('Release artifact checksum mismatch: ' + name);
  checksums.push(line); assets.push(file);
  signedAssets[name] = line.slice(0, 64);
}
await fs.writeFile(path.join(dir, 'SHA256SUMS'), checksums.join('\n') + '\n');
assets.push(path.join(dir, 'SHA256SUMS'), 'install.sh', 'install.ps1');
const manifest = Buffer.from(JSON.stringify({ format: 1, version: pkg.version, publishedAt: new Date().toISOString(), assets: signedAssets }) + '\n');
const signature = await sign(manifest);
await verify(signature, manifest, {
  certificateIdentityURI: `https://github.com/adrianczuczka/mason/.github/workflows/publish.yml@refs/tags/${tag}`,
  certificateIssuer: 'https://token.actions.githubusercontent.com',
  ctLogThreshold: 1, tlogThreshold: 1,
});
await fs.writeFile(path.join(dir, 'update.json'), manifest);
await fs.writeFile(path.join(dir, 'update.sigstore.json'), JSON.stringify(signature) + '\n');
assets.push(path.join(dir, 'update.json'), path.join(dir, 'update.sigstore.json'));
const gh = args => execFileSync('gh', args, { stdio: 'inherit' });
try { execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' }); }
catch { gh(['release', 'create', tag, '--verify-tag', '--draft', '--generate-notes', ...(pkg.version.includes('-') ? ['--prerelease'] : [])]); }
// Never overwrite an already published archive for a version.
gh(['release', 'upload', tag, ...assets]);
gh(['release', 'edit', tag, '--draft=false']);
