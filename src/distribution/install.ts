import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { verifyBundle } from "./bundle.js";
import { storePath, readStoreJson, writeStoreJson } from "../utils/storage.js";
import { withLock } from "../automation/store.js";
import { configurePath, removePath } from "./path.js";
import type { Progress } from "../utils/progress.js";
import { automaticUpdatesAllowed, currentInstallation, defaultHome, newerStableVersion, readInstallation, recordSchema, type InstallRecord } from "./state.js";
import { hasRunningMcp, registerMcp } from "./sessions.js";

export { defaultHome } from "./state.js";
const shQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const psQuote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
// Leave batch context before invoking PowerShell, as npm's cmd-shim does. A
// continuing batch can lose the child exit code or reopen its deleted launcher.
// https://github.com/npm/cmd-shim/blob/main/lib/index.js
export const WINDOWS_BATCH_LAUNCHER = '@echo off\r\ngoto #_mason_handoff_# 2>NUL || title %COMSPEC% & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0mason-launcher.ps1" %*\r\n';
const launcherNames = ["mason", "mason.cmd", "mason.ps1", "mason-launcher.ps1"];

async function replace(file: string, content: string, mode = 0o600) {
  const temp = file + ".tmp-" + randomUUID();
  try { await fs.writeFile(temp, content, { mode, flag: "wx" }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

/** User installation only. Project runtimes and host trust remain independent. */
export interface InstallOptions { stageOnly?: boolean; policyRevision?: string; preservePolicy?: boolean; rollback?: boolean }

export async function installStandalone(source: string, progress?: Progress, options: InstallOptions = {}) {
  progress?.step("Checking installation files and location");
  const bundle = await verifyBundle(source);
  const selectedHome = path.resolve(defaultHome());
  if (!options.stageOnly) await fs.mkdir(selectedHome, { recursive: true });
  const home = await fs.realpath(selectedHome);
  if (options.stageOnly) {
    assertUpdatePolicy(await readInstallation(home), bundle.manifest.version, options.policyRevision);
    const destination = await storePath(home, "versions/" + bundle.manifestHash.slice(0, 24));
    // Copying and starting the candidate must not hold the lock MCP startup needs.
    // The worker's update lock serializes downloads; recheck policy at publication.
    await copyBundle(home, source, destination, bundle);
    const { stdout } = await promisify(execFile)(path.join(destination, process.platform === "win32" ? "node.exe" : "node"),
      [path.join(destination, "app/dist/mason.js"), "--version"],
      { timeout: 30000, windowsHide: true, env: { ...process.env, MASON_NO_AUTO_UPDATE: "1" } });
    if (stdout.trim() !== bundle.manifest.version) throw new Error("Downloaded Mason failed its version health check.");
  }
  return withLock(home, ".install-lock", () => installLocked(home, source, bundle, progress, options));
}

function assertUpdatePolicy(record: InstallRecord | null, version: string, revision?: string) {
  if (!record || !automaticUpdatesAllowed(record, { ...process.env, MASON_VERSION: "" })
    || record.updates?.revision !== revision || !newerStableVersion(version, record.version)) {
    throw new Error("Update policy or installed version changed; download was not activated.");
  }
}

async function installLocked(home: string, source: string, bundle: Awaited<ReturnType<typeof verifyBundle>>, progress: Progress | undefined, options: InstallOptions, alreadyStaged = false) {
    const raw = await readStoreJson(home, "install.json");
    const previous = raw === null ? null : recordSchema.parse(raw);
    if (options.stageOnly) assertUpdatePolicy(previous, bundle.manifest.version, options.policyRevision);
    if (!previous) for (const file of await fs.readdir(home)) {
      if (file === ".install-lock") continue;
      // An interrupted preflight may leave an empty scaffold, never unowned content.
      const directory = path.join(home, file);
      const stat = await fs.lstat(directory);
      if (!["versions", "bin"].includes(file) || !stat.isDirectory() || (await fs.readdir(directory)).length) {
        throw new Error("Mason installation directory is not empty and has no ownership receipt.");
      }
    }
    const selectedBin = path.resolve(process.env.MASON_BIN_DIR ?? previous?.bin ?? (process.platform === "win32"
      ? path.join(home, "bin") : path.join(os.homedir(), ".local/bin")));
    await fs.mkdir(selectedBin, { recursive: true });
    const bin = await fs.realpath(selectedBin);
    if (previous && (previous.home !== home || previous.bin !== bin)) throw new Error("Installation paths differ from the existing Mason receipt.");
    const id = bundle.manifestHash.slice(0, 24);
    const destination = await storePath(home, "versions/" + id);
    if (options.stageOnly) {
      const receipt: InstallRecord = { ...previous!, pending: { id, version: bundle.manifest.version, policyRevision: options.policyRevision! } };
      await writeStoreJson(home, "install.json", receipt);
      return { home, bin, version: bundle.manifest.version, previousVersion: previous!.version, path: { message: "Update staged for a future MCP launch." } };
    }
    const launchers: Record<string, string> = process.platform === "win32" ? {
      "mason.cmd": WINDOWS_BATCH_LAUNCHER,
      "mason-launcher.ps1": `$ErrorActionPreference = 'Stop'
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
    // The 0.14.0 mason.ps1 shadows mason.cmd in PowerShell, where default script
    // policy can block it. Keep the helper under a different command name and
    // remove the old one only when its recorded ownership still matches.
    const retired = Object.entries({ ...previous?.previousLaunchers, ...previous?.launchers }).filter(([name]) => !(name in launchers));
    const checkRetired = async (name: string, expected: string) => {
      if (!launcherNames.includes(name)) throw new Error("Invalid owned launcher name.");
      const actual = await fs.readFile(await storePath(bin, name), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (actual !== null && actual !== expected) throw new Error("Retired launcher was edited; retained: " + name);
    };
    for (const [name, expected] of retired) await checkRetired(name, expected);
    progress?.step(`Installing Mason ${bundle.manifest.version}`);
    const updates = options.preservePolicy && previous?.updates ? { ...previous.updates } : {
      ...(previous?.updates ?? { enabled: !previous && !process.env.CI && process.env.MASON_NO_AUTO_UPDATE !== "1" }),
      revision: randomUUID(),
      pinnedVersion: process.env.MASON_VERSION?.replace(/^v/, "") || undefined,
      mirror: process.env.MASON_RELEASE_BASE || previous?.updates?.mirror,
    };
    if (options.rollback) { updates.pinnedVersion = bundle.manifest.version; updates.revision = randomUUID(); }
    const receipt: InstallRecord = { format: 1, home, bin, current: id, version: bundle.manifest.version, launchers,
      pathChanges: previous?.pathChanges ?? [], updates,
      previous: previous && previous.current !== id ? { id: previous.current, version: previous.version } : previous?.previous };
    // Claim only the preflighted installation, retaining old launchers for interrupted upgrades.
    await writeStoreJson(home, "install.json", previous
      ? { ...previous, previousLaunchers: launchers }
      : receipt);
    try {
      if (!alreadyStaged) await copyBundle(home, source, destination, bundle);
      for (const [name, content] of Object.entries(launchers)) await replace(await storePath(bin, name, true), content, 0o755);
      for (const [name, expected] of retired) { await checkRetired(name, expected); await fs.rm(await storePath(bin, name), { force: true }); }
      await writeStoreJson(home, "install.json", receipt);
    } catch (error) {
      // Preserve the working version when an unattended activation fails.
      if (previous) {
        for (const [name, content] of Object.entries(previous.launchers)) await replace(await storePath(bin, name, true), content, 0o755);
        await writeStoreJson(home, "install.json", previous);
      }
      throw error;
    }
    if (options.preservePolicy) return { home, bin, version: receipt.version, previousVersion: previous?.version, path: { message: "Installation selected." } };
    progress?.step("Checking terminal command availability");
    const pathResult = await configurePath(bin, receipt.pathChanges ?? [], async changes => {
      receipt.pathChanges = changes;
      await writeStoreJson(home, "install.json", receipt);
    });
    return { home, bin, version: bundle.manifest.version, previousVersion: previous?.version, path: pathResult };
}

async function copyBundle(home: string, source: string, destination: string, bundle: Awaited<ReturnType<typeof verifyBundle>>) {
  const exists = await fs.lstat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  if (exists) { await verifyBundle(destination, bundle.manifestHash); return; }
  const stage = await storePath(home, "versions/.install-" + randomUUID(), true);
  await fs.mkdir(stage);
  try {
    for (const file of ["bundle.json", ...Object.keys(bundle.manifest.files)]) {
      const from = await storePath(source, file), to = await storePath(stage, file, true);
      await fs.copyFile(from, to);
      await fs.chmod(to, (await fs.stat(from)).mode & 0o777);
    }
    await verifyBundle(stage, bundle.manifestHash);
    try { await fs.rename(stage, destination); }
    catch (error) {
      // A manual upgrade can finish the same immutable bundle while we stage it.
      try { await verifyBundle(destination, bundle.manifestHash); }
      catch { throw error; }
    }
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

/** Activation and lease registration share a lock, including concurrent host launches. */
export async function prepareStandaloneMcp(home: string) {
  const before = await readInstallation(home), candidate = before.pending;
  let verified: Awaited<ReturnType<typeof verifyBundle>> | undefined, verificationError: unknown;
  if (candidate && automaticUpdatesAllowed(before) && !await hasRunningMcp(home)) {
    try {
      verified = await verifyBundle(await storePath(home, "versions/" + candidate.id));
      if (verified.manifestHash.slice(0, 24) !== candidate.id || verified.manifest.version !== candidate.version) throw new Error("Staged update changed.");
    } catch (error) { verificationError = error; }
  }
  return withLock(home, ".install-lock", async () => {
    let record = await readInstallation(home);
    const pending = record.pending;
    if (pending && candidate?.id === pending.id && (verified || verificationError) && automaticUpdatesAllowed(record) && pending.policyRevision === record.updates?.revision
      && newerStableVersion(pending.version, record.version) && !await hasRunningMcp(home)) {
      try {
        if (verificationError) throw verificationError;
        const source = await storePath(home, "versions/" + pending.id);
        await installLocked(home, source, verified!, undefined, { preservePolicy: true }, true);
        record = await readInstallation(home);
      } catch (error) {
        // A bad staged version must not repeatedly delay host startup.
        record = await readInstallation(home);
        delete record.pending;
        await writeStoreJson(home, "install.json", record);
        await writeStoreJson(home, "update-status.json", { lastAttempt: Date.now(), error: String(error) });
      }
    }
    const release = await registerMcp(home);
    return { bundle: await storePath(home, "versions/" + record.current), release };
  });
}

export async function rollbackStandalone() {
  const { home } = await currentInstallation();
  return withLock(home, ".install-lock", async () => {
    const record = await readInstallation(home);
    if (!record.previous) throw new Error("No previous installation is available.");
    if (await hasRunningMcp(home)) throw new Error("Close running Mason MCP sessions before rolling back.");
    const source = await storePath(home, "versions/" + record.previous.id);
    const bundle = await verifyBundle(source);
    if (bundle.manifestHash.slice(0, 24) !== record.previous.id || bundle.manifest.version !== record.previous.version) throw new Error("Previous installation changed.");
    return installLocked(home, source, bundle, undefined, { preservePolicy: true, rollback: true });
  });
}

export async function upgradeStandalone(version?: string, progress?: Progress) {
  if (version && !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Expected a release version such as 0.14.0.");
  progress?.step("Checking current installation");
  const { home, bundle, record } = await currentInstallation();
  await verifyBundle(bundle);
  const windows = process.platform === "win32";
  const script = path.join(bundle, windows ? "install.ps1" : "install.sh");
  // The installer owns progress from here; do not animate over its inherited IO.
  progress?.stop();
  return new Promise<number>((resolve, reject) => {
    const child = spawn(windows ? "powershell.exe" : "sh", windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] : [script],
      { stdio: "inherit", windowsHide: true, env: { ...process.env, MASON_HOME: home, MASON_BIN_DIR: record.bin,
        MASON_RELEASE_BASE: process.env.MASON_RELEASE_BASE || record.updates?.mirror || "", MASON_VERSION: version ?? "",
        MASON_UPDATE_POLICY_REVISION: "", MASON_EXPECTED_SHA256: "" } });
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
      if (!launcherNames.includes(name)) throw new Error("Invalid owned launcher name.");
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
