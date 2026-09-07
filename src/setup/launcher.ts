import type { Host } from "../automation/store.js";
import type { Runtime } from "./model.js";

// Keep configuration portable across clones and subdirectory launches. Arguments
// are fixed strings, never interpolated repository paths or user tool input.
export const BOOTSTRAP = "require(require('node:path').join(require('node:child_process').execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim(),'.mason','run.cjs'))";
const POWERSHELL_BOOTSTRAP = "& (Join-Path (git rev-parse --show-toplevel) '.mason/run.ps1')";
export const mcpCommand = (host: Host, runtime?: Runtime) => !runtime?.bundle
  ? { command: "node", args: ["-e", BOOTSTRAP, "--", host, "mcp"] }
  : process.platform === "win32"
    ? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_BOOTSTRAP, host, "mcp"] }
    : { command: "sh", args: ["-c", 'exec sh "$(git rev-parse --show-toplevel)/.mason/run.sh" "$@"', "mason", host, "mcp"] };
export const hookCommand = (host: Host, runtime?: Runtime) => !runtime?.bundle
  ? `node -e "${BOOTSTRAP}" -- ${host} auto`
  : process.platform === "win32"
    ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${POWERSHELL_BOOTSTRAP} ${host} auto"`
    : `sh "$(git rev-parse --show-toplevel)/.mason/run.sh" ${host} auto`;

export const SHELL_LAUNCHER = `#!/bin/sh
set -eu
advisory=0
if [ "\${2-}" = auto ] && [ "\${3-}" = hook ]; then advisory=1; fi
fail() {
  if [ "$advisory" -eq 1 ]; then printf '%s\\n' '{"systemMessage":"Mason runtime unavailable. Rerun mason setup for this checkout; verification was not established."}'; exit 0; fi
  echo 'Mason runtime unavailable. Rerun mason setup for this checkout.' >&2; exit 2
}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || fail
case "\${1-}" in codex|claude) ;; *) fail ;; esac
pointer="$root/.mason/runtime/$1.txt"
[ -f "$pointer" ] || fail
runtime=$(cat "$pointer") || fail
case "$runtime" in ''|*[!0-9a-f]*) fail ;; esac
[ "\${#runtime}" -eq 24 ] || fail
[ -x "$root/.mason/runtime/$runtime/node" ] || fail
if [ "$advisory" -eq 1 ]; then
  "$root/.mason/runtime/$runtime/node" "$root/.mason/run.cjs" "$@" || fail
else
  exec "$root/.mason/runtime/$runtime/node" "$root/.mason/run.cjs" "$@"
fi
`;

export const POWERSHELL_LAUNCHER = `# Managed by mason setup; no system Node installation is used.
$ErrorActionPreference = 'Stop'
$advisory = $args.Count -ge 3 -and $args[1] -eq 'auto' -and $args[2] -eq 'hook'
try {
  if ($args.Count -lt 2 -or $args[0] -notin @('codex','claude')) { throw 'Invalid Mason host.' }
  $runtime = (Get-Content -LiteralPath (Join-Path $PSScriptRoot ('runtime/' + $args[0] + '.txt')) -Raw).Trim()
  if ($runtime -cnotmatch '^[a-f0-9]{24}$') { throw 'Invalid Mason runtime pointer.' }
  & (Join-Path $PSScriptRoot ('runtime/' + $runtime + '/node.exe')) (Join-Path $PSScriptRoot 'run.cjs') @args
  if ($LASTEXITCODE -ne 0) { throw 'Mason runtime failed.' }
} catch {
  if ($advisory) { Write-Output '{"systemMessage":"Mason runtime unavailable. Rerun mason setup for this checkout; verification was not established."}'; exit 0 }
  [Console]::Error.WriteLine($_.Exception.Message); exit 2
}
`;

export const LAUNCHER = `// Managed by mason-auto setup. Rerun setup to install this checkout's pinned runtime.
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const launchArgs = process.argv.slice(process.argv[1] && path.resolve(process.argv[1]) === __filename ? 2 : 1);
(async () => {
  const root = path.dirname(__dirname);
  const args = launchArgs;
  const [host, command, ...rest] = args;
  if (!['codex','claude'].includes(host) || !['auto','mcp'].includes(command)) throw new Error('Invalid Mason launcher arguments.');
  const setup = JSON.parse(fs.readFileSync(path.join(__dirname, 'setup.json'), 'utf8'));
  const entry = setup.hosts?.[host];
  if (setup.version !== 1 || !entry || !/^[a-f0-9]{24}$/.test(entry.runtime?.id)) throw new Error('Mason is not configured for this host. Rerun mason-auto setup.');
  const base = path.join(__dirname, 'runtime', entry.runtime.id);
  if (entry.runtime.bundle) {
    const node = process.platform === 'win32' ? 'node.exe' : 'node';
    if (fs.realpathSync(process.execPath) !== fs.realpathSync(path.join(base, node))) throw new Error('Mason runtime pointer differs from the configured version. Rerun setup.');
  }
  const binary = entry.runtime.bundle ? path.join(base, 'app', 'dist', 'mason-' + command + '.js')
    : path.join(base, 'node_modules', 'mason-context', 'dist', 'mason-' + command + '.js');
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
