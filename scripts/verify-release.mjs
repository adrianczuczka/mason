// Shared by npm publishing and independent Official MCP Registry retries.
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

export function validateRelease(pkg, server, tag) {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/, 'Invalid package version');
  assert.equal(tag, `v${pkg.version}`, 'Release tag and package version differ');
  assert.equal(server.version, pkg.version, 'server.json and package.json versions differ');
  assert.equal(server.name, 'com.adrianczuczka/mason', 'Unexpected registry namespace for domain authentication');
  assert.equal(pkg.mcpName, server.name, 'npm mcpName and registry name differ');
  assert.equal(server.packages?.length, 1, 'Expected one npm package in server.json');
  const entry = server.packages[0];
  assert.equal(entry.registryType, 'npm', 'Expected an npm registry package');
  assert.equal(entry.identifier, pkg.name, 'Registry package identifier and npm package name differ');
  assert.equal(entry.version, pkg.version, 'Registry package version and npm package version differ');
}

export function validateNpm(pkg, published) {
  assert.equal(published.name, pkg.name, 'Published npm package name differs');
  assert.equal(published.version, pkg.version, 'Release version is not available on npm');
  assert.equal(published.mcpName, pkg.mcpName, 'Published npm mcpName differs');
}

export function validateRegistry(server, published) {
  assert.equal(published.server?.name, server.name, 'Published registry name differs');
  assert.equal(published.server?.version, server.version, 'Published registry version differs');
  assert.deepEqual(published.server?.packages, server.packages, 'Published registry package metadata differs');
  assert.equal(published._meta?.['io.modelcontextprotocol.registry/official']?.status, 'active', 'Registry version is not active');
}

export function registryAlreadyPublished(server, status, body) {
  if (status === 404) return false;
  assert.equal(status, 200, `Registry lookup failed with HTTP ${status}`);
  validateRegistry(server, body);
  return true;
}

async function verifyRemote(url, validate) {
  // Allow for registry propagation; fail the job if the expected metadata never appears.
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      validate(await response.json());
      return;
    } catch (error) {
      if (attempt === 6) throw error;
      console.warn(`Metadata check ${attempt}/6 failed: ${error.message}. Retrying in 10 seconds.`);
      await setTimeout(10_000);
    }
  }
}

async function main() {
  const [tag, directory, mode, ...extra] = process.argv.slice(2);
  assert(tag && directory && extra.length === 0 && [undefined, '--npm', '--registry', '--registry-plan'].includes(mode),
    'Usage: node scripts/verify-release.mjs <release-tag> <manifest-directory> [--npm|--registry|--registry-plan]');
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const server = JSON.parse(await readFile(path.join(directory, 'server.json'), 'utf8'));
  validateRelease(pkg, server, tag);
  if (mode === '--npm') {
    await verifyRemote(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`,
      published => validateNpm(pkg, published));
  } else if (mode === '--registry' || mode === '--registry-plan') {
    // Check this exact version so retrying an older release also works.
    const url = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`;
    if (mode === '--registry-plan') {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const published = registryAlreadyPublished(server, response.status, response.ok ? await response.json() : null);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `published=${published}\n`);
      console.log(published ? 'This registry version is already published and verified.' : 'This registry version needs publication.');
    } else {
      await verifyRemote(url, published => validateRegistry(server, published));
    }
  }
  console.log(`Verified ${tag} release metadata${mode ? ` (${mode.slice(2)})` : ''}.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
