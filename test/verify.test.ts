import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifySnapshot, saveVerification, checkDrift } from "../src/mcp/tools.js";

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

describe("verify_snapshot / save_verification", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-verify-test-"));
    await git(["init"], tmpDir);
    await git(["config", "user.email", "test@test.com"], tmpDir);
    await git(["config", "user.name", "Test"], tmpDir);
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export function login() {}\n");
    await fs.writeFile(path.join(tmpDir, "src", "billing.ts"), "export function invoice() {}\n");
    await git(["add", "."], tmpDir);
    await git(["commit", "-m", "initial"], tmpDir);

    await fs.mkdir(path.join(tmpDir, ".mason"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".mason", "project.json"),
      JSON.stringify({ version: 1, initializedAt: new Date().toISOString() })
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSnapshot(extra: {
    authVerifiedAt?: string;
    billingVerifiedAt?: string;
  } = {}): Promise<void> {
    const hash = await git(["rev-parse", "HEAD"], tmpDir);
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(tmpDir, ".mason", "snapshot.json"),
      JSON.stringify({
        version: 2,
        createdAt: now,
        updatedAt: now,
        gitHash: hash,
        features: {
          auth: {
            description: "Login handling",
            files: ["src/auth.ts"],
            ...(extra.authVerifiedAt ? { verifiedAt: extra.authVerifiedAt } : {}),
          },
          billing: {
            description: "Invoice generation",
            files: ["src/billing.ts", "src/gone.ts"],
            ...(extra.billingVerifiedAt
              ? { verifiedAt: extra.billingVerifiedAt }
              : {}),
          },
        },
        flows: {
          "login flow": {
            description: "Credentials to session",
            chain: ["src/auth.ts"],
          },
        },
      })
    );
  }

  it("samples never-verified entries first with file skeletons, flagging missing files", async () => {
    await writeSnapshot({ authVerifiedAt: "2026-01-01T00:00:00.000Z" });

    const result = JSON.parse(await verifySnapshot(tmpDir, 2));
    expect(result.totalEntries).toBe(3);
    expect(result.neverVerified).toBe(2);

    const names = result.entries.map((e: { name: string }) => e.name);
    // billing and "login flow" are never-verified — they outrank verified auth
    expect(names).toEqual(["billing", "login flow"]);

    const billing = result.entries[0];
    expect(billing.skeletons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/billing.ts" }),
        expect.objectContaining({ path: "src/gone.ts", missing: true }),
      ])
    );
    expect(result.instructions).toMatch(/save_verification/);
  });

  it("prefers oldest-verified after never-verified are exhausted", async () => {
    await writeSnapshot({
      authVerifiedAt: "2026-01-01T00:00:00.000Z",
      billingVerifiedAt: "2026-06-01T00:00:00.000Z",
    });

    const result = JSON.parse(await verifySnapshot(tmpDir, 2));
    // "login flow" never verified → first; then auth (older than billing)
    expect(result.entries.map((e: { name: string }) => e.name)).toEqual([
      "login flow",
      "auth",
    ]);
  });

  it("stamps ok verdicts and flags failures; unknown names reported", async () => {
    await writeSnapshot();

    const result = JSON.parse(
      await saveVerification(tmpDir, {
        auth: { ok: true },
        billing: { ok: false, note: "files are about invoicing UI, not generation" },
        ghost: { ok: true },
      })
    );
    expect(result.stamped.sort()).toEqual(["auth", "billing"]);
    expect(result.unknown).toEqual(["ghost"]);
    expect(result.failed).toEqual(["billing"]);
    expect(result.hint).toMatch(/Re-map/);

    const snapshot = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8")
    );
    expect(snapshot.features.auth.verifiedAt).toBeTruthy();
    expect(snapshot.features.auth.verificationFailed).toBeUndefined();
    expect(snapshot.features.billing.verificationFailed).toBe(true);
    expect(snapshot.features.billing.verificationNote).toMatch(/invoicing UI/);
  });

  it("a later ok verdict clears a previous failure", async () => {
    await writeSnapshot();
    await saveVerification(tmpDir, { auth: { ok: false, note: "wrong" } });
    await saveVerification(tmpDir, { auth: { ok: true } });

    const snapshot = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8")
    );
    expect(snapshot.features.auth.verificationFailed).toBeUndefined();
    expect(snapshot.features.auth.verificationNote).toBeUndefined();
  });

  it("mason_check_drift surfaces verification state additively", async () => {
    await writeSnapshot();
    await saveVerification(tmpDir, {
      billing: { ok: false, note: "mis-mapped" },
    });

    const drift = JSON.parse(await checkDrift(tmpDir));
    expect(drift.verification.failed).toEqual(["billing"]);
    expect(drift.verification.neverVerified).toBe(2); // auth + "login flow"
    expect(drift.hint).toMatch(/re-map those entries/i);
  });
});
