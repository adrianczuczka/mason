import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withLock } from "../automation/store.js";
import { readStoreJson, storePath, writeStoreJson } from "../utils/storage.js";
import { standaloneLocation, automaticUpdatesAllowed, currentInstallation, newerStableVersion, readInstallation, type InstallRecord } from "./state.js";
import { verifyBundle } from "./bundle.js";
import { pruneUnusedVersions } from "./runtime.js";
import { prepareStandaloneMcp } from "./install.js";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RELEASE_AGE_MS = 24 * 60 * 60 * 1000;
const releaseBase = "https://github.com/adrianczuczka/mason/releases";
const releaseListSchema = z.array(z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(), published_at: z.string().nullable() }));
export const updateManifestSchema = z.object({
  format: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+$/), publishedAt: z.string().datetime(),
  assets: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();
const statusSchema = z.object({ lastAttempt: z.number(), availableVersion: z.string().optional(), error: z.string().optional() });

async function boundedDownload(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Update metadata request failed (HTTP ${response.status}).`);
  if (Number(response.headers.get("content-length")) > 1024 * 1024) throw new Error("Update metadata is too large.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error("Update metadata is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

/** Bind both the release contents and exact tag workflow identity before using a download hash. */
export async function fetchVerifiedRelease(home: string, now = Date.now()) {
  // Select the newest eligible release, not just /latest: daily releases must
  // not keep every automatic update perpetually inside the waiting period.
  const releases = releaseListSchema.parse(JSON.parse((await boundedDownload("https://api.github.com/repos/adrianczuczka/mason/releases?per_page=30")).toString("utf8")));
  const installed = (await readInstallation(home)).version;
  let selected: string | undefined;
  for (const release of releases) {
    const version = release.tag_name.replace(/^v/, "");
    if (release.tag_name !== "v" + version || release.draft || release.prerelease || !release.published_at
      || !(now - Date.parse(release.published_at) >= RELEASE_AGE_MS) || !newerStableVersion(version, installed)) continue;
    if (!selected || newerStableVersion(version, selected)) selected = version;
  }
  if (!selected) return null;
  const bytes = await boundedDownload(`${releaseBase}/download/v${selected}/update.json`);
  const manifest = updateManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.version !== selected) throw new Error("Signed manifest does not match the selected release.");
  const signature = JSON.parse((await boundedDownload(`${releaseBase}/download/v${manifest.version}/update.sigstore.json`)).toString("utf8"));
  // DSSE verifies its embedded payload, ignoring an external artifact argument.
  // Accept only detached message signatures that bind these exact manifest bytes.
  if (!signature?.messageSignature || signature.dsseEnvelope) throw new Error("Update metadata requires a detached message signature.");
  const { verify } = await import("sigstore");
  await verify(signature, bytes, {
    certificateIdentityURI: `https://github.com/adrianczuczka/mason/.github/workflows/publish.yml@refs/tags/v${manifest.version}`,
    certificateIssuer: "https://token.actions.githubusercontent.com",
    tufCachePath: await storePath(home, "sigstore-cache"), timeout: 10000, retry: 0,
    ctLogThreshold: 1, tlogThreshold: 1,
  });
  return manifest;
}

async function runInstaller(home: string, version: string, digest: string, revision: string) {
  const record = await readInstallation(home);
  const bundle = await storePath(home, "versions/" + record.current);
  await verifyBundle(bundle);
  const windows = process.platform === "win32", script = path.join(bundle, windows ? "install.ps1" : "install.sh");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(windows ? "powershell.exe" : "sh", windows
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] : [script], {
      cwd: home, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], timeout: 10 * 60 * 1000,
      env: { ...process.env, MASON_HOME: home, MASON_BIN_DIR: record.bin, MASON_VERSION: version,
        MASON_RELEASE_BASE: "", MASON_EXPECTED_SHA256: digest, MASON_UPDATE_POLICY_REVISION: revision },
    });
    let diagnostic = "";
    child.stderr!.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-4000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`Update download failed (${code}): ${diagnostic.trim()}`)));
  });
}

