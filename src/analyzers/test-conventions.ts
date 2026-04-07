import fs from "node:fs/promises";
import path from "node:path";
import { BaseAnalyzer } from "./base.js";
import type { AnalyzerContext, AnalyzerResult, Finding, Gap } from "../types.js";

interface TestFramework {
  name: string;
  configFiles: string[];
  depNames: string[];
}

const FRAMEWORKS: TestFramework[] = [
  {
    name: "Vitest",
    configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"],
    depNames: ["vitest"],
  },
  {
    name: "Jest",
    configFiles: ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs"],
    depNames: ["jest", "ts-jest", "@jest/core"],
  },
  {
    name: "Mocha",
    configFiles: [".mocharc.yml", ".mocharc.yaml", ".mocharc.json", ".mocharc.js"],
    depNames: ["mocha"],
  },
  {
    name: "Playwright",
    configFiles: ["playwright.config.ts", "playwright.config.js"],
    depNames: ["@playwright/test"],
  },
  {
    name: "Cypress",
    configFiles: ["cypress.config.ts", "cypress.config.js"],
    depNames: ["cypress"],
  },
];

export class TestConventionsAnalyzer extends BaseAnalyzer {
  name = "test-conventions";

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    // Detect frameworks
    const detected = await this.detectFrameworks(context);

    if (detected.length === 0) {
      return this.createResult([], [], startTime);
    }

    if (detected.length === 1) {
      findings.push(
        this.createFinding({
          category: "convention",
          confidence: 0.95,
          summary: `Test framework: ${detected[0].name}`,
          evidence: [
            {
              filePath: detected[0].evidence,
              detail: `Detected via ${detected[0].via}`,
            },
          ],
          ruleCandidate: `Use ${detected[0].name} for testing. Run tests with the project's existing test script.`,
        })
      );
    } else {
      const names = detected.map((d) => d.name);
      findings.push(
        this.createFinding({
          category: "convention",
          confidence: 0.7,
          summary: `Multiple test frameworks detected: ${names.join(", ")}`,
          evidence: detected.map((d) => ({
            filePath: d.evidence,
            detail: `${d.name} detected via ${d.via}`,
          })),
          ruleCandidate: `This project uses multiple test frameworks: ${names.join(", ")}. Match the framework to the test location and type.`,
        })
      );

      if (detected.length === 2) {
        gaps.push({
          analyzer: this.name,
          question: `Found both ${names[0]} and ${names[1]}. Which is the primary test framework, or do they serve different purposes?`,
          context: detected
            .map((d) => `${d.name}: ${d.evidence} (${d.via})`)
            .join("; "),
          answerKey: "primary-test-framework",
        });
      }
    }

    // Detect test file locations
    const locationFinding = await this.detectTestLocations(context);
    if (locationFinding) {
      findings.push(locationFinding);
    }

    // Detect test patterns (describe/it vs test())
    const patternFinding = await this.detectTestPatterns(context);
    if (patternFinding) {
      findings.push(patternFinding);
    }

    // Coverage config
    const coverageFinding = await this.detectCoverage(context);
    if (coverageFinding) {
      findings.push(coverageFinding);
    }

