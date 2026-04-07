#!/usr/bin/env node

// src/cli.ts
import { Command } from "commander";
import fs4 from "fs/promises";
import path3 from "path";
import ora from "ora";
import chalk2 from "chalk";

// src/analyzers/git-history.ts
import { execFile } from "child_process";
import { promisify } from "util";

// src/analyzers/base.ts
import fs from "fs/promises";
import fg from "fast-glob";
var BaseAnalyzer = class {
  async findFiles(patterns, root) {
    return fg(patterns, {
      cwd: root,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      absolute: true
    });
  }
  async readFile(filePath) {
    return fs.readFile(filePath, "utf-8");
  }
  createFinding(partial) {
    return {
      analyzer: this.name,
      category: partial.category,
      confidence: partial.confidence,
      summary: partial.summary,
      evidence: partial.evidence ?? [],
      ruleCandidate: partial.ruleCandidate ?? null
    };
  }
  createResult(findings, gaps, startTime) {
    return {
      analyzer: this.name,
      findings,
      gaps,
      durationMs: Date.now() - startTime
    };
  }
};

// src/analyzers/git-history.ts
var exec = promisify(execFile);
var GitHistoryAnalyzer = class extends BaseAnalyzer {
  name = "git-history";
  async analyze(context) {
    const startTime = Date.now();
    const findings = [];
    const gaps = [];
    if (!context.gitAvailable) {
      return this.createResult([], [], startTime);
    }
    const [staleFindings, staleGaps] = await this.findStaleDirectories(context);
    findings.push(...staleFindings);
    gaps.push(...staleGaps);
    const hotFindings = await this.findHotFiles(context);
    findings.push(...hotFindings);
    const commitFindings = await this.analyzeCommitPatterns(context);
    findings.push(...commitFindings);
    return this.createResult(findings, gaps, startTime);
  }
  async git(args, cwd) {
    try {
      const { stdout } = await exec("git", args, { cwd, maxBuffer: 1e7 });
      return stdout.trim();
    } catch {
      return "";
    }
  }
  async findStaleDirectories(context) {
    const findings = [];
    const gaps = [];
    const output = await this.git(
      ["log", "--all", "--format=%ci", "--name-only", "--diff-filter=AMCR", "-n", "500"],
      context.rootDir
    );
    if (!output) return [findings, gaps];
    const dirLastTouch = /* @__PURE__ */ new Map();
    let currentDate = null;
    for (const line of output.split("\n")) {
      if (!line) continue;
      if (/^\d{4}-\d{2}-\d{2}/.test(line)) {
        currentDate = new Date(line);
      } else if (currentDate) {
        const topDir = line.split("/")[0];
        if (topDir && !topDir.startsWith(".") && !topDir.includes("node_modules")) {
          const existing = dirLastTouch.get(topDir);
          if (!existing || currentDate > existing) {
            dirLastTouch.set(topDir, currentDate);
          }
        }
      }
    }
    const sixMonthsAgo = /* @__PURE__ */ new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    for (const [dir, lastTouch] of dirLastTouch) {
      if (lastTouch < sixMonthsAgo) {
        const monthsStale = Math.floor(
          (Date.now() - lastTouch.getTime()) / (1e3 * 60 * 60 * 24 * 30)
        );
        findings.push(
          this.createFinding({
            category: "risk",
            confidence: 0.7,
            summary: `Directory "${dir}" hasn't been modified in ${monthsStale} months`,
            evidence: [
              { filePath: dir, detail: `Last commit: ${lastTouch.toISOString().split("T")[0]}` }
            ],
            ruleCandidate: `Do not refactor or modify files in "${dir}/" unless explicitly asked \u2014 this area has been stable for ${monthsStale} months and may be legacy code.`
          })
        );
        gaps.push({
          analyzer: this.name,
          question: `Directory "${dir}" hasn't been touched in ${monthsStale} months. Is it deprecated, stable, or legacy?`,
          context: `Last modified: ${lastTouch.toISOString().split("T")[0]}`,
          answerKey: `stale-dir-${dir}`
        });
      }
    }
    return [findings, gaps];
  }
  async findHotFiles(context) {
    const findings = [];
    const output = await this.git(
      ["log", "--since=3 months ago", "--format=", "--name-only"],
      context.rootDir
    );
    if (!output) return findings;
    const fileCounts = /* @__PURE__ */ new Map();
    for (const line of output.split("\n")) {
      if (!line || line.startsWith(".") || line.includes("node_modules")) continue;
      fileCounts.set(line, (fileCounts.get(line) ?? 0) + 1);
    }
    const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (sorted.length > 0 && sorted[0][1] >= 5) {
      const hotFiles = sorted.filter(([, count]) => count >= 5);
      if (hotFiles.length > 0) {
        findings.push(
          this.createFinding({
            category: "risk",
            confidence: 0.8,
            summary: `${hotFiles.length} files changed frequently in the last 3 months`,
            evidence: hotFiles.map(([file, count]) => ({
              filePath: file,
              detail: `${count} commits`
            })),
            ruleCandidate: `These files change frequently and are high-risk for conflicts: ${hotFiles.map(([f]) => f).join(", ")}. Take extra care when modifying them.`
          })
        );
      }
    }
    return findings;
  }
  async analyzeCommitPatterns(context) {
    const findings = [];
    const output = await this.git(
      ["log", "--format=%s", "-n", "100"],
      context.rootDir
    );
    if (!output) return findings;
    const messages = output.split("\n").filter(Boolean);
    const conventionalPattern = /^(feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\(.+\))?:/;
    const conventionalCount = messages.filter(
      (m) => conventionalPattern.test(m)
    ).length;
    const conventionalRatio = conventionalCount / messages.length;
    if (conventionalRatio > 0.5) {
      findings.push(
        this.createFinding({
          category: "convention",
          confidence: Math.min(conventionalRatio + 0.1, 1),
          summary: `${Math.round(conventionalRatio * 100)}% of recent commits use conventional commit format`,
          evidence: [
            {
              filePath: ".git",
              detail: `${conventionalCount} of ${messages.length} commits match`
            }
          ],
          ruleCandidate: "Use conventional commit format: type(scope): description (e.g., feat(auth): add login endpoint)"
        })
      );
    }
    const ticketPattern = /[A-Z]+-\d+|#\d+/;
    const ticketCount = messages.filter((m) => ticketPattern.test(m)).length;
    const ticketRatio = ticketCount / messages.length;
    if (ticketRatio > 0.3) {
      findings.push(
        this.createFinding({
          category: "convention",
          confidence: ticketRatio,
          summary: `${Math.round(ticketRatio * 100)}% of commits reference issue/ticket IDs`,
          evidence: [
            {
              filePath: ".git",
              detail: `${ticketCount} of ${messages.length} commits have ticket refs`
            }
          ],
          ruleCandidate: "Include issue/ticket references in commit messages when applicable."
        })
      );
    }
    return findings;
  }
};

