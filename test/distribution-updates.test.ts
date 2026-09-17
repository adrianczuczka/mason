import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as state from "../src/distribution/state.js";
import { pruneUnusedVersions } from "../src/distribution/runtime.js";
import { sha256 } from "../src/distribution/bundle.js";
import { installStandalone, prepareStandaloneMcp } from "../src/distribution/install.js";
import { automaticUpdatesAllowed, newerStableVersion, readInstallation } from "../src/distribution/state.js";
import { CHECK_INTERVAL_MS, RELEASE_AGE_MS, fetchVerifiedRelease, runAutomaticUpdate, updateSettings, updateStatus, startMcpWithUpdates } from "../src/distribution/updates.js";
import { writeStoreJson } from "../src/utils/storage.js";

vi.mock("sigstore", () => ({ verify: vi.fn(async () => {}) }));
let root: string, source: string, home: string, bin: string;
const asset = `mason-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
const now = Date.parse("2026-09-17T00:00:00Z");
const releaseList = () => new Response(JSON.stringify([
  { tag_name: "v1.2.0", draft: false, prerelease: false, published_at: new Date(now).toISOString() },
  { tag_name: "v1.1.0", draft: false, prerelease: false, published_at: new Date(now - 2 * RELEASE_AGE_MS).toISOString() },
]));
async function fixture(version: string, healthy = true) {
  await fs.mkdir(path.join(source, "app/dist"), { recursive: true });
  const runtime = process.platform === "win32" ? "node.exe" : "node";
  if (process.platform === "win32") await fs.copyFile(process.execPath, path.join(source, runtime));
  else await fs.writeFile(path.join(source, runtime), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  const texts = {
    "app/package.json": JSON.stringify({ name: "mason-context", version, type: "module" }),
    "app/dist/mason.js": healthy ? `console.log(${JSON.stringify(version)});` : "process.exit(2);",
    "app/dist/mason-runtime.js": "// runtime leases",
    "app/dist/mason-auto.js": "// automation", "app/dist/mason-mcp.js": "// MCP",
  };
  const files: Record<string, string> = { [runtime]: sha256(await fs.readFile(path.join(source, runtime))) };
  for (const [file, content] of Object.entries(texts)) { await fs.writeFile(path.join(source, file), content); files[file] = sha256(content); }
  await fs.writeFile(path.join(source, "bundle.json"), JSON.stringify({ format: 1, version, target: `${process.platform}-${process.arch}`, nodeVersion: "24.20.0", files }));
}
async function stage(version = "1.1.0", healthy = true) {
  const { updates } = await readInstallation(home);
  await fixture(version, healthy);
  return installStandalone(source, undefined, { stageOnly: true, policyRevision: updates!.revision });
}
function services(version = "1.1.0", publishedAt = new Date(now - RELEASE_AGE_MS).toISOString()) {
  return { fetchRelease: vi.fn(async () => ({ format: 1 as const, version, publishedAt, assets: { [asset]: "a".repeat(64) } })), install: vi.fn(async () => {}) };
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-updates-")));
  source = path.join(root, "source"); home = path.join(root, "home"); bin = path.join(root, "bin");
  for (const key of ["CI", "MASON_VERSION", "MASON_RELEASE_BASE", "MASON_NO_AUTO_UPDATE"]) vi.stubEnv(key, "");
  vi.stubEnv("MASON_HOME", home); vi.stubEnv("MASON_BIN_DIR", bin); vi.stubEnv("MASON_NO_MODIFY_PATH", "1");
  await fixture("1.0.0");
  await installStandalone(source);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("automatic update policy", () => {
  it("enables new public installs and keeps pre-updater installations opted out", async () => {
    expect((await updateStatus(home)).effective).toBe(true);
    const record = await readInstallation(home); delete record.updates;
    await writeStoreJson(home, "install.json", record);
    await fixture("1.1.0"); await installStandalone(source);
    expect((await updateStatus(home)).enabled).toBe(false);
    await updateSettings(home, "enable");
    expect((await updateStatus(home)).effective).toBe(true);
  });
  it.each(["CI", "MASON_NO_AUTO_UPDATE", "MASON_VERSION", "MASON_RELEASE_BASE"])("does no work with %s set", async key => {
    vi.stubEnv(key, "1");
    const dependencies = services();
    await runAutomaticUpdate(home, dependencies, now);
    expect(dependencies.fetchRelease).not.toHaveBeenCalled();
    expect(automaticUpdatesAllowed(await readInstallation(home))).toBe(false);
  });
  it("persists a mirror and a version pin after the installer environment disappears", async () => {
    vi.stubEnv("MASON_VERSION", "v1.0.0"); vi.stubEnv("MASON_RELEASE_BASE", "https://company.invalid/releases");
    await installStandalone(source);
    vi.stubEnv("MASON_VERSION", ""); vi.stubEnv("MASON_RELEASE_BASE", "");
    expect(await updateStatus(home)).toMatchObject({ pinnedVersion: "1.0.0", mirror: "https://company.invalid/releases", effective: false });
    await updateSettings(home, "unpin"); await updateSettings(home, "enable");
    expect((await updateStatus(home)).effective).toBe(false);
  });
  it("pinning or disabling discards a downloaded update", async () => {
    await stage(); await updateSettings(home, "pin");
    expect(await updateStatus(home)).toMatchObject({ pendingVersion: null, pinnedVersion: "1.0.0", effective: false });
    await updateSettings(home, "unpin"); await stage(); await updateSettings(home, "disable");
    expect(await updateStatus(home)).toMatchObject({ pendingVersion: null, effective: false });
  });
  it.each([
    ["1.0.1", "1.0.0", true], ["1.10.0", "1.9.0", true], ["2.0.0", "10.0.0", false],
    ["1.0.0", "1.0.0", false], ["1.0.0-beta.1", "0.9.0", false], ["1.0.0", "1.0.0-beta.1", true],
  ])("compares %s against %s without downgrading or accepting prereleases", (candidate, current, expected) => {
    expect(newerStableVersion(candidate, current)).toBe(expected);
  });
});

describe("background checking", () => {
  it("checks once per day, including failed checks", async () => {
    const dependencies = services(); dependencies.fetchRelease.mockRejectedValue(new Error("offline"));
    await runAutomaticUpdate(home, dependencies, now);
    await runAutomaticUpdate(home, dependencies, now + 1);
    expect(dependencies.fetchRelease).toHaveBeenCalledTimes(1);
    expect((await updateStatus(home)).lastCheck).toMatchObject({ error: "offline" });
    await runAutomaticUpdate(home, dependencies, now + CHECK_INTERVAL_MS);
    expect(dependencies.fetchRelease).toHaveBeenCalledTimes(2);
  });
  it("serializes concurrent checks", async () => {
    const dependencies = services();
    await Promise.allSettled([runAutomaticUpdate(home, dependencies, now), runAutomaticUpdate(home, dependencies, now)]);
    expect(dependencies.fetchRelease).toHaveBeenCalledTimes(1);
    expect(dependencies.install).toHaveBeenCalledTimes(1);
  });
  it.each(["1.0.0", "0.9.0", "1.1.0-beta.1"])("does not install %s", async version => {
    const dependencies = services(version); await runAutomaticUpdate(home, dependencies, now);
    expect(dependencies.install).not.toHaveBeenCalled();
  });
  it("waits for a release to be at least a day old", async () => {
    const dependencies = services("1.1.0", new Date(now).toISOString());
    await runAutomaticUpdate(home, dependencies, now);
    expect(dependencies.install).not.toHaveBeenCalled();
    await runAutomaticUpdate(home, dependencies, now + CHECK_INTERVAL_MS);
    expect(dependencies.install).toHaveBeenCalledTimes(1);
  });
  it("does not redownload a version already staged", async () => {
    await stage(); const dependencies = services();
    await runAutomaticUpdate(home, dependencies, now);
    expect(dependencies.install).not.toHaveBeenCalled();
  });
  it("honors disabling while a request is in flight", async () => {
    const dependencies = services(), release = await dependencies.fetchRelease();
    dependencies.fetchRelease.mockImplementation(async () => { await updateSettings(home, "disable"); return release; });
    await runAutomaticUpdate(home, dependencies, now);
    expect(dependencies.install).not.toHaveBeenCalled();
  });
  it("records download failures without changing the active version", async () => {
    const dependencies = services(); dependencies.install.mockRejectedValue(new Error("checksum mismatch"));
    await runAutomaticUpdate(home, dependencies, now);
    expect(await updateStatus(home)).toMatchObject({ version: "1.0.0", pendingVersion: null, lastCheck: { error: "checksum mismatch" } });
  });
});

describe("staging and activation", () => {
  it("keeps the launcher unchanged until every running MCP server exits", async () => {
    const before = await readInstallation(home);
    const first = await prepareStandaloneMcp(home);
    await stage();
    const second = await prepareStandaloneMcp(home);
    expect(second.bundle).toBe(first.bundle);
    expect((await readInstallation(home)).launchers).toEqual(before.launchers);
    await first.release(); await second.release();
    const next = await prepareStandaloneMcp(home);
    expect(next.bundle).not.toBe(first.bundle);
    expect(await readInstallation(home)).toMatchObject({ version: "1.1.0", previous: { id: before.current, version: "1.0.0" } });
    expect((await readInstallation(home)).pending).toBeUndefined();
    await next.release();
  });
  it("selects one version for concurrent MCP startups", async () => {
    await stage();
    const [a, b] = await Promise.all([prepareStandaloneMcp(home), prepareStandaloneMcp(home)]);
    expect(a.bundle).toBe(b.bundle);
    expect((await readInstallation(home)).version).toBe("1.1.0");
    await a.release(); await b.release();
  });
  it("allows MCP startup while a candidate is being copied", async () => {
    let copied!: () => void, resume!: () => void;
    const reached = new Promise<void>(resolve => { copied = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const copy = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, flags) => {
      if (String(from).endsWith(path.join("app", "dist", "mason.js"))) { copied(); await paused; }
      return copy(from, to, flags);
    });
    const staging = stage();
    let session: Awaited<ReturnType<typeof prepareStandaloneMcp>> | undefined;
    try {
      await reached;
      session = await prepareStandaloneMcp(home);
      expect((await readInstallation(home)).version).toBe("1.0.0");
    } finally { resume(); await staging; await session?.release(); }
  });
  it("rejects an unhealthy download before recording it as pending", async () => {
    await expect(stage("1.1.0", false)).rejects.toThrow();
    expect(await updateStatus(home)).toMatchObject({ version: "1.0.0", pendingVersion: null });
  });
  it("abandons an update whose files changed after staging", async () => {
    await stage(); const record = await readInstallation(home);
    await fs.writeFile(path.join(home, "versions", record.pending!.id, "app/dist/mason.js"), "changed");
    const next = await prepareStandaloneMcp(home);
    expect(await updateStatus(home)).toMatchObject({ version: "1.0.0", pendingVersion: null });
    expect((await updateStatus(home)).lastCheck).toMatchObject({ error: expect.stringContaining("checksum") });
    await next.release();
  });
  it("retains edited launchers and continues using the working bundle", async () => {
    await stage(); const record = await readInstallation(home);
    const launcher = path.join(bin, Object.keys(record.launchers)[0]);
    await fs.writeFile(launcher, "user edited launcher");
    const next = await prepareStandaloneMcp(home);
    expect((await readInstallation(home)).version).toBe("1.0.0");
    expect(await fs.readFile(launcher, "utf8")).toBe("user edited launcher");
    await next.release();
  });
  it("does not activate when session ownership cannot be established", async () => {
    await stage();
    await writeStoreJson(home, "sessions/abcd.json", { pid: 1, host: "another-machine" });
    const next = await prepareStandaloneMcp(home);
    expect((await readInstallation(home)).version).toBe("1.0.0");
    await next.release();
  });
  it("rejects a download completed after its policy was changed", async () => {
    const old = await readInstallation(home);
    await updateSettings(home, "disable"); await updateSettings(home, "enable"); await fixture("1.1.0");
    await expect(installStandalone(source, undefined, { stageOnly: true, policyRevision: old.updates!.revision })).rejects.toThrow("policy");
    expect((await updateStatus(home)).pendingVersion).toBeNull();
  });
});

describe("signed release verification", () => {
  it("verifies the exact manifest bytes against the tag's publishing identity", async () => {
    const manifest = JSON.stringify(await services().fetchRelease());
    const fetcher = vi.fn().mockResolvedValueOnce(releaseList()).mockResolvedValueOnce(new Response(manifest)).mockResolvedValueOnce(new Response('{"messageSignature":{"signature":"test"}}'));
    vi.stubGlobal("fetch", fetcher);
    await fetchVerifiedRelease(home, now);
    const { verify } = await import("sigstore");
    expect(verify).toHaveBeenCalledWith({ messageSignature: { signature: "test" } }, Buffer.from(manifest), expect.objectContaining({
      certificateIdentityURI: "https://github.com/adrianczuczka/mason/.github/workflows/publish.yml@refs/tags/v1.1.0",
      certificateIssuer: "https://token.actions.githubusercontent.com", ctLogThreshold: 1, tlogThreshold: 1,
    }));
    expect(fetcher.mock.calls[1][0]).toContain("/download/v1.1.0/update.json");
    expect(fetcher.mock.calls[2][0]).toContain("/download/v1.1.0/update.sigstore.json");
  });
  it("never falls back to unsigned checksums after verification fails", async () => {
    const { verify } = await import("sigstore");
    vi.mocked(verify).mockRejectedValueOnce(new Error("untrusted identity"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(releaseList()).mockResolvedValueOnce(new Response(JSON.stringify(await services().fetchRelease())))
      .mockResolvedValueOnce(new Response('{"messageSignature":{"signature":"test"}}')));
    const install = vi.fn();
    await runAutomaticUpdate(home, { fetchRelease: h => fetchVerifiedRelease(h, now), install }, now);
    expect(install).not.toHaveBeenCalled();
    expect((await updateStatus(home)).lastCheck).toMatchObject({ error: "untrusted identity" });
  });
  it("rejects missing signatures and oversized metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(releaseList()).mockResolvedValueOnce(new Response(JSON.stringify(await services().fetchRelease())))
      .mockResolvedValueOnce(new Response('', { status: 404 })));
    await expect(fetchVerifiedRelease(home, now)).rejects.toThrow("404");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("a".repeat(1024 * 1024 + 1))));
    await expect(fetchVerifiedRelease(home)).rejects.toThrow("too large");
  });
  it("rejects a valid-looking DSSE envelope whose signed payload could differ from the manifest", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(releaseList()).mockResolvedValueOnce(new Response(JSON.stringify(await services().fetchRelease())))
      .mockResolvedValueOnce(new Response('{"dsseEnvelope":{"payload":"unrelated signed payload"}}')));
    await expect(fetchVerifiedRelease(home, now)).rejects.toThrow("detached message signature");
    const { verify } = await import("sigstore");
    expect(verify).not.toHaveBeenCalled();
  });
  it("makes no artifact requests when already on the newest eligible release", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { tag_name: "v1.0.0", draft: false, prerelease: false, published_at: new Date(now - 2 * RELEASE_AGE_MS).toISOString() },
      { tag_name: "v9.0.0-beta", draft: false, prerelease: true, published_at: new Date(now - 2 * RELEASE_AGE_MS).toISOString() },
    ])));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchVerifiedRelease(home, now)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});


describe("standalone runtime safety", () => {
  it("does not start an untracked MCP server when lease storage fails", async () => {
    const record = await readInstallation(home);
    vi.spyOn(state, "standaloneLocation").mockReturnValue({ home, bundle: path.join(home, "versions", record.current) });
    await fs.writeFile(path.join(home, "sessions"), "blocked");
    const start = vi.fn();
    await expect(startMcpWithUpdates(start)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });
  it("starts npm MCP without standalone bookkeeping", async () => {
    vi.spyOn(state, "standaloneLocation").mockReturnValue(null);
    const start = vi.fn(async () => {});
    await startMcpWithUpdates(start);
    expect(start).toHaveBeenCalledOnce();
  });
  it("retains current, rollback, staged and live runtimes, then reclaims exited versions", async () => {
    const oldest = (await readInstallation(home)).current;
    await fixture("1.1.0"); await installStandalone(source);
    await fixture("1.2.0"); await installStandalone(source);
    await stage("1.3.0");
    const record = await readInstallation(home);
    await writeStoreJson(home, "runtimes/abc.json", { pid: process.pid, host: os.hostname(), bundle: oldest });
    await pruneUnusedVersions(home);
    expect((await fs.readdir(path.join(home, "versions"))).sort()).toEqual([oldest, record.current, record.previous!.id, record.pending!.id].sort());
    await fs.rm(path.join(home, "runtimes/abc.json"));
    await pruneUnusedVersions(home);
    expect((await fs.readdir(path.join(home, "versions"))).sort()).toEqual([record.current, record.previous!.id, record.pending!.id].sort());
  });
  it("does not prune any version when process ownership is uncertain", async () => {
    const oldest = (await readInstallation(home)).current;
    await fixture("1.1.0"); await installStandalone(source);
    await fixture("1.2.0"); await installStandalone(source);
    await writeStoreJson(home, "runtimes/abc.json", { pid: process.pid, host: "another-host", bundle: oldest });
    await pruneUnusedVersions(home);
    expect(await fs.readdir(path.join(home, "versions"))).toContain(oldest);
  });
});
