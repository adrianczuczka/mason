import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyBundle } from "./bundle.js";
import { storePath, readStoreJson, writeStoreJson } from "../utils/storage.js";
import { withLock } from "../automation/store.js";
import { configurePath, removePath, pathChangeSchema } from "./path.js";

const recordSchema = z.object({ format: z.literal(1), home: z.string(), bin: z.string(),
  current: z.string().regex(/^[a-f0-9]{24}$/), version: z.string(), launchers: z.record(z.string()), previousLaunchers: z.record(z.string()).optional(),
  pathChanges: z.array(pathChangeSchema).optional() });
const shQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const psQuote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
// Leave batch context before invoking PowerShell, as npm's cmd-shim does. A
// continuing batch can lose the child exit code or reopen its deleted launcher.
// https://github.com/npm/cmd-shim/blob/main/lib/index.js
export const WINDOWS_BATCH_LAUNCHER = '@echo off\r\ngoto #_mason_handoff_# 2>NUL || title %COMSPEC% & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0mason.ps1" %*\r\n';
export const defaultHome = () => process.env.MASON_HOME ?? (process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Mason") : path.join(os.homedir(), ".local/share/mason"));

async function replace(file: string, content: string, mode = 0o600) {
  const temp = file + ".tmp-" + randomUUID();
  try { await fs.writeFile(temp, content, { mode, flag: "wx" }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

/** User installation only. Project runtimes and host trust remain independent. */
export async function installStandalone(source: string) {
  const bundle = await verifyBundle(source);
  const selectedHome = path.resolve(defaultHome());
  await fs.mkdir(selectedHome, { recursive: true });
  const home = await fs.realpath(selectedHome);
  const selectedBin = path.resolve(process.env.MASON_BIN_DIR ?? (process.platform === "win32" ? path.join(home, "bin") : path.join(os.homedir(), ".local/bin")));
  return withLock(home, ".install-lock", async () => {
    const raw = await readStoreJson(home, "install.json");
    const previous = raw === null ? null : recordSchema.parse(raw);
    if (!previous) for (const file of await fs.readdir(home)) {
      if (file === ".install-lock") continue;
      // An interrupted preflight may leave an empty scaffold, never unowned content.
      const directory = path.join(home, file);
      const stat = await fs.lstat(directory);
      if (!["versions", "bin"].includes(file) || !stat.isDirectory() || (await fs.readdir(directory)).length) {
        throw new Error("Mason installation directory is not empty and has no ownership receipt.");
      }
    }
    await fs.mkdir(selectedBin, { recursive: true });
    const bin = await fs.realpath(selectedBin);
    if (previous && (previous.home !== home || previous.bin !== bin)) throw new Error("Installation paths differ from the existing Mason receipt.");
    const id = bundle.manifestHash.slice(0, 24);
    const destination = await storePath(home, "versions/" + id);
    const launchers: Record<string, string> = process.platform === "win32" ? {
      "mason.cmd": WINDOWS_BATCH_LAUNCHER,
      "mason.ps1": `$ErrorActionPreference = 'Stop'
$previousToken = $env:MASON_UNINSTALL_TOKEN
$token = [Guid]::NewGuid().ToString()
$env:MASON_UNINSTALL_TOKEN = $token
try {
  & ${psQuote(path.join(destination, "node.exe"))} ${psQuote(path.join(destination, "app/dist/mason.js"))} @args
  $code = $LASTEXITCODE
  if ($code -eq 0 -and $args.Count -eq 1 -and $args[0] -eq 'uninstall') {
    if ([IO.File]::ReadAllText(${psQuote(path.join(home, ".uninstall-request.txt"))}) -cne $token) { throw 'Mason did not authorize installation cleanup.' }
    Remove-Item -LiteralPath ${psQuote(home)} -Recurse -Force
    Write-Output ${psQuote("Removed standalone installation: " + home)}
  }
  exit $code
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }
finally { $env:MASON_UNINSTALL_TOKEN = $previousToken }
`,
    } : { mason: `#!/bin/sh\nexec ${shQuote(path.join(destination, "node"))} ${shQuote(path.join(destination, "app/dist/mason.js"))} "$@"\n` };
    for (const [name, content] of Object.entries(launchers)) {
      const file = await storePath(bin, name);
      const old = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (old !== null && old !== previous?.launchers[name] && old !== previous?.previousLaunchers?.[name] && old !== content) throw new Error("Refusing to replace an unrelated or edited launcher: " + file);
    }
    const receipt = { format: 1, home, bin, current: id, version: bundle.manifest.version, launchers, pathChanges: previous?.pathChanges ?? [] };
    // Claim only the preflighted installation, retaining old launchers for interrupted upgrades.
    await writeStoreJson(home, "install.json", { ...receipt, previousLaunchers: previous?.previousLaunchers ?? previous?.launchers });
    const stage = await storePath(home, "versions/.install-" + randomUUID(), true);
    await fs.mkdir(stage);
    try {
      for (const file of ["bundle.json", ...Object.keys(bundle.manifest.files)]) {
        const from = await storePath(source, file), to = await storePath(stage, file, true);
        await fs.copyFile(from, to);
        await fs.chmod(to, (await fs.stat(from)).mode & 0o777);
      }
      await verifyBundle(stage, bundle.manifestHash);
      const exists = await fs.lstat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
      if (exists) await verifyBundle(destination, bundle.manifestHash);
      else await fs.rename(stage, destination);
      for (const [name, content] of Object.entries(launchers)) await replace(await storePath(bin, name, true), content, 0o755);
      await writeStoreJson(home, "install.json", receipt);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    const pathResult = await configurePath(bin, receipt.pathChanges, async changes => {
      receipt.pathChanges = changes;
      await writeStoreJson(home, "install.json", receipt);
    });
    return { home, bin, version: bundle.manifest.version, path: pathResult };
  });
}

async function currentInstallation() {
  // In the built distribution this code is bundled into app/dist/mason.js.
  const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const bundle = path.dirname(app), home = path.dirname(path.dirname(bundle));
  const raw = await readStoreJson(home, "install.json");
  if (!raw) throw new Error("Run this command from a standalone installation. npm users can upgrade with npm.");
  const record = recordSchema.parse(raw);
  if (record.home !== await fs.realpath(home) || path.dirname(bundle) !== path.join(home, "versions")) throw new Error("Invalid standalone installation receipt.");
  return { home, bundle, record };
}

export async function upgradeStandalone(version?: string) {
  if (version && !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Expected a release version such as 0.14.0.");
  const { home, bundle, record } = await currentInstallation();
  await verifyBundle(bundle);
  const windows = process.platform === "win32";
  const script = path.join(bundle, windows ? "install.ps1" : "install.sh");
  return new Promise<number>((resolve, reject) => {
    const child = spawn(windows ? "powershell.exe" : "sh", windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] : [script],
      { stdio: "inherit", windowsHide: true, env: { ...process.env, MASON_HOME: home, MASON_BIN_DIR: record.bin, MASON_VERSION: version ?? "" } });
    child.on("error", reject); child.on("exit", code => resolve(code ?? 2));
  });
}

export async function uninstallStandalone() {
  const { home, record } = await currentInstallation();
  const token = process.env.MASON_UNINSTALL_TOKEN;
  if (process.platform === "win32" && (!token || !/^[a-f0-9-]{36}$/i.test(token))) {
    throw new Error("Run mason uninstall through the installed Windows launcher so it can remove Node after exit.");
  }
  await withLock(home, ".install-lock", async () => {
    for (const [name, expected] of Object.entries(record.launchers)) {
      if (!["mason", "mason.cmd", "mason.ps1"].includes(name)) throw new Error("Invalid owned launcher name.");
      const file = await storePath(record.bin, name);
      const actual = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (actual !== null && actual !== expected) throw new Error("Launcher was edited; retained: " + file);
    }
    for (const warning of await removePath(record.pathChanges ?? [])) console.error(warning);
    if (process.platform === "win32") await replace(await storePath(home, ".uninstall-request.txt", true), token!);
    for (const name of Object.keys(record.launchers)) await fs.rm(await storePath(record.bin, name), { force: true });
  });
  // The Windows launcher supervises Node and removes its locked executable only
  // after this process exits. Its exit status includes cleanup failures. Detached
  // PowerShell did not start reliably: https://github.com/nodejs/node/issues/51018
  if (process.platform !== "win32") await fs.rm(home, { recursive: true, force: true });
  return home;
}