// src/analyzers/import-conventions.ts
import fs2 from "fs/promises";
import path from "path";
var IMPORT_REGEX = /^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?['"]([^'"]+)['"]/gm;
var REQUIRE_REGEX = /require\(['"]([^'"]+)['"]\)/g;
var ImportConventionsAnalyzer = class extends BaseAnalyzer {
  name = "import-conventions";
  async analyze(context) {
    const startTime = Date.now();
    const findings = [];
    const gaps = [];
    const files = await this.findFiles(
      ["**/*.{ts,tsx,js,jsx,mts,mjs}"],
      context.rootDir
    );
    if (files.length === 0) {
      return this.createResult([], [], startTime);
    }
    const sampled = files.length > 300 ? sampleEvenly(files, 300) : files;
    const aliases = await this.detectAliases(context.rootDir);
    const stats = await this.collectImportStats(sampled, aliases);
    if (stats.totalImports > 10 && aliases.size > 0) {
      const aliasRatio = stats.aliasImports / stats.totalImports;
      if (aliasRatio > 0.5) {
        findings.push(
          this.createFinding({
            category: "convention",
            confidence: Math.min(aliasRatio + 0.1, 1),
            summary: `${Math.round(aliasRatio * 100)}% of imports use path aliases (${[...aliases].join(", ")})`,
            evidence: [
              {
                filePath: "tsconfig.json",
                detail: `${stats.aliasImports} alias vs ${stats.relativeImports} relative imports`
              }
            ],
            ruleCandidate: `Use path aliases (${[...aliases].join(", ")}) for imports instead of relative paths.`
          })
        );
      } else if (aliasRatio < 0.3 && aliasRatio > 0) {
        gaps.push({
          analyzer: this.name,
          question: `Path aliases (${[...aliases].join(", ")}) are configured but only used in ${Math.round(aliasRatio * 100)}% of imports. Should all imports use aliases?`,
          context: `${stats.aliasImports} alias imports vs ${stats.relativeImports} relative imports`,
          answerKey: "import-alias-preference"
        });
      }
    }
    const barrelFiles = await this.findFiles(
      ["**/index.{ts,tsx,js,jsx}"],
      context.rootDir
    );
    if (barrelFiles.length > 3) {
      const barrelRatio = stats.barrelImports / stats.totalImports;
      if (barrelRatio > 0.2) {
        findings.push(
          this.createFinding({
            category: "convention",
            confidence: 0.75,
            summary: `${barrelFiles.length} barrel files (index.ts) found, ${Math.round(barrelRatio * 100)}% of imports use them`,
            evidence: barrelFiles.slice(0, 5).map((f) => ({
              filePath: path.relative(context.rootDir, f),
              detail: "barrel file"
            })),
            ruleCandidate: `Import from barrel files (index.ts) when available rather than reaching into internal module files.`
          })
        );
      }
    }
    if (stats.typeImports > 5) {
      const typeRatio = stats.typeImports / stats.totalImports;
      if (typeRatio > 0.1) {
        findings.push(
          this.createFinding({
            category: "convention",
            confidence: 0.8,
            summary: `${Math.round(typeRatio * 100)}% of imports use \`import type\` syntax`,
            evidence: [
              {
                filePath: "src",
                detail: `${stats.typeImports} type-only imports found`
              }
            ],
            ruleCandidate: "Use `import type` for type-only imports to enable better tree-shaking and make the intent clear."
          })
        );
      }
    }
    const orderingFinding = await this.detectImportOrdering(sampled.slice(0, 50), context.rootDir);
    if (orderingFinding) {
      findings.push(orderingFinding);
    }
    return this.createResult(findings, gaps, startTime);
  }
  async detectAliases(rootDir) {
    const aliases = /* @__PURE__ */ new Set();
    try {
      const raw = await fs2.readFile(
        path.join(rootDir, "tsconfig.json"),
        "utf-8"
      );
      const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const tsconfig = JSON.parse(cleaned);
      const paths = tsconfig.compilerOptions?.paths;
      if (paths) {
        for (const key of Object.keys(paths)) {
          aliases.add(key.replace("/*", ""));
        }
      }
    } catch {
    }
    return aliases;
  }
  async collectImportStats(files, aliases) {
    const stats = {
      aliasImports: 0,
      relativeImports: 0,
      barrelImports: 0,
      totalImports: 0,
      aliases,
      typeImports: 0
    };
    for (const file of files) {
      try {
        const content = await this.readFile(file);
        const lines = content.split("\n");
        for (const line of lines) {
          if (/^import\s+type\s+/.test(line)) {
            stats.typeImports++;
          }
          IMPORT_REGEX.lastIndex = 0;
          const importMatch = IMPORT_REGEX.exec(line);
          if (importMatch) {
            const importPath = importMatch[1];
            stats.totalImports++;
            this.classifyImport(importPath, stats);
            continue;
          }
          REQUIRE_REGEX.lastIndex = 0;
          const requireMatch = REQUIRE_REGEX.exec(line);
          if (requireMatch) {
            const importPath = requireMatch[1];
            stats.totalImports++;
            this.classifyImport(importPath, stats);
          }
        }
      } catch {
      }
    }
    return stats;
  }
  classifyImport(importPath, stats) {
    if (importPath.startsWith(".")) {
      stats.relativeImports++;
      if (!path.extname(importPath) && !importPath.endsWith("/index")) {
        stats.barrelImports++;
      }
    } else {
      for (const alias of stats.aliases) {
        if (importPath === alias || importPath.startsWith(alias + "/")) {
          stats.aliasImports++;
          return;
        }
      }
    }
  }
  async detectImportOrdering(files, rootDir) {
    let thirdPartyFirstCount = 0;
    let localFirstCount = 0;
    let filesWithMultipleImports = 0;
    for (const file of files) {
      try {
        const content = await this.readFile(file);
        const importPaths = [];
        IMPORT_REGEX.lastIndex = 0;
        let match;
        while ((match = IMPORT_REGEX.exec(content)) !== null) {
          importPaths.push(match[1]);
        }
        if (importPaths.length < 2) continue;
        filesWithMultipleImports++;
        const firstLocal = importPaths.findIndex((p) => p.startsWith("."));
        const firstExternal = importPaths.findIndex((p) => !p.startsWith("."));
        if (firstLocal >= 0 && firstExternal >= 0) {
          if (firstExternal < firstLocal) {
            thirdPartyFirstCount++;
          } else {
            localFirstCount++;
          }
        }
      } catch {
      }
    }
    if (filesWithMultipleImports < 5) return null;
    const total = thirdPartyFirstCount + localFirstCount;
    if (total === 0) return null;
    const thirdPartyFirstRatio = thirdPartyFirstCount / total;
    if (thirdPartyFirstRatio > 0.7) {
      return this.createFinding({
        category: "convention",
        confidence: thirdPartyFirstRatio,
        summary: `${Math.round(thirdPartyFirstRatio * 100)}% of files order third-party imports before local imports`,
        evidence: [
          {
            filePath: rootDir,
            detail: `${thirdPartyFirstCount} of ${total} files with mixed imports`
          }
        ],
        ruleCandidate: "Order imports with third-party/external packages first, then local/relative imports."
      });
    }
    return null;
  }
};
function sampleEvenly(files, count) {
  const step = Math.floor(files.length / count);
  const sampled = [];
  for (let i = 0; i < files.length && sampled.length < count; i += step) {
    sampled.push(files[i]);
  }
  return sampled;
}