    return this.createResult(findings, gaps, startTime);
  }

  private async detectFrameworks(
    context: AnalyzerContext
  ): Promise<Array<{ name: string; evidence: string; via: string }>> {
    const detected: Array<{ name: string; evidence: string; via: string }> = [];

    for (const fw of FRAMEWORKS) {
      // Check config files
      for (const configFile of fw.configFiles) {
        try {
          await fs.access(path.join(context.rootDir, configFile));
          detected.push({
            name: fw.name,
            evidence: configFile,
            via: "config file",
          });
          break;
        } catch {
          // Not found
        }
      }

      // Check package.json deps if not already found by config
      if (
        !detected.some((d) => d.name === fw.name) &&
        context.packageJson
      ) {
        const allDeps = {
          ...(context.packageJson.dependencies as Record<string, string> | undefined),
          ...(context.packageJson.devDependencies as Record<string, string> | undefined),
        };
        for (const dep of fw.depNames) {
          if (allDeps[dep]) {
            detected.push({
              name: fw.name,
              evidence: "package.json",
              via: `dependency "${dep}"`,
            });
            break;
          }
        }
      }
    }

    // Deduplicate by name
    const seen = new Set<string>();
    return detected.filter((d) => {
      if (seen.has(d.name)) return false;
      seen.add(d.name);
      return true;
    });
  }

  private async detectTestLocations(
    context: AnalyzerContext
  ): Promise<Finding | null> {
    const testFiles = await this.findFiles(
      [
        "**/*.test.{ts,tsx,js,jsx}",
        "**/*.spec.{ts,tsx,js,jsx}",
        "**/__tests__/**/*.{ts,tsx,js,jsx}",
        "**/test/**/*.{ts,tsx,js,jsx}",
        "**/tests/**/*.{ts,tsx,js,jsx}",
      ],
      context.rootDir
    );

    if (testFiles.length === 0) return null;

    const colocated = testFiles.filter(
      (f) =>
        f.includes(".test.") ||
        f.includes(".spec.") ||
        f.includes("__tests__")
    );
    const separated = testFiles.filter(
      (f) =>
        (f.includes("/test/") || f.includes("/tests/")) &&
        !f.includes("__tests__")
    );

    if (colocated.length > 0 && separated.length === 0) {
      return this.createFinding({
        category: "convention",
        confidence: 0.85,
        summary: `Tests are colocated with source (${colocated.length} test files)`,
        evidence: colocated.slice(0, 3).map((f) => ({
          filePath: path.relative(context.rootDir, f),
          detail: "colocated test",
        })),
        ruleCandidate:
          "Place test files next to the source files they test, using the `.test.ts` or `.spec.ts` suffix.",
      });
    }

    if (separated.length > 0 && colocated.length === 0) {
      return this.createFinding({
        category: "convention",
        confidence: 0.85,
        summary: `Tests are in a separate directory (${separated.length} test files)`,
        evidence: separated.slice(0, 3).map((f) => ({
          filePath: path.relative(context.rootDir, f),
          detail: "separated test",
        })),
        ruleCandidate:
          "Place test files in the `test/` or `tests/` directory, mirroring the source structure.",
      });
    }

    if (colocated.length > 0 && separated.length > 0) {
      return this.createFinding({
        category: "convention",
        confidence: 0.6,
        summary: `Mixed test locations: ${colocated.length} colocated, ${separated.length} in test directories`,
        evidence: [
          {
            filePath: "src",
            detail: `${colocated.length} colocated test files`,
          },
          {
            filePath: "test",
            detail: `${separated.length} separated test files`,
          },
        ],
        ruleCandidate:
          "This project uses both colocated tests and a separate test directory. Match the convention of nearby existing tests.",
      });
    }

    return null;
  }

  private async detectTestPatterns(
    context: AnalyzerContext
  ): Promise<Finding | null> {
    const testFiles = await this.findFiles(
      ["**/*.test.{ts,tsx,js,jsx}", "**/*.spec.{ts,tsx,js,jsx}"],
      context.rootDir
    );

    if (testFiles.length === 0) return null;

    const sampled = testFiles.slice(0, 30);
    let describeCount = 0;
    let plainTestCount = 0;

    for (const file of sampled) {
      try {
        const content = await this.readFile(file);
        if (/\bdescribe\s*\(/.test(content)) describeCount++;
        if (/\btest\s*\(/.test(content) && !/\bdescribe\s*\(/.test(content)) {
          plainTestCount++;
        }
      } catch {
        // Skip
      }
    }

    if (describeCount > plainTestCount && describeCount >= 3) {
      return this.createFinding({
        category: "convention",
        confidence: 0.75,
        summary: `Tests use describe/it block pattern (${describeCount} of ${sampled.length} files)`,
        evidence: [
          {
            filePath: "test files",
            detail: `${describeCount} files use describe blocks`,
          },
        ],
        ruleCandidate:
          "Use `describe` blocks to group related tests, with `it` or `test` for individual cases.",
      });
    }

    if (plainTestCount > describeCount && plainTestCount >= 3) {
      return this.createFinding({
        category: "convention",
        confidence: 0.75,
        summary: `Tests use flat test() pattern (${plainTestCount} of ${sampled.length} files)`,
        evidence: [
          {
            filePath: "test files",
            detail: `${plainTestCount} files use flat test() calls`,
          },
        ],
        ruleCandidate:
          "Use flat `test()` calls for test cases rather than nested describe/it blocks.",
      });
    }

    return null;
  }

  private async detectCoverage(
    context: AnalyzerContext
  ): Promise<Finding | null> {
    if (!context.packageJson) return null;

    const scripts = context.packageJson.scripts as Record<string, string> | undefined;
    if (!scripts) return null;

    const hasCoverageScript = Object.entries(scripts).some(
      ([key, val]) =>
        key.includes("coverage") ||
        (typeof val === "string" && val.includes("--coverage"))
    );

    if (hasCoverageScript) {
      return this.createFinding({
        category: "convention",
        confidence: 0.7,
        summary: "Coverage reporting is configured",
        evidence: [
          { filePath: "package.json", detail: "coverage script found" },
        ],
        ruleCandidate:
          "This project tracks test coverage. Ensure new code includes tests to maintain coverage.",
      });
    }

    return null;
  }
}
