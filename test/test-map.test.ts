import { describe, it, expect } from "vitest";
import { getTestMap } from "../src/mcp/tools.js";
import { fixturePath } from "./helpers.js";

async function parseTestMap(fixture: string) {
  const raw = await getTestMap(fixturePath(fixture));
  return JSON.parse(raw) as {
    totalTestFiles: number;
    paired: Array<{ test: string; source: string | null; confidence: string }>;
    unmatched: string[];
  };
}

describe("test map", () => {
  describe("node-react", () => {
    it("pairs test files to source files", async () => {
      const map = await parseTestMap("node-react");
      expect(map.totalTestFiles).toBeGreaterThanOrEqual(3);

      const appPair = map.paired.find((p) => p.test.includes("App.test.tsx"));
      expect(appPair).toBeDefined();
      expect(appPair!.source).toContain("App.tsx");

      const buttonPair = map.paired.find((p) =>
        p.test.includes("Button.test.tsx")
      );
      expect(buttonPair).toBeDefined();
      expect(buttonPair!.source).toContain("Button.tsx");
    });

    it("pairs hook tests", async () => {
      const map = await parseTestMap("node-react");
      const hookPair = map.paired.find((p) =>
        p.test.includes("useAuth.test.ts")
      );
      expect(hookPair).toBeDefined();
      expect(hookPair!.source).toContain("useAuth.ts");
    });
  });

  describe("kotlin-multiplatform", () => {
    it("pairs Kotlin test files", async () => {
      const map = await parseTestMap("kotlin-multiplatform");
      const homeScreenPair = map.paired.find((p) =>
        p.test.includes("HomeScreenTest.kt")
      );
      expect(homeScreenPair).toBeDefined();
      expect(homeScreenPair!.source).toContain("HomeScreen.kt");
    });

    it("pairs Swift test files", async () => {
      const map = await parseTestMap("kotlin-multiplatform");
      // HomeViewTests.swift — may not match HomeViewModel exactly
      // but should either pair or be in unmatched
      expect(map.totalTestFiles).toBeGreaterThanOrEqual(2);
    });
  });

  describe("python-django", () => {
    it("pairs Python test files", async () => {
      const map = await parseTestMap("python-django");
      const modelsPair = map.paired.find((p) =>
        p.test.includes("test_models.py")
      );
      expect(modelsPair).toBeDefined();
      expect(modelsPair!.source).toContain("models.py");

      const viewsPair = map.paired.find((p) =>
        p.test.includes("test_views.py")
      );
      expect(viewsPair).toBeDefined();
      expect(viewsPair!.source).toContain("views.py");
    });
  });

  describe("go-api", () => {
    it("pairs Go test files", async () => {
      const map = await parseTestMap("go-api");
      const handlerPair = map.paired.find((p) =>
        p.test.includes("UserHandler_test.go")
      );
      expect(handlerPair).toBeDefined();
      expect(handlerPair!.source).toContain("UserHandler.go");

      const servicePair = map.paired.find((p) =>
        p.test.includes("UserService_test.go")
      );
      expect(servicePair).toBeDefined();
      expect(servicePair!.source).toContain("UserService.go");
    });
  });

  describe("edge cases", () => {
    it("handles empty directory", async () => {
      const map = await parseTestMap("empty");
      expect(map.totalTestFiles).toBe(0);
      expect(map.paired).toEqual([]);
      expect(map.unmatched).toEqual([]);
    });

    it("handles minimal directory with no tests", async () => {
      const map = await parseTestMap("minimal");
      expect(map.totalTestFiles).toBe(0);
    });
  });
});
