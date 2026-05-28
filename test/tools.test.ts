import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  analyzeProject,
  getProjectStructure,
  getCodeSamples,
  fullAnalysis,
  generateSnapshot,
  getSnapshot,
  masonInit,
  masonCompleteInit,
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
    });
  });

  describe("generateSnapshot", () => {
    // generate_snapshot and save_snapshot are intentionally not gated on init —
    // they're invoked by the init playbook itself.
    it("returns the system prompt and a prompt body with file content", async () => {
      const raw = await generateSnapshot(fixturePath("node-react"));
      const data = JSON.parse(raw);

      expect(typeof data.task).toBe("string");
      expect(typeof data.instructions).toBe("string");
      expect(data.instructions).toMatch(/concept-to-files map/i);
      expect(typeof data.prompt).toBe("string");
      expect(data.prompt.length).toBeGreaterThan(0);
      expect(data.next).toMatch(/save_snapshot/);
    });

    it("handles empty projects without erroring", async () => {
      const raw = await generateSnapshot(fixturePath("empty"));
      const data = JSON.parse(raw);

      expect(typeof data.instructions).toBe("string");
      expect(data.prompt).toBe("(No source files found to map.)");
      expect(data.next).toMatch(/Do not call save_snapshot/);
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
      expect(data.playbook).toMatch(/SECTION 1 — concept map/);
      expect(data.playbook).toMatch(/mason_complete_init/);
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
