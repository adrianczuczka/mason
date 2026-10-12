import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  checkDrift,
  getSnapshot,
  masonInit,
  masonCompleteInit,
  saveSnapshotData,
} from "../src/mcp/tools.js";

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<void> {
  await exec("git", args, { cwd });
}

async function markInitialized(rootDir: string): Promise<void> {
  const dir = path.join(rootDir, ".mason");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "project.json"),
    JSON.stringify({
      version: 1,
      initializedAt: new Date().toISOString(),
    }),
  );
}

describe("MCP tools", () => {
  describe("getSnapshot", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-snapshot-test-"));
      await git(["init"], tmpDir);
      await git(["config", "user.email", "test@test.com"], tmpDir);
      await git(["config", "user.name", "Test"], tmpDir);
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("reports a missing map without requiring initialization", async () => {
      const raw = await getSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.exists).toBe(false);
      expect(data.map.status).toBe("missing");
      expect(typeof data.hint).toBe("string");
      expect(data.hint).toMatch(/get_context|Decisions/);
      // Reads stay pure — no .mason directory should appear
      await expect(fs.access(path.join(tmpDir, ".mason"))).rejects.toBeTruthy();
    });

    it("missing-map response routes to reasoning without collecting orientation context", async () => {
      const data = JSON.parse(await getSnapshot(tmpDir));
      expect(data.exists).toBe(false);
      expect(data.hint).toMatch(/get_context/);
      expect(data).not.toHaveProperty("structure");
      expect(data).not.toHaveProperty("gitSignals");
      expect(data).not.toHaveProperty("testPairs");
    });

    it("returns exists:false when initialized but no snapshot exists yet", async () => {
      await markInitialized(tmpDir);
      const raw = await getSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.exists).toBe(false);
      expect(typeof data.hint).toBe("string");
      expect(data.hint).toMatch(/get_context/);
    });

    it("returns diff payload when snapshot is stale", async () => {
      await markInitialized(tmpDir);

      // First commit: create src/a.ts and snapshot referencing it
      await fs.mkdir(path.join(tmpDir, "src"));
      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", "feat: add a"], tmpDir);
      const { stdout: firstHash } = await exec("git", ["rev-parse", "HEAD"], {
        cwd: tmpDir,
      });

      // Write snapshot pinned to the first commit
      const snapshotDir = path.join(tmpDir, ".mason");
      const snapshot = {
        version: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        gitHash: firstHash.trim(),
        features: {
          core: { description: "core math", files: ["src/a.ts"] },
        },
        flows: {},
      };
      await fs.writeFile(path.join(snapshotDir, "snapshot.json"), JSON.stringify(snapshot));

      // Second commit: modify a.ts so HEAD differs from snapshot.gitHash
      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 2;\n");
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", "fix: bump a"], tmpDir);

      const raw = await getSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.exists).toBe(true);
      expect(data.stale).toBe(true);
      expect(data.diff).toBeDefined();
      expect(data.diff.changedFiles).toContain("src/a.ts");
      expect(data.diff.samples.length).toBeGreaterThanOrEqual(1);
      expect(data.diff.samples[0]).toHaveProperty("preview");
      expect(typeof data.hint).toBe("string");
      // Feature-level drift rides along with the raw diff
      expect(data.drift).toBeDefined();
      expect(data.drift.staleFeatures).toEqual({ core: ["src/a.ts"] });
      expect(data.drift.recommendation).toBe("incremental");
    });
  });

  describe("checkDrift", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-drift-tool-test-"));
      await git(["init"], tmpDir);
      await git(["config", "user.email", "test@test.com"], tmpDir);
      await git(["config", "user.name", "Test"], tmpDir);
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("reports a missing map without requiring initialization", async () => {
      const raw = await checkDrift(tmpDir);
      const data = JSON.parse(raw);

      expect(data.exists).toBe(false);
      expect(data.hint).toMatch(/get_context|Decisions/);
    });

    it("returns exists:false when initialized but no snapshot exists yet", async () => {
      await markInitialized(tmpDir);
      const raw = await checkDrift(tmpDir);
      const data = JSON.parse(raw);

      expect(data.exists).toBe(false);
      expect(data.hint).toMatch(/Managed map creation has been removed/);
    });

    it("reports feature-level drift with an actionable hint", async () => {
      await markInitialized(tmpDir);

      await fs.mkdir(path.join(tmpDir, "src"));
      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", "feat: add a"], tmpDir);
      const { stdout: firstHash } = await exec("git", ["rev-parse", "HEAD"], {
        cwd: tmpDir,
      });

      await fs.writeFile(
        path.join(tmpDir, ".mason", "snapshot.json"),
        JSON.stringify({
          version: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          gitHash: firstHash.trim(),
          features: { core: { description: "core", files: ["src/a.ts"] } },
          flows: {},
        }),
      );

      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 2;\n");
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", "fix: bump a"], tmpDir);

      const raw = await checkDrift(tmpDir);
      const data = JSON.parse(raw);

      expect(data.exists).toBe(true);
      expect(data.stale).toBe(true);
      expect(data.staleFeatures).toEqual({ core: ["src/a.ts"] });
      expect(data.recommendation).toBe("incremental");
      expect(data.hint).toMatch(/save_snapshot/);
    });

    it("stays current when changes touch nothing in the map", async () => {
      await markInitialized(tmpDir);

      await fs.mkdir(path.join(tmpDir, "src"));
      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", "feat: add a"], tmpDir);
      const { stdout: firstHash } = await exec("git", ["rev-parse", "HEAD"], {
        cwd: tmpDir,
      });

      await fs.writeFile(
        path.join(tmpDir, ".mason", "snapshot.json"),
        JSON.stringify({
          version: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          gitHash: firstHash.trim(),
          features: { core: { description: "core", files: ["src/a.ts"] } },
          flows: {},
        }),
      );

      // Advance HEAD without touching any mapped or source file
      await fs.writeFile(path.join(tmpDir, "notes.md"), "# notes\n");
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", "docs: add notes"], tmpDir);

      const raw = await checkDrift(tmpDir);
      const data = JSON.parse(raw);

      expect(data.stale).toBe(false);
      expect(data.staleFeatures).toEqual({});
      expect(data.unmappedFiles).toEqual([]);
      expect(data.recommendation).toBe("up-to-date");
    });
  });

  describe("saveSnapshotData incremental mode", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-incr-test-"));
      await git(["init"], tmpDir);
      await git(["config", "user.email", "test@test.com"], tmpDir);
      await git(["config", "user.name", "Test"], tmpDir);
      await fs.mkdir(path.join(tmpDir, "src"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function commitAll(message: string): Promise<string> {
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", message], tmpDir);
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
        cwd: tmpDir,
      });
      return stdout.trim();
    }

    it("removes named features and flows before merging", async () => {
      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
      await commitAll("feat: add a");

      await saveSnapshotData(
        tmpDir,
        {
          alpha: { description: "alpha", files: ["src/a.ts"] },
          beta: { description: "beta", files: ["src/b.ts"] },
        },
        { fetch: { description: "fetch", chain: ["src/a.ts"] } },
      );

      const raw = await saveSnapshotData(tmpDir, {}, {}, ["beta"], ["fetch"]);
      const data = JSON.parse(raw);
      expect(data.mode).toBe("merged");
      expect(data.removedFeatures).toBe(1);
      expect(data.removedFlows).toBe(1);

      const onDisk = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8"),
      );
      expect(Object.keys(onDisk.features)).toEqual(["alpha"]);
      expect(onDisk.flows).toEqual({});
    });

    it("ignores abandoned partials without replacing the map or deleting legacy files", async () => {
      await fs.writeFile(path.join(tmpDir, "src/a.ts"), "export const a = 1;\n");
      await commitAll("source");
      await saveSnapshotData(
        tmpDir,
        {
          alpha: { description: "original", files: ["src/a.ts"] },
          beta: { description: "untouched", files: ["src/b.ts"] },
        },
        {},
      );
      const oldPartial = path.join(tmpDir, ".mason/partial-snapshots/batch-00000.json");
      await fs.mkdir(path.dirname(oldPartial), { recursive: true });
      await fs.writeFile(oldPartial, "abandoned malformed partial");
      await saveSnapshotData(
        tmpDir,
        { alpha: { description: "corrected", files: ["src/a.ts"] } },
        {},
      );
      const map = JSON.parse(await fs.readFile(path.join(tmpDir, ".mason/snapshot.json"), "utf8"));
      expect(map.features.alpha.description).toBe("corrected");
      expect(map.features.beta.description).toBe("untouched");
      expect(await fs.readFile(oldPartial, "utf8")).toBe("abandoned malformed partial");
    });

    it("stamps refreshed entries with HEAD and untouched entries with the previous hash", async () => {
      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
      await fs.writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 1;\n");
      const firstHash = await commitAll("feat: add a and b");

      await saveSnapshotData(
        tmpDir,
        {
          alpha: { description: "alpha", files: ["src/a.ts"] },
          beta: { description: "beta", files: ["src/b.ts"] },
        },
        {},
      );

      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 2;\n");
      const secondHash = await commitAll("fix: bump a");

      // Incremental refresh of alpha only
      await saveSnapshotData(
        tmpDir,
        { alpha: { description: "alpha v2", files: ["src/a.ts"] } },
        {},
      );

      const onDisk = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8"),
      );
      expect(onDisk.gitHash).toBe(secondHash);
      expect(onDisk.features.alpha.refreshedHash).toBe(secondHash);
      expect(onDisk.features.beta.refreshedHash).toBe(firstHash);
    });
  });

  describe("masonInit / masonCompleteInit", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-init-test-"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("returns the playbook on un-initialized projects", async () => {
      const raw = await masonInit(tmpDir);
      const data = JSON.parse(raw);

      expect(data.initialized).toBe(false);
      expect(typeof data.playbook).toBe("string");
      expect(data.mode).toBe("quickstart");
      expect(data.playbook).toMatch(/save_decision/);
      expect(data.playbook).not.toMatch(/PHASE 1 — Map/);
      expect(data.playbook).toMatch(/mason_init again with mode: "setup"/);
    });

    it("playbook carries the CLAUDE.md section with markers", async () => {
      const raw = await masonInit(tmpDir);
      const data = JSON.parse(raw);

      expect(data.playbook).toMatch(/UNIFIED SETUP/);
      expect(data.playbook).toContain("<!-- mason:start -->");
      expect(data.playbook).toContain("<!-- mason:end -->");
      expect(data.playbook).toMatch(/`get_context` with the task text/);
      // Initialization and activation are explicit; read-only inspection stays available.
      expect(data.playbook).toMatch(/same engine as mason init/);
      expect(data.playbook).toMatch(
        /only requested inspection or review, report findings without running setup/,
      );
    });

    it("returns initialized=true after masonCompleteInit", async () => {
      await masonCompleteInit(tmpDir);
      const raw = await masonInit(tmpDir);
      const data = JSON.parse(raw);

      expect(data.initialized).toBe(true);
      expect(typeof data.initializedAt).toBe("string");
    });

    it("masonCompleteInit is idempotent", async () => {
      await masonCompleteInit(tmpDir);
      await masonCompleteInit(tmpDir);
      const raw = await masonInit(tmpDir);
      const data = JSON.parse(raw);
      expect(data.initialized).toBe(true);
    });
  });
});