/** Separate worker: no inherited MCP/hook streams, one attempt per installation per day. */
export async function runAutomaticUpdate(home: string, dependencies = { fetchRelease: fetchVerifiedRelease, install: runInstaller }, now = Date.now()) {
  await withLock(home, ".update-lock", async () => {
    const record = await readInstallation(home);
    if (!automaticUpdatesAllowed(record)) return;
    const old = statusSchema.safeParse(await readStoreJson(home, "update-status.json"));
    if (old.success && now - old.data.lastAttempt < CHECK_INTERVAL_MS && old.data.lastAttempt <= now) return;
    const status: z.infer<typeof statusSchema> = { lastAttempt: now };
    await writeStoreJson(home, "update-status.json", status);
    try {
      await pruneUnusedVersions(home).catch(() => {});
      const release = await dependencies.fetchRelease(home);
      if (!release) return;
      status.availableVersion = release.version;
      const age = now - Date.parse(release.publishedAt);
      if (age >= RELEASE_AGE_MS && newerStableVersion(release.version, record.version)
        && (!record.pending || newerStableVersion(release.version, record.pending.version))) {
        const asset = `mason-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
        const digest = release.assets[asset];
        if (!digest) throw new Error("Signed release has no archive for this platform.");
        // Users may disable, pin, manually upgrade, or uninstall while network requests run.
        const fresh = await readInstallation(home);
        if (automaticUpdatesAllowed(fresh) && fresh.updates?.revision === record.updates!.revision
          && newerStableVersion(release.version, fresh.version)) {
          await dependencies.install(home, release.version, digest, record.updates!.revision);
        }
      }
    } catch (error) { status.error = error instanceof Error ? error.message : String(error); }
    // Do not recreate an installation removed while the worker was downloading.
    if (await fs.access(path.join(home, "install.json")).then(() => true, () => false)) await writeStoreJson(home, "update-status.json", status);
  }, 0);
}

export async function scheduleAutomaticUpdate(): Promise<void> {
  try {
    const { home, record } = await currentInstallation();
    if (!automaticUpdatesAllowed(record)) return;
    const status = statusSchema.safeParse(await readStoreJson(home, "update-status.json"));
    const now = Date.now();
    if (status.success && status.data.lastAttempt <= now && now - status.data.lastAttempt < CHECK_INTERVAL_MS) return;
    const bundle = await storePath(home, "versions/" + record.current);
    const child = spawn(path.join(bundle, process.platform === "win32" ? "node.exe" : "node"),
      [path.join(bundle, "app/dist/mason.js"), "internal-update"],
      { cwd: home, env: process.env, stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* npm, offline, read-only, or damaged installations must still run. */ }
}

export async function updateSettings(home: string, action: "enable" | "disable" | "pin" | "unpin") {
  return withLock(home, ".install-lock", async () => {
    const record = await readInstallation(home);
    const updates: NonNullable<InstallRecord["updates"]> = { ...(record.updates ?? { enabled: false }), revision: randomUUID() };
    if (action === "enable") updates.enabled = true;
    if (action === "disable") updates.enabled = false;
    if (action === "pin") updates.pinnedVersion = record.version;
    if (action === "unpin") delete updates.pinnedVersion;
    record.updates = updates;
    delete record.pending;
    await writeStoreJson(home, "install.json", record);
    return record;
  });
}

export async function updateStatus(home: string) {
  const record = await readInstallation(home);
  const lastCheck = statusSchema.parse(await readStoreJson(home, "update-status.json") ?? { lastAttempt: 0 });
  return { version: record.version, enabled: record.updates?.enabled ?? false,
    effective: automaticUpdatesAllowed(record), pinnedVersion: record.updates?.pinnedVersion ?? null,
    mirror: record.updates?.mirror ?? null, pendingVersion: record.pending?.version ?? null,
    lastCheck: lastCheck.lastAttempt ? lastCheck : null };
}

/** The MCP process holds a lease for its lifetime; pending versions activate before the first new server. */
export async function startMcpWithUpdates(start: (onClose?: () => void) => Promise<void>) {
  const current = standaloneLocation();
  if (!current) { await start(); return; }
  // A standalone server must never run without a lease: another process could
  // otherwise treat it as idle and activate an update underneath that server.
  const session = await prepareStandaloneMcp(current.home);
  if (session.bundle !== current.bundle) {
    const child = spawn(path.join(session.bundle, process.platform === "win32" ? "node.exe" : "node"),
      [path.join(session.bundle, "app/dist/mason-mcp.js"), ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
    const interrupt = () => { child.kill("SIGINT"); }, terminate = () => { child.kill("SIGTERM"); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject); child.on("exit", code => resolve(code ?? 1));
      });
    } finally {
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
      await session.release();
    }
    return;
  }
  const timer = setInterval(() => { void scheduleAutomaticUpdate(); }, 60 * 60 * 1000);
  timer.unref();
  const stop = () => { clearInterval(timer); void session?.release(); };
  try { await start(stop); void scheduleAutomaticUpdate(); }
  catch (error) { stop(); throw error; }
}
