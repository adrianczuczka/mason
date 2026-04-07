import { describe, it, expect } from "vitest";
import { sampleFiles } from "../src/mcp/sampler.js";
import { fixturePath } from "./helpers.js";

function reasons(files: Awaited<ReturnType<typeof sampleFiles>>): string[] {
  return files.map((f) => f.reason);
}

function paths(files: Awaited<ReturnType<typeof sampleFiles>>): string[] {
  return files.map((f) => f.path);
}

describe("sampler", () => {
  describe("node-react fixture", () => {
    it("selects config files", async () => {
      const files = await sampleFiles(fixturePath("node-react"));
      const configs = files.filter((f) => f.reason === "config file");
      const configPaths = configs.map((f) => f.path);
      expect(configPaths).toContain("package.json");
      expect(configPaths).toContain("tsconfig.json");
    });

    it("selects entry points", async () => {
      const files = await sampleFiles(fixturePath("node-react"));
      const p = paths(files);
      expect(p).toContain("src/index.tsx");
    });

    it("selects architectural patterns", async () => {
      const files = await sampleFiles(fixturePath("node-react"));
      const r = reasons(files);
      expect(r.some((reason) => reason.includes("store"))).toBe(true);
      expect(r.some((reason) => reason.includes("service") || reason.includes("client"))).toBe(true);
    });

    it("selects test examples", async () => {
      const files = await sampleFiles(fixturePath("node-react"));
      const tests = files.filter((f) => f.reason.includes("test example"));
      expect(tests.length).toBeGreaterThanOrEqual(1);
    });

    it("returns previews not full content", async () => {
      const files = await sampleFiles(fixturePath("node-react"));
      for (const file of files) {
        expect(file).toHaveProperty("preview");
        expect(file).toHaveProperty("totalLines");
        expect(file).toHaveProperty("sizeBytes");
        expect(file).not.toHaveProperty("content");
      }
    });
  });

  describe("kotlin-multiplatform fixture", () => {
    it("selects gradle config files", async () => {
      const files = await sampleFiles(fixturePath("kotlin-multiplatform"));
      const configPaths = files
        .filter((f) => f.reason === "config file")
        .map((f) => f.path);
      expect(configPaths).toContain("build.gradle.kts");
      expect(configPaths).toContain("settings.gradle.kts");
      expect(configPaths).toContain("gradle/libs.versions.toml");
    });

    it("selects module build files", async () => {
      const files = await sampleFiles(fixturePath("kotlin-multiplatform"));
      const moduleBuildFiles = files.filter((f) =>
        f.reason.includes("module build file")
      );
      expect(moduleBuildFiles.length).toBeGreaterThanOrEqual(1);
      // Should be subdirectory build files, not root
      for (const f of moduleBuildFiles) {
        expect(f.path).toContain("/");
      }
    });

    it("selects both repository interface and implementation", async () => {
      const files = await sampleFiles(fixturePath("kotlin-multiplatform"));
      const p = paths(files);
      expect(p.some((path) => path.includes("WeatherRepository.kt"))).toBe(true);
      expect(p.some((path) => path.includes("WeatherRepositoryImpl.kt"))).toBe(true);
    });

    it("selects viewmodel", async () => {
      const files = await sampleFiles(fixturePath("kotlin-multiplatform"));
      const r = reasons(files);
      expect(r.some((reason) => reason.includes("viewmodel"))).toBe(true);
    });

    it("selects DI module", async () => {
      const files = await sampleFiles(fixturePath("kotlin-multiplatform"));
      const r = reasons(files);
      expect(r.some((reason) => reason.includes("DI") || reason.includes("module"))).toBe(true);
    });

    it("selects mapper", async () => {
      const files = await sampleFiles(fixturePath("kotlin-multiplatform"));
      const r = reasons(files);
      expect(r.some((reason) => reason.includes("mapper"))).toBe(true);
    });

    it("selects diverse test examples", async () => {
      const files = await sampleFiles(fixturePath("kotlin-multiplatform"));
      const tests = files.filter((f) => f.reason.includes("test example"));
      const testReasons = tests.map((t) => t.reason);
      expect(testReasons.some((r) => r.includes("JVM"))).toBe(true);
      expect(testReasons.some((r) => r.includes("Swift"))).toBe(true);
    });
  });

  describe("python-django fixture", () => {
    it("selects python config files", async () => {
      const files = await sampleFiles(fixturePath("python-django"));
      const configPaths = files
        .filter((f) => f.reason === "config file")
        .map((f) => f.path);
      expect(configPaths).toContain("pyproject.toml");
    });

    it("selects service and repository", async () => {
      const files = await sampleFiles(fixturePath("python-django"));
      const r = reasons(files);
      expect(r.some((reason) => reason.includes("service"))).toBe(true);
      expect(r.some((reason) => reason.includes("repository"))).toBe(true);
    });

    it("selects middleware", async () => {
      const files = await sampleFiles(fixturePath("python-django"));
      const r = reasons(files);
      expect(r.some((reason) => reason.includes("middleware"))).toBe(true);
    });

    it("selects python test examples", async () => {
      const files = await sampleFiles(fixturePath("python-django"));
      const tests = files.filter((f) => f.reason.includes("test example"));
      expect(tests.length).toBeGreaterThanOrEqual(1);
      expect(tests.some((t) => t.reason.includes("Python"))).toBe(true);
    });
  });

  describe("go-api fixture", () => {
    it("selects go config files", async () => {
      const files = await sampleFiles(fixturePath("go-api"));
      const configPaths = files
        .filter((f) => f.reason === "config file")
        .map((f) => f.path);
      expect(configPaths).toContain("go.mod");
    });

    it("selects entry point", async () => {
      const files = await sampleFiles(fixturePath("go-api"));
      const p = paths(files);
      expect(p).toContain("main.go");
    });

    it("selects handler, service, repository", async () => {
      const files = await sampleFiles(fixturePath("go-api"));
      const r = reasons(files);
      expect(r.some((reason) => reason.includes("handler") || reason.includes("controller"))).toBe(true);
      expect(r.some((reason) => reason.includes("service"))).toBe(true);
      expect(r.some((reason) => reason.includes("repository"))).toBe(true);
    });

    it("selects go test examples", async () => {
      const files = await sampleFiles(fixturePath("go-api"));
      const tests = files.filter((f) => f.reason.includes("test example"));
      expect(tests.length).toBeGreaterThanOrEqual(1);
      expect(tests.some((t) => t.reason.includes("Go"))).toBe(true);
    });
  });

  describe("rust-workspace fixture", () => {
    it("selects Cargo.toml", async () => {
      const files = await sampleFiles(fixturePath("rust-workspace"));
      const configPaths = files
        .filter((f) => f.reason === "config file")
        .map((f) => f.path);
      expect(configPaths).toContain("Cargo.toml");
    });

    it("selects module build files (sub Cargo.toml)", async () => {
      const files = await sampleFiles(fixturePath("rust-workspace"));
      const moduleBuildFiles = files.filter((f) =>
        f.reason.includes("module build file")
      );
      expect(moduleBuildFiles.length).toBeGreaterThanOrEqual(1);
    });

    it("selects entry point or directory representatives", async () => {
      const files = await sampleFiles(fixturePath("rust-workspace"));
      const p = paths(files);
      // Should include lib.rs or main.rs as entry points
      expect(
        p.some((path) => path.includes("main.rs") || path.includes("lib.rs"))
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles empty directory", async () => {
      const files = await sampleFiles(fixturePath("empty"));
      expect(files).toEqual([]);
    });

    it("handles minimal directory", async () => {
      const files = await sampleFiles(fixturePath("minimal"));
      expect(files.length).toBeGreaterThanOrEqual(0);
      // Should not crash
    });

    it("respects maxFiles limit", async () => {
      const files = await sampleFiles(fixturePath("kotlin-multiplatform"), 5);
      expect(files.length).toBeLessThanOrEqual(5);
    });
  });
});
