import * as fileAccess from "../src/utils/files.js";
import { prepareVerdicts } from "./snapshot-helpers.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifySnapshot, saveVerification, saveSnapshotData, checkDrift } from "../src/mcp/tools.js";

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
    vi.restoreAllMocks();
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
      await saveVerification(tmpDir, await prepareVerdicts(tmpDir, {
        auth: { ok: true },
        billing: { ok: false, note: "files are about invoicing UI, not generation" },
        ghost: { ok: true },
      }))
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
    await saveVerification(tmpDir, await prepareVerdicts(tmpDir, { auth: { ok: false, note: "wrong" } }));
    await saveVerification(tmpDir, await prepareVerdicts(tmpDir, { auth: { ok: true } }));

    const snapshot = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8")
    );
    expect(snapshot.features.auth.verificationFailed).toBeUndefined();
    expect(snapshot.features.auth.verificationNote).toBeUndefined();
  });

  it("mason_check_drift surfaces verification state additively", async () => {
    await writeSnapshot();
    await saveVerification(tmpDir, await prepareVerdicts(tmpDir, {
      billing: { ok: false, note: "mis-mapped" },
    }));

    const drift = JSON.parse(await checkDrift(tmpDir));
    expect(drift.verification.failed).toEqual(["billing"]);
    expect(drift.verification.neverVerified).toBe(2); // auth + "login flow"
    expect(drift.hint).toMatch(/re-map those entries/i);
  });

  it("requires prepared tokens without rewriting the snapshot", async () => {
    await writeSnapshot();
    const file = path.join(tmpDir, ".mason/snapshot.json");
    const before = await fs.readFile(file, "utf8");
    const result = JSON.parse(await saveVerification(tmpDir, { auth: { ok: true } }));
    expect(result).toMatchObject({ status: "review_required", stamped: [], reviewRequired: ["auth"] });
    expect(result.hint).toMatch(/verify_snapshot/);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it.each(["description", "files", "type", "tests", "delete"])("rejects a review after changing its %s", async change => {
    await writeSnapshot();
    const verdicts = await prepareVerdicts(tmpDir, { auth: { ok: true } });
    if (change === "delete") await saveSnapshotData(tmpDir, {}, {}, ["auth"]);
    else await saveSnapshotData(tmpDir, { auth: {
      description: change === "description" ? "Repaired description" : "Login handling",
      files: change === "files" ? ["src/billing.ts"] : ["src/auth.ts"],
      ...(change === "type" ? { type: "infrastructure" as const } : {}),
      ...(change === "tests" ? { tests: ["test/auth.test.ts"] } : {}),
    } }, {});
    const file = path.join(tmpDir, ".mason/snapshot.json");
    const before = await fs.readFile(file, "utf8");
    const result = JSON.parse(await saveVerification(tmpDir, verdicts));
    expect(result).toMatchObject({ status: "conflict", stamped: [], conflicts: ["auth"] });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("rejects changes beyond the source preview, even without a commit", async () => {
    await writeSnapshot();
    const prefix = "// unchanged preview\n".repeat(30);
    await fs.writeFile(path.join(tmpDir, "src/auth.ts"), prefix + "export const valid = true;\n");
    const verdicts = await prepareVerdicts(tmpDir, { auth: { ok: true } });
    await fs.writeFile(path.join(tmpDir, "src/auth.ts"), prefix + "export const valid = false;\n");
    const result = JSON.parse(await saveVerification(tmpDir, verdicts));
    expect(result).toMatchObject({ status: "conflict", stamped: [], conflicts: ["auth"] });
  });

  it("rejects evidence that becomes excluded or unavailable after review", async () => {
    await writeSnapshot();
    const verdicts = await prepareVerdicts(tmpDir, { auth: { ok: true } });
    await fs.writeFile(path.join(tmpDir, ".mason/config.json"), JSON.stringify({ ignore: ["src/auth.ts"] }));
    expect(JSON.parse(await saveVerification(tmpDir, verdicts)).conflicts).toEqual(["auth"]);
  });

  it("keeps tokens valid across unrelated edits and metadata-only saves", async () => {
    await writeSnapshot();
    const verdicts = await prepareVerdicts(tmpDir, { auth: { ok: true } });
    await saveSnapshotData(tmpDir, { billing: { description: "Updated billing", files: ["src/billing.ts"] } }, {});
    await fs.writeFile(path.join(tmpDir, "src/billing.ts"), "export const invoice = false;\n");
    await git(["add", "."], tmpDir);
    await git(["commit", "-m", "unrelated edit"], tmpDir);
    await saveSnapshotData(tmpDir, {}, {});
    expect(JSON.parse(await saveVerification(tmpDir, verdicts))).toMatchObject({ status: "saved", stamped: ["auth"] });
    expect((await prepareVerdicts(tmpDir, { auth: { ok: true } })).auth.reviewToken).toBe(verdicts.auth.reviewToken);
    const snapshot = JSON.parse(await fs.readFile(path.join(tmpDir, ".mason/snapshot.json"), "utf8"));
    expect(snapshot.features.auth.verificationToken).toBe(verdicts.auth.reviewToken);
  });

  it("identifies features and flows separately when they share a name", async () => {
    await writeSnapshot();
    await saveSnapshotData(tmpDir, {}, { auth: { description: "Auth flow", chain: ["src/auth.ts", "src/billing.ts"] } });
    const feature = await prepareVerdicts(tmpDir, { auth: { ok: true, kind: "feature" } });
    const flow = await prepareVerdicts(tmpDir, { auth: { ok: false, note: "Wrong flow", kind: "flow" } });
    expect(feature.auth.reviewToken).not.toBe(flow.auth.reviewToken);
    expect(JSON.parse(await saveVerification(tmpDir, { auth: { ...feature.auth, kind: "flow" } })).conflicts).toEqual(["auth"]);
    await saveVerification(tmpDir, flow);
    const snapshot = JSON.parse(await fs.readFile(path.join(tmpDir, ".mason/snapshot.json"), "utf8"));
    expect(snapshot.features.auth.verifiedAt).toBeUndefined();
    expect(snapshot.flows.auth.verificationFailed).toBe(true);
    expect(JSON.parse(await saveVerification(tmpDir, feature)).stamped).toEqual(["auth"]);
  });

  it("requires a new review after repair and preserves the repaired content", async () => {
    await writeSnapshot();
    await saveVerification(tmpDir, await prepareVerdicts(tmpDir, { auth: { ok: false, note: "Incorrect description" } }));
    await saveSnapshotData(tmpDir, { auth: { description: "Repaired login", files: ["src/auth.ts"] } }, {}, [], ["login flow"]);
    const result = JSON.parse(await saveVerification(tmpDir, await prepareVerdicts(tmpDir, { auth: { ok: true } })));
    expect(result.status).toBe("saved");
    const snapshot = JSON.parse(await fs.readFile(path.join(tmpDir, ".mason/snapshot.json"), "utf8"));
    expect(snapshot.features.auth).toMatchObject({ description: "Repaired login", verifiedAt: expect.any(String), verificationToken: expect.any(String) });
    expect(snapshot.features.auth.verificationFailed).toBeUndefined();
    expect(snapshot.flows["login flow"]).toBeUndefined();
  });

  it("reports mixed outcomes without claiming that every entry was verified", async () => {
    await writeSnapshot();
    const verdicts = await prepareVerdicts(tmpDir, { auth: { ok: true }, billing: { ok: true } });
    await fs.writeFile(path.join(tmpDir, "src/billing.ts"), "export const invoice = false;\n");
    const result = JSON.parse(await saveVerification(tmpDir, verdicts));
    expect(result).toMatchObject({ status: "partial", stamped: ["auth"], conflicts: ["billing"] });
    expect(result.hint).not.toMatch(/All.*verified/);
  });

  it("does not record a failed verdict without an explanation", async () => {
    await writeSnapshot();
    const result = JSON.parse(await saveVerification(tmpDir, await prepareVerdicts(tmpDir, { auth: { ok: false, note: " " } })));
    expect(result).toMatchObject({ status: "invalid", stamped: [], invalid: ["auth"] });
  });


  it("rejects source changes during verdict recording before committing a stamp", async () => {
    await writeSnapshot();
    const verdicts = await prepareVerdicts(tmpDir, { auth: { ok: true } });
    const createAccess = fileAccess.createFileAccess;
    let reads = 0;
    vi.spyOn(fileAccess, "createFileAccess").mockImplementation(async root => {
      const access = await createAccess(root);
      return { ...access, read: async file => {
        const source = await access.read(file);
        if (++reads === 1) await fs.writeFile(path.join(tmpDir, "src/auth.ts"), "export function changed() {}\n");
        return source;
      } };
    });
    const result = JSON.parse(await saveVerification(tmpDir, verdicts));
    expect(result).toMatchObject({ status: "conflict", stamped: [], conflicts: ["auth"] });
    const snapshot = JSON.parse(await fs.readFile(path.join(tmpDir, ".mason/snapshot.json"), "utf8"));
    expect(snapshot.features.auth.verifiedAt).toBeUndefined();
  });

  it("guides clients missing tokens even when source evidence is currently unavailable", async () => {
    await writeSnapshot();
    await fs.writeFile(path.join(tmpDir, ".mason/config.json"), "{broken");
    expect(JSON.parse(await saveVerification(tmpDir, { auth: { ok: true } }))).toMatchObject({ status: "review_required", stamped: [] });
  });

});