// src/analyzers/test-conventions.ts
import fs3 from "fs/promises";
import path2 from "path";
var FRAMEWORKS = [
  {
    name: "Vitest",
    configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"],
    depNames: ["vitest"]
  },
  {
    name: "Jest",
    configFiles: ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs"],
    depNames: ["jest", "ts-jest", "@jest/core"]
  },
  {
    name: "Mocha",
    configFiles: [".mocharc.yml", ".mocharc.yaml", ".mocharc.json", ".mocharc.js"],
    depNames: ["mocha"]
  },
  {
    name: "Playwright",
    configFiles: ["playwright.config.ts", "playwright.config.js"],
    depNames: ["@playwright/test"]
  },
  {
    name: "Cypress",
    configFiles: ["cypress.config.ts", "cypress.config.js"],
    depNames: ["cypress"]
  }
];
var TestConventionsAnalyzer = class extends BaseAnalyzer {
  name = "test-conventions";
  async analyze(context) {
    const startTime = Date.now();
    const findings = [];
    const gaps = [];
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
              detail: `Detected via ${detected[0].via}`
            }
          ],
          ruleCandidate: `Use ${detected[0].name} for testing. Run tests with the project's existing test script.`
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
            detail: `${d.name} detected via ${d.via}`
          })),
          ruleCandidate: `This project uses multiple test frameworks: ${names.join(", ")}. Match the framework to the test location and type.`
        })
      );
      if (detected.length === 2) {
        gaps.push({
          analyzer: this.name,
          question: `Found both ${names[0]} and ${names[1]}. Which is the primary test framework, or do they serve different purposes?`,
          context: detected.map((d) => `${d.name}: ${d.evidence} (${d.via})`).join("; "),
          answerKey: "primary-test-framework"
        });
      }
    }
    const locationFinding = await this.detectTestLocations(context);
    if (locationFinding) {
      findings.push(locationFinding);
    }
    const patternFinding = await this.detectTestPatterns(context);
    if (patternFinding) {
      findings.push(patternFinding);
    }
    const coverageFinding = await this.detectCoverage(context);
    if (coverageFinding) {
      findings.push(coverageFinding);
    }
    return this.createResult(findings, gaps, startTime);
  }
  async detectFrameworks(context) {
    const detected = [];
    for (const fw of FRAMEWORKS) {
      for (const configFile of fw.configFiles) {
        try {
          await fs3.access(path2.join(context.rootDir, configFile));
          detected.push({
            name: fw.name,
            evidence: configFile,
            via: "config file"
          });
          break;
        } catch {
        }
      }
      if (!detected.some((d) => d.name === fw.name) && context.packageJson) {
        const allDeps = {
          ...context.packageJson.dependencies,
          ...context.packageJson.devDependencies
        };
        for (const dep of fw.depNames) {
          if (allDeps[dep]) {
            detected.push({
              name: fw.name,
              evidence: "package.json",
              via: `dependency "${dep}"`
            });
            break;
          }
        }
      }
    }
    const seen = /* @__PURE__ */ new Set();
    return detected.filter((d) => {
      if (seen.has(d.name)) return false;
      seen.add(d.name);
      return true;
    });
  }
  async detectTestLocations(context) {
    const testFiles = await this.findFiles(
      [
        "**/*.test.{ts,tsx,js,jsx}",
        "**/*.spec.{ts,tsx,js,jsx}",
        "**/__tests__/**/*.{ts,tsx,js,jsx}",
        "**/test/**/*.{ts,tsx,js,jsx}",
        "**/tests/**/*.{ts,tsx,js,jsx}"
      ],
      context.rootDir
    );
    if (testFiles.length === 0) return null;
    const colocated = testFiles.filter(
      (f) => f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__")
    );
    const separated = testFiles.filter(
      (f) => (f.includes("/test/") || f.includes("/tests/")) && !f.includes("__tests__")
    );
    if (colocated.length > 0 && separated.length === 0) {
      return this.createFinding({
        category: "convention",
        confidence: 0.85,
        summary: `Tests are colocated with source (${colocated.length} test files)`,
        evidence: colocated.slice(0, 3).map((f) => ({
          filePath: path2.relative(context.rootDir, f),
          detail: "colocated test"
        })),
        ruleCandidate: "Place test files next to the source files they test, using the `.test.ts` or `.spec.ts` suffix."
      });
    }
    if (separated.length > 0 && colocated.length === 0) {
      return this.createFinding({
        category: "convention",
        confidence: 0.85,
        summary: `Tests are in a separate directory (${separated.length} test files)`,
        evidence: separated.slice(0, 3).map((f) => ({
          filePath: path2.relative(context.rootDir, f),
          detail: "separated test"
        })),
        ruleCandidate: "Place test files in the `test/` or `tests/` directory, mirroring the source structure."
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
            detail: `${colocated.length} colocated test files`
          },
          {
            filePath: "test",
            detail: `${separated.length} separated test files`
          }
        ],
        ruleCandidate: "This project uses both colocated tests and a separate test directory. Match the convention of nearby existing tests."
      });
    }
    return null;
  }
  async detectTestPatterns(context) {
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
            detail: `${describeCount} files use describe blocks`
          }
        ],
        ruleCandidate: "Use `describe` blocks to group related tests, with `it` or `test` for individual cases."
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
            detail: `${plainTestCount} files use flat test() calls`
          }
        ],
        ruleCandidate: "Use flat `test()` calls for test cases rather than nested describe/it blocks."
      });
    }
    return null;
  }
  async detectCoverage(context) {
    if (!context.packageJson) return null;
    const scripts = context.packageJson.scripts;
    if (!scripts) return null;
    const hasCoverageScript = Object.entries(scripts).some(
      ([key, val]) => key.includes("coverage") || typeof val === "string" && val.includes("--coverage")
    );
    if (hasCoverageScript) {
      return this.createFinding({
        category: "convention",
        confidence: 0.7,
        summary: "Coverage reporting is configured",
        evidence: [
          { filePath: "package.json", detail: "coverage script found" }
        ],
        ruleCandidate: "This project tracks test coverage. Ensure new code includes tests to maintain coverage."
      });
    }
    return null;
  }
};

