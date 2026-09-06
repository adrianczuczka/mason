import type { Host } from "../automation/store.js";

// Keep configuration portable across clones and subdirectory launches. Arguments
// are fixed strings, never interpolated repository paths or user tool input.
export const BOOTSTRAP = "require(require('node:path').join(require('node:child_process').execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim(),'.mason','run.cjs'))";
export const mcpCommand = (host: Host) => ({ command: "node", args: ["-e", BOOTSTRAP, "--", host, "mcp"] });
export const hookCommand = (host: Host) => `node -e "${BOOTSTRAP}" -- ${host} auto`;

export const LAUNCHER = `// Managed by mason-auto setup. Rerun setup to install this checkout's pinned runtime.
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const launchArgs = process.argv.slice(1);
(async () => {
  const root = path.dirname(__dirname);
  const args = launchArgs;
  const [host, command, ...rest] = args;
  if (!['codex','claude'].includes(host) || !['auto','mcp'].includes(command)) throw new Error('Invalid Mason launcher arguments.');
  const setup = JSON.parse(fs.readFileSync(path.join(__dirname, 'setup.json'), 'utf8'));
  const entry = setup.hosts?.[host];
  if (setup.version !== 1 || !entry || !/^[a-f0-9]{24}$/.test(entry.runtime?.id)) throw new Error('Mason is not configured for this host. Rerun mason-auto setup.');
  const binary = path.join(__dirname, 'runtime', entry.runtime.id, 'node_modules', 'mason-context', 'dist', 'mason-' + command + '.js');
  if (!fs.existsSync(binary)) throw new Error('The pinned Mason runtime is missing in this checkout. Rerun mason-auto setup --host ' + host + '.');
  process.env.MASON_SETUP_ROOT = root;
  process.env.MASON_SETUP_HOST = host;
  process.env.MASON_SETUP_REVISION = entry.revision;
  process.argv = [process.execPath, binary, ...rest];
  await import(pathToFileURL(binary).href);
})().catch(error => {
  const message = 'Mason setup unavailable: ' + error.message;
  if (launchArgs[1] === 'auto' && launchArgs[2] === 'hook') { console.log(JSON.stringify({systemMessage: message})); process.exitCode = 0; }
  else { console.error(message); process.exitCode = 2; }
});
`;
