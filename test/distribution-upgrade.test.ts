import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { upgradeStandalone } from "../src/distribution/install.js";
import { currentInstallation, readInstallation } from "../src/distribution/state.js";

vi.mock("../src/distribution/state.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/distribution/state.js")>(), currentInstallation: vi.fn(),
}));
vi.mock("../src/distribution/bundle.js", () => ({ verifyBundle: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));
let home: string;
let output: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-upgrade-")));
  const record = { format: 1, home, bin: path.join(home, "bin"), current: "a".repeat(24), version: "1.0.0", launchers: {},
    updates: { enabled: true, revision: "old", pinnedVersion: "1.0.0" } };
  await fs.writeFile(path.join(home, "install.json"), JSON.stringify(record));
  vi.mocked(currentInstallation).mockResolvedValue({ home, bundle: path.join(home, "versions", record.current), record } as any);
  vi.stubEnv("MASON_RELEASE_BASE", "");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, url: "https://github.com/adrianczuczka/mason/releases/tag/v1.0.0" }));
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child as any;
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });
it("skips the installer when latest is installed and clears the version pin", async () => {
  expect(await upgradeStandalone()).toBe(0);
  expect(spawn).not.toHaveBeenCalled();
  expect(output).toHaveBeenCalledExactlyOnceWith("Mason 1.0.0 is already installed.");
  expect((await readInstallation(home)).updates).toMatchObject({ enabled: true });
  expect((await readInstallation(home)).updates?.pinnedVersion).toBeUndefined();
});
it("pins an explicitly requested installed version without network requests", async () => {
  expect(await upgradeStandalone("v1.0.0")).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect((await readInstallation(home)).updates?.pinnedVersion).toBe("1.0.0");
});
it("runs the installer for a different version", async () => {
  expect(await upgradeStandalone("1.1.0")).toBe(0);
  expect(spawn).toHaveBeenCalledOnce();
  expect(output).toHaveBeenCalledWith(expect.stringContaining("Restart running assistants"));
});
it("hands the resolved latest version to the installer without pinning it", async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, url: "https://github.com/adrianczuczka/mason/releases/tag/v1.1.0" } as Response);
  expect(await upgradeStandalone()).toBe(0);
  const [, args, options] = vi.mocked(spawn).mock.calls[0];
  expect(args?.at(-1)).toBe("1.1.0");
  expect((options as any).env.MASON_VERSION).toBe("");
  expect(fetch).toHaveBeenCalledOnce();
});
it("requires a version for mirrors without checking public releases", async () => {
  vi.stubEnv("MASON_RELEASE_BASE", "https://mirror.example/releases");
  await expect(upgradeStandalone()).rejects.toThrow("Specify a version");
  expect(fetch).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
it("does not install when latest discovery fails", async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
  await expect(upgradeStandalone()).rejects.toThrow("HTTP 503");
  expect(spawn).not.toHaveBeenCalled();
});

it("explains certificate failures without starting the installer", async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed", {
    cause: Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }),
  }));
  await expect(upgradeStandalone()).rejects.toThrow(/GitHub.*UNABLE_TO_GET_ISSUER_CERT_LOCALLY.*NODE_EXTRA_CA_CERTS/);
  expect(spawn).not.toHaveBeenCalled();
});

it("distinguishes network failures from certificate failures", async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }),
  }));
  await expect(upgradeStandalone()).rejects.toThrow(/GitHub.*ENOTFOUND.*network and proxy/);
  expect(spawn).not.toHaveBeenCalled();
});