// src/analyzers/index.ts
var analyzers = [
  new GitHistoryAnalyzer(),
  new ImportConventionsAnalyzer(),
  new TestConventionsAnalyzer()
];
async function runAll(context) {
  return Promise.all(analyzers.map((a) => a.analyze(context)));
}

// src/utils/git.ts
import { execFile as execFile2 } from "child_process";
import { promisify as promisify2 } from "util";
var exec2 = promisify2(execFile2);
async function isGitRepo(dir) {
  try {
    await exec2("git", ["rev-parse", "--git-dir"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

// src/generator/rules.ts
var CONFIDENCE_THRESHOLD = 0.6;
var CATEGORY_TO_SECTION = {
  convention: "Code Conventions",
  boundary: "Architecture",
  risk: "Areas of Note",
  pattern: "Code Conventions"
};
function generateRules(results, _answers) {
  const rules = [];
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.confidence < CONFIDENCE_THRESHOLD) continue;
      if (!finding.ruleCandidate) continue;
      rules.push({
        section: CATEGORY_TO_SECTION[finding.category] ?? "General",
        text: finding.ruleCandidate,
        source: finding.analyzer,
        priority: finding.confidence
      });
    }
  }
  return deduplicateRules(rules);
}
function deduplicateRules(rules) {
  const seen = /* @__PURE__ */ new Map();
  for (const rule of rules) {
    const key = rule.text.toLowerCase().slice(0, 50);
    const existing = seen.get(key);
    if (!existing || rule.priority > existing.priority) {
      seen.set(key, rule);
    }
  }
  return [...seen.values()];
}

// src/generator/renderer.ts
function renderClaude(rules) {
  const sections = /* @__PURE__ */ new Map();
  for (const rule of rules) {
    const existing = sections.get(rule.section) ?? [];
    existing.push(rule);
    sections.set(rule.section, existing);
  }
  for (const rules2 of sections.values()) {
    rules2.sort((a, b) => b.priority - a.priority);
  }
  const lines = [
    "# CLAUDE.md",
    `<!-- Generated by foreman-context. Last updated: ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]} -->`,
    `<!-- To regenerate: npx foreman-context update -->`,
    ""
  ];
  for (const [section, sectionRules] of sections) {
    lines.push(`## ${section}`, "");
    for (const rule of sectionRules) {
      lines.push(`- ${rule.text} <!-- source: ${rule.source} -->`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// src/utils/logger.ts
import chalk from "chalk";
var verbose = false;
function success(msg) {
  console.log(chalk.green("\u2714"), msg);
}
function warn(msg) {
  console.log(chalk.yellow("\u26A0"), msg);
}
function debug(msg) {
  if (verbose) {
    console.log(chalk.gray("\u22EF"), msg);
  }
}

// src/cli.ts
async function buildContext(dir) {
  let packageJson = null;
  try {
    const raw = await fs4.readFile(path3.join(dir, "package.json"), "utf-8");
    packageJson = JSON.parse(raw);
  } catch {
  }
  return {
    rootDir: dir,
    packageJson,
    gitAvailable: await isGitRepo(dir),
    previousAnswers: /* @__PURE__ */ new Map()
  };
}
function printFindings(results) {
  for (const result of results) {
    if (result.findings.length === 0) {
      debug(`${result.analyzer}: no findings`);
      continue;
    }
    console.log(
      chalk2.bold(`
\u{1F4CB} ${result.analyzer}`) + chalk2.gray(` (${result.durationMs}ms)`)
    );
    for (const finding of result.findings) {
      const conf = chalk2.gray(`[${Math.round(finding.confidence * 100)}%]`);
      console.log(`  ${conf} ${finding.summary}`);
      for (const ev of finding.evidence) {
        console.log(chalk2.gray(`       ${ev.filePath}: ${ev.detail}`));
      }
    }
  }
}
function createCLI() {
  const program = new Command();
  program.name("foreman").description(
    "Context engineering CLI \u2014 generates intelligent CLAUDE.md files"
  ).version("0.1.0");
  program.command("analyze").description("Analyze the codebase and print findings").argument("[dir]", "Directory to analyze", ".").action(async (dir) => {
    const rootDir = path3.resolve(dir);
    const spinner = ora("Analyzing codebase...").start();
    const context = await buildContext(rootDir);
    const results = await runAll(context);
    spinner.stop();
    printFindings(results);
    const totalFindings = results.reduce(
      (sum, r) => sum + r.findings.length,
      0
    );
    console.log(
      chalk2.bold(`
${totalFindings} findings from ${results.length} analyzers`)
    );
  });
  program.command("init").description("Analyze codebase and generate CLAUDE.md").argument("[dir]", "Directory to analyze", ".").action(async (dir) => {
    const rootDir = path3.resolve(dir);
    const spinner = ora("Analyzing codebase...").start();
    const context = await buildContext(rootDir);
    const results = await runAll(context);
    spinner.stop();
    printFindings(results);
    const answers = /* @__PURE__ */ new Map();
    const rules = generateRules(results, answers);
    if (rules.length === 0) {
      warn("No rules generated \u2014 not enough patterns detected.");
      return;
    }
    const markdown = renderClaude(rules);
    const outPath = path3.join(rootDir, "CLAUDE.md");
    await fs4.writeFile(outPath, markdown, "utf-8");
    success(`Generated ${outPath} with ${rules.length} rules`);
  });
  program.command("update").description("Re-analyze and update existing CLAUDE.md").argument("[dir]", "Directory to analyze", ".").action(async (_dir) => {
    warn("Update command not yet implemented \u2014 use `foreman init` for now.");
  });
  return program;
}
export {
  createCLI
};
//# sourceMappingURL=cli.js.map