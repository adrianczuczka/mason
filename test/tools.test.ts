import { describe, it, expect } from "vitest";
import {
  analyzeProject,
  getProjectStructure,
  getCodeSamples,
  fullAnalysis,
} from "../src/mcp/tools.js";
import { fixturePath } from "./helpers.js";

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
});
