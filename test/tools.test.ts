import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  analyzeProject,
  checkDrift,
  getProjectStructure,
  getCodeSamples,
  fullAnalysis,
  generateSnapshotBatch,
  getSnapshot,
  masonInit,
  masonCompleteInit,
  reduceSnapshot,
  saveSnapshotData,
  saveSnapshotPartial,
} from "../src/mcp/tools.js";
import { fixturePath } from "./helpers.js";

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
    })
  );
}

describe("MCP tools", () => {
  describe("analyzeProject", () => {
    it("returns project snapshot with config files", async () => {
      const raw = await analyzeProject(fixturePath("kotlin-multiplatform"));
      const data = JSON.parse(raw);

      expect(data.project.configFilesPresent).toContain("build.gradle.kts");
      expect(data.project.configFilesPresent).toContain("settings.gradle.kts");
      expect(data.project.configFilesPresent).toContain(
        "gradle/libs.versions.toml"
      );
    });

    it("returns source file counts", async () => {
      const raw = await analyzeProject(fixturePath("kotlin-multiplatform"));
      const data = JSON.parse(raw);

      expect(data.project.sourceFileCounts.kt).toBeGreaterThanOrEqual(5);
      expect(data.project.sourceFileCounts.swift).toBeGreaterThanOrEqual(2);
      expect(data.project.totalSourceFiles).toBeGreaterThanOrEqual(10);
    });

    it("returns test info", async () => {
      const raw = await analyzeProject(fixturePath("kotlin-multiplatform"));
      const data = JSON.parse(raw);

      expect(data.project.testInfo).toBeDefined();
      expect(data.project.testInfo["*Test.kt"]).toBeGreaterThanOrEqual(1);
    });

    it("returns test info for go project", async () => {
      const raw = await analyzeProject(fixturePath("go-api"));
      const data = JSON.parse(raw);

      expect(data.project.configFilesPresent).toContain("go.mod");
      expect(data.project.configFilesPresent).toContain("Dockerfile");
    });

    it("handles empty project", async () => {
      const raw = await analyzeProject(fixturePath("empty"));
      const data = JSON.parse(raw);

      expect(data.project.configFilesPresent).toEqual([]);
      expect(data.project.totalSourceFiles).toBe(0);
    });
  });

  describe("getProjectStructure", () => {
    it("returns directory tree with file counts", async () => {
      const raw = await getProjectStructure(fixturePath("node-react"));
      const data = JSON.parse(raw);

      expect(data.totalFiles).toBeGreaterThanOrEqual(10);
      expect(data.topLevelFiles).toContain("package.json");

      const srcDir = data.directories.find(
        (d: { path: string }) => d.path === "src"
      );
      expect(srcDir).toBeDefined();
      expect(srcDir.fileCount).toBeGreaterThanOrEqual(5);
    });

    it("returns extension breakdown", async () => {
      const raw = await getProjectStructure(fixturePath("go-api"));
      const data = JSON.parse(raw);

      const internalDir = data.directories.find(
        (d: { path: string }) => d.path === "internal"
      );
      expect(internalDir).toBeDefined();
      expect(internalDir.extensions.go).toBeGreaterThanOrEqual(5);
    });

    it("handles empty project", async () => {
      const raw = await getProjectStructure(fixturePath("empty"));
      const data = JSON.parse(raw);

      expect(data.totalFiles).toBe(0);
      expect(data.directories).toEqual([]);
    });
  });

  describe("getCodeSamples", () => {
    it("returns preview metadata", async () => {
      const raw = await getCodeSamples(fixturePath("node-react"), 10);
      const data = JSON.parse(raw);

      expect(data.note).toContain("previews");
      expect(data.files.length).toBeGreaterThanOrEqual(1);
      expect(data.files.length).toBeLessThanOrEqual(10);

      for (const file of data.files) {
        expect(file).toHaveProperty("path");
        expect(file).toHaveProperty("reason");
        expect(file).toHaveProperty("totalLines");
        expect(file).toHaveProperty("sizeBytes");
        expect(file).toHaveProperty("preview");
      }
    });
  });

  describe("fullAnalysis", () => {
    it("combines all tools into one response", async () => {
      const raw = await fullAnalysis(fixturePath("python-django"));
      const data = JSON.parse(raw);

      expect(data.note).toContain("Full project analysis");
      expect(data.analysis).toBeDefined();
      expect(data.structure).toBeDefined();
      expect(data.codeSamples).toBeDefined();
      expect(data.testMap).toBeDefined();

      // Verify analysis has project snapshot
      expect(data.analysis.project.configFilesPresent).toContain(
        "pyproject.toml"
      );

      // Verify structure has directories
      expect(data.structure.totalFiles).toBeGreaterThanOrEqual(5);

      // Verify code samples has files
      expect(data.codeSamples.files.length).toBeGreaterThanOrEqual(3);

      // Verify test map has pairings
      expect(data.testMap.totalTestFiles).toBeGreaterThanOrEqual(2);
    });

    it("handles empty project", async () => {
      const raw = await fullAnalysis(fixturePath("empty"));
      const data = JSON.parse(raw);

      expect(data.analysis).toBeDefined();
      expect(data.structure.totalFiles).toBe(0);
      expect(data.codeSamples.files).toEqual([]);
      expect(data.testMap.totalTestFiles).toBe(0);
    });
  });

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

    it("refuses to run on un-initialized projects", async () => {
      const raw = await getSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.initialized).toBe(false);
      expect(typeof data.hint).toBe("string");
      expect(data.hint).toMatch(/mason_init/);
      // Reads stay pure — no .mason directory should appear
      await expect(
        fs.access(path.join(tmpDir, ".mason"))
      ).rejects.toBeTruthy();
    });

    it("uninitialized response carries usable context inline", async () => {
      await fs.mkdir(path.join(tmpDir, "src"));
      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
      await fs.writeFile(path.join(tmpDir, "src", "a.test.ts"), "// tests a\n");
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", "feat: add a"], tmpDir);

      const raw = await getSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.initialized).toBe(false);
      // Structure, git signals, and test pairing arrive in the same call so
      // the assistant can act without a second round-trip.
      expect(data.structure.totalFiles).toBeGreaterThan(0);
      expect(Array.isArray(data.structure.directories)).toBe(true);
      expect(Array.isArray(data.gitSignals)).toBe(true);
      expect(data.testPairs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ test: "src/a.test.ts", source: "src/a.ts" }),
        ])
      );
      // Still read-only
      await expect(
        fs.access(path.join(tmpDir, ".mason"))
      ).rejects.toBeTruthy();
    });

    it("returns exists:false when initialized but no snapshot exists yet", async () => {
      await markInitialized(tmpDir);
      const raw = await getSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.exists).toBe(false);
      expect(typeof data.hint).toBe("string");
      expect(data.hint).toMatch(/generate_snapshot/);
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
      await fs.writeFile(
        path.join(snapshotDir, "snapshot.json"),
        JSON.stringify(snapshot)
      );

      // Second commit: modify a.ts so HEAD differs from snapshot.gitHash
      await fs.writeFile(
        path.join(tmpDir, "src", "a.ts"),
        "export const a = 2;\n"
      );
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

    it("refuses to run on un-initialized projects", async () => {
      const raw = await checkDrift(tmpDir);
      const data = JSON.parse(raw);

      expect(data.initialized).toBe(false);
      expect(data.hint).toMatch(/mason_init/);
    });

    it("returns exists:false when initialized but no snapshot exists yet", async () => {
      await markInitialized(tmpDir);
      const raw = await checkDrift(tmpDir);
      const data = JSON.parse(raw);

      expect(data.exists).toBe(false);
      expect(data.hint).toMatch(/generate_snapshot_batch/);
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
        })
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

    it("suggests re-pinning when changes touch nothing in the map", async () => {
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
        })
      );

      // Advance HEAD without touching any mapped or source file
      await fs.writeFile(path.join(tmpDir, "notes.md"), "# notes\n");
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", "docs: add notes"], tmpDir);

      const raw = await checkDrift(tmpDir);
      const data = JSON.parse(raw);

      expect(data.stale).toBe(true);
      expect(data.staleFeatures).toEqual({});
      expect(data.unmappedFiles).toEqual([]);
      expect(data.hint).toMatch(/re-pin/);
    });
  });

  describe("generateSnapshotBatch", () => {
    it("returns batch metadata and prompt body for the first batch", async () => {
      const raw = await generateSnapshotBatch(fixturePath("node-react"));
      const data = JSON.parse(raw);

      expect(data.offset).toBe(0);
      expect(typeof data.batchId).toBe("string");
      expect(data.batchId).toMatch(/^batch-/);
      expect(typeof data.totalFiles).toBe("number");
      expect(data.totalFiles).toBeGreaterThan(0);
      expect(typeof data.instructions).toBe("string");
      expect(data.instructions).toMatch(/Map-Reduce/);
      expect(typeof data.prompt).toBe("string");
      expect(data.prompt.length).toBeGreaterThan(0);
    });

    it("handles empty projects without erroring", async () => {
      const raw = await generateSnapshotBatch(fixturePath("empty"));
      const data = JSON.parse(raw);

      expect(data.totalFiles).toBe(0);
      expect(data.nextOffset).toBeNull();
      expect(data.prompt).toBe("(No source files found to map.)");
      expect(data.next).toMatch(/mason_complete_init/);
    });

    it("paginates: every file is visited exactly once across batches", async () => {
      // node-react fixture should fit in 2-3 small batches with batchSize=2
      const seen = new Set<string>();
      let offset: number | null = 0;
      let totalFiles = 0;
      let batches = 0;

      while (offset !== null) {
        const raw = await generateSnapshotBatch(
          fixturePath("node-react"),
          offset,
          2
        );
        const data = JSON.parse(raw);
        totalFiles = data.totalFiles;
        batches++;

        // Extract file paths from the prompt — each appears as "--- path ---"
        const matches = (data.prompt as string).matchAll(/^--- (.+?) ---$/gm);
        for (const m of matches) seen.add(m[1]);

        offset = data.nextOffset;
        if (batches > 50) throw new Error("Runaway pagination");
      }

      // Every file appeared in some batch, exactly once
      expect(seen.size).toBe(totalFiles);
      expect(batches).toBeGreaterThanOrEqual(2);
    });
  });

  describe("MapReduce flow: partials + reduce + save", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-mapred-test-"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("save_partial_snapshot persists; reduce_snapshot returns all partials", async () => {
      await saveSnapshotPartial(tmpDir, "batch-000000", 0, {
        Auth: { description: "login", files: ["src/auth.ts"] },
      }, {});
      await saveSnapshotPartial(tmpDir, "batch-000050", 50, {
        Home: { description: "home", files: ["src/home.ts"] },
      }, {});

      const raw = await reduceSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.partialsCount).toBe(2);
      expect(typeof data.instructions).toBe("string");
      expect(data.instructions).toMatch(/merging partial concept maps/i);
      // Reduce prompt body contains both batches' feature names
      expect(data.prompt).toMatch(/Auth/);
      expect(data.prompt).toMatch(/Home/);
    });

    it("reduce_snapshot returns error when no partials exist", async () => {
      const raw = await reduceSnapshot(tmpDir);
      const data = JSON.parse(raw);
      expect(data.status).toBe("error");
      expect(data.error).toMatch(/No partial snapshots/i);
    });

    it("save_snapshot clears partial-snapshots directory", async () => {
      await saveSnapshotPartial(tmpDir, "batch-000000", 0, {
        Auth: { description: "login", files: ["src/auth.ts"] },
      }, {});

      const partialsDir = path.join(tmpDir, ".mason", "partial-snapshots");
      await expect(fs.access(partialsDir)).resolves.toBeUndefined();

      await saveSnapshotData(tmpDir, {
        Auth: { description: "user login flow", files: ["src/auth.ts"] },
      }, {});

      await expect(fs.access(partialsDir)).rejects.toBeTruthy();
      // Final snapshot still exists
      await expect(
        fs.access(path.join(tmpDir, ".mason", "snapshot.json"))
      ).resolves.toBeUndefined();
    });

    it("save_snapshot REPLACES when partials exist (consolidation case)", async () => {
      // Simulate a botched earlier save_snapshot that wrote hallucinated entries.
      await saveSnapshotData(tmpDir, {
        Hallucinated: { description: "wrong", files: ["src/made-up.ts"] },
      }, {});

      // Now an MR run records partials.
      await saveSnapshotPartial(tmpDir, "batch-000000", 0, {
        Auth: { description: "x", files: ["src/auth.ts"] },
      }, {});
      await saveSnapshotPartial(tmpDir, "batch-000050", 50, {
        Home: { description: "x", files: ["src/home.ts"] },
      }, {});

      // The reduce-step output is what should land — the hallucinated entry
      // from before must be dropped, not merged in.
      const raw = await saveSnapshotData(tmpDir, {
        Auth: { description: "user login flow", files: ["src/auth.ts"] },
        Home: { description: "home screen", files: ["src/home.ts"] },
      }, {});
      const data = JSON.parse(raw);
      expect(data.status).toBe("replaced");
      expect(data.mode).toBe("replaced-from-partials");
      expect(data.features).toBe(2);

      const onDisk = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8")
      );
      expect(Object.keys(onDisk.features).sort()).toEqual(["Auth", "Home"]);
      expect(onDisk.features.Hallucinated).toBeUndefined();
    });

    it("save_snapshot still MERGES when no partials are present (incremental case)", async () => {
      // First save sets a baseline.
      await saveSnapshotData(tmpDir, {
        Auth: { description: "user login", files: ["src/auth.ts"] },
        Home: { description: "home", files: ["src/home.ts"] },
      }, {});

      // No partials around — this is an incremental refresh of one feature.
      const raw = await saveSnapshotData(tmpDir, {
        Auth: { description: "updated description", files: ["src/auth.ts", "src/auth2.ts"] },
      }, {});
      const data = JSON.parse(raw);
      expect(data.status).toBe("updated");
      expect(data.mode).toBe("merged");

      const onDisk = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8")
      );
      expect(Object.keys(onDisk.features).sort()).toEqual(["Auth", "Home"]);
      expect(onDisk.features.Auth.description).toBe("updated description");
    });

    it("save_partial_snapshot sanitizes path-traversal attempts", async () => {
      await saveSnapshotPartial(tmpDir, "batch-000000", 0, {
        Bad: {
          description: "x",
          files: ["src/ok.ts", "../escape.ts", "/etc/passwd"],
        },
      }, {});

      const raw = await reduceSnapshot(tmpDir);
      const data = JSON.parse(raw);
      // The escape attempts should have been filtered out
      expect(data.prompt).toContain("src/ok.ts");
      expect(data.prompt).not.toContain("../escape.ts");
      expect(data.prompt).not.toContain("/etc/passwd");
    });

    it("save_snapshot persists feature type, defaulting a missing type to capability", async () => {
      await saveSnapshotData(tmpDir, {
        Checkout: { description: "checkout", files: ["src/checkout.ts"], type: "capability" },
        "Service wiring": { description: "DI container", files: ["src/container.ts"], type: "infrastructure" },
        Legacy: { description: "no type field", files: ["src/legacy.ts"] },
      }, {});

      const onDisk = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8")
      );
      expect(onDisk.features.Checkout.type).toBe("capability");
      expect(onDisk.features["Service wiring"].type).toBe("infrastructure");
      // A feature the model didn't classify defaults to capability (published).
      expect(onDisk.features.Legacy.type).toBe("capability");
    });

    it("save_partial_snapshot normalizes and stores feature type for reduce", async () => {
      await saveSnapshotPartial(tmpDir, "batch-000000", 0, {
        Auth: { description: "login", files: ["src/auth.ts"] },
        Logging: { description: "logger", files: ["src/log.ts"], type: "infrastructure" },
      }, {});

      const stored = JSON.parse(
        await fs.readFile(
          path.join(tmpDir, ".mason", "partial-snapshots", "batch-000000.json"),
          "utf-8"
        )
      );
      expect(stored.features.Auth.type).toBe("capability");
      expect(stored.features.Logging.type).toBe("infrastructure");
    });
  });

  describe("scoped refresh (generate_snapshot_batch with files)", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-scoped-test-"));
      await fs.mkdir(path.join(tmpDir, "src"));
      for (const name of ["a", "b", "c"]) {
        await fs.writeFile(
          path.join(tmpDir, "src", `${name}.ts`),
          `export const ${name} = 1;\n`
        );
      }
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("walks only the scoped files and records a scope marker", async () => {
      const raw = await generateSnapshotBatch(tmpDir, 0, 1, [
        "src/a.ts",
        "src/c.ts",
      ]);
      const data = JSON.parse(raw);

      expect(data.scoped).toBe(true);
      expect(data.totalFiles).toBe(2);
      expect(data.nextOffset).toBe(1);
      expect(data.prompt).toMatch(/src\/a\.ts/);
      expect(data.prompt).not.toMatch(/src\/b\.ts/);
      expect(data.next).toMatch(/files=/);

      const scopeRaw = await fs.readFile(
        path.join(tmpDir, ".mason", "partial-snapshots", "scope.json"),
        "utf-8"
      );
      expect(JSON.parse(scopeRaw).files).toEqual(["src/a.ts", "src/c.ts"]);
    });

    it("does not fall back to the full project when the scope matches nothing", async () => {
      const raw = await generateSnapshotBatch(tmpDir, 0, 50, [
        "../outside.ts",
        "src/missing.ts",
      ]);
      const data = JSON.parse(raw);

      expect(data.totalFiles).toBe(0);
      expect(data.next).toMatch(/None of the requested files/);
      // No scope marker for an empty scope
      await expect(
        fs.access(path.join(tmpDir, ".mason", "partial-snapshots", "scope.json"))
      ).rejects.toBeTruthy();
    });

    it("reduce_snapshot merges into the existing map when a scope marker exists", async () => {
      // Existing map with an entry outside the refresh scope
      await saveSnapshotData(tmpDir, {
        untouched: { description: "untouched feature", files: ["src/b.ts"] },
        drifted: { description: "old description", files: ["src/a.ts"] },
      }, {});

      // Scoped run over the drifted file
      await generateSnapshotBatch(tmpDir, 0, 50, ["src/a.ts"]);
      await saveSnapshotPartial(tmpDir, "batch-000000", 0, {
        drifted: { description: "new description", files: ["src/a.ts"] },
      }, {});

      const raw = await reduceSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.task).toMatch(/scoped refresh/i);
      expect(data.refreshedFiles).toBe(1);
      expect(data.instructions).toMatch(/copy them through UNCHANGED/);
      expect(data.prompt).toMatch(/EXISTING MAP/);
      expect(data.prompt).toMatch(/untouched feature/);
      expect(data.prompt).toMatch(/RE-ANALYZED FILES/);
      expect(data.next).toMatch(/save_snapshot/);
    });

    it("a full (unscoped) build clears a leftover scope marker", async () => {
      // Abandoned scoped run leaves a marker behind
      await generateSnapshotBatch(tmpDir, 0, 50, ["src/a.ts"]);
      await expect(
        fs.access(path.join(tmpDir, ".mason", "partial-snapshots", "scope.json"))
      ).resolves.toBeUndefined();

      // Full build must not inherit it
      await generateSnapshotBatch(tmpDir, 0, 50);
      await expect(
        fs.access(path.join(tmpDir, ".mason", "partial-snapshots", "scope.json"))
      ).rejects.toBeTruthy();
    });

    it("reduce_snapshot stays in full-rebuild mode without a scope marker", async () => {
      await saveSnapshotPartial(tmpDir, "batch-000000", 0, {
        Auth: { description: "x", files: ["src/a.ts"] },
      }, {});

      const raw = await reduceSnapshot(tmpDir);
      const data = JSON.parse(raw);

      expect(data.task).toMatch(/unified map/i);
      expect(data.prompt).not.toMatch(/EXISTING MAP/);
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
        { fetch: { description: "fetch", chain: ["src/a.ts"] } }
      );

      const raw = await saveSnapshotData(tmpDir, {}, {}, ["beta"], ["fetch"]);
      const data = JSON.parse(raw);
      expect(data.mode).toBe("merged");
      expect(data.removedFeatures).toBe(1);
      expect(data.removedFlows).toBe(1);

      const onDisk = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8")
      );
      expect(Object.keys(onDisk.features)).toEqual(["alpha"]);
      expect(onDisk.flows).toEqual({});
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
        {}
      );

      await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 2;\n");
      const secondHash = await commitAll("fix: bump a");

      // Incremental refresh of alpha only
      await saveSnapshotData(
        tmpDir,
        { alpha: { description: "alpha v2", files: ["src/a.ts"] } },
        {}
      );

      const onDisk = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".mason", "snapshot.json"), "utf-8")
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
      expect(data.playbook).toMatch(/PHASE 1 — Map/);
      expect(data.playbook).toMatch(/PHASE 2 — Reduce/);
      expect(data.playbook).toMatch(/mason_complete_init/);
    });

    it("playbook carries the CLAUDE.md section with markers", async () => {
      const raw = await masonInit(tmpDir);
      const data = JSON.parse(raw);

      expect(data.playbook).toMatch(/PHASE 4 — Assistant instructions/);
      expect(data.playbook).toContain("<!-- mason:start -->");
      expect(data.playbook).toContain("<!-- mason:end -->");
      expect(data.playbook).toMatch(/`get_context` with the task text/);
      // AGENTS.md is the tool-agnostic standard — the playbook must prefer it
      expect(data.playbook).toMatch(/`AGENTS\.md` exists → put the section there/);
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
