import fs from "node:fs/promises";
import path from "node:path";
import { BaseAnalyzer } from "./base.js";
import type { AnalyzerContext, AnalyzerResult, Finding, Gap } from "../types.js";

const IMPORT_REGEX = /^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?['"]([^'"]+)['"]/gm;
const REQUIRE_REGEX = /require\(['"]([^'"]+)['"]\)/g;

interface ImportStats {
  aliasImports: number;
  relativeImports: number;
  barrelImports: number;
  totalImports: number;
  aliases: Set<string>;
  typeImports: number;
}

export class ImportConventionsAnalyzer extends BaseAnalyzer {
  name = "import-conventions";

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    const files = await this.findFiles(
      ["**/*.{ts,tsx,js,jsx,mts,mjs}"],
      context.rootDir
    );

    if (files.length === 0) {
      return this.createResult([], [], startTime);
    }

    // Sample if too many files
    const sampled = files.length > 300 ? sampleEvenly(files, 300) : files;

    const aliases = await this.detectAliases(context.rootDir);
    const stats = await this.collectImportStats(sampled, aliases);

    // Alias vs relative imports
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
                detail: `${stats.aliasImports} alias vs ${stats.relativeImports} relative imports`,
              },
            ],
            ruleCandidate: `Use path aliases (${[...aliases].join(", ")}) for imports instead of relative paths.`,
          })
        );
      } else if (aliasRatio < 0.3 && aliasRatio > 0) {
        gaps.push({
          analyzer: this.name,
          question: `Path aliases (${[...aliases].join(", ")}) are configured but only used in ${Math.round(aliasRatio * 100)}% of imports. Should all imports use aliases?`,
          context: `${stats.aliasImports} alias imports vs ${stats.relativeImports} relative imports`,
          answerKey: "import-alias-preference",
        });
      }
    }

    // Barrel file detection
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
              detail: "barrel file",
            })),
            ruleCandidate: `Import from barrel files (index.ts) when available rather than reaching into internal module files.`,
          })
        );
      }
    }

    // Type-only imports
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
                detail: `${stats.typeImports} type-only imports found`,
              },
            ],
            ruleCandidate:
              "Use `import type` for type-only imports to enable better tree-shaking and make the intent clear.",
          })
        );
      }
    }

    // Import ordering detection
    const orderingFinding = await this.detectImportOrdering(sampled.slice(0, 50), context.rootDir);
    if (orderingFinding) {
      findings.push(orderingFinding);
    }

    return this.createResult(findings, gaps, startTime);
  }

  private async detectAliases(rootDir: string): Promise<Set<string>> {
    const aliases = new Set<string>();
    try {
      const raw = await fs.readFile(
        path.join(rootDir, "tsconfig.json"),
        "utf-8"
      );
      // Strip comments for JSON parsing
      const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const tsconfig = JSON.parse(cleaned);
      const paths = tsconfig.compilerOptions?.paths;
      if (paths) {
        for (const key of Object.keys(paths)) {
          aliases.add(key.replace("/*", ""));
        }
      }
    } catch {
      // No tsconfig or invalid
    }
    return aliases;
  }

  private async collectImportStats(
    files: string[],
    aliases: Set<string>
  ): Promise<ImportStats> {
    const stats: ImportStats = {
      aliasImports: 0,
      relativeImports: 0,
      barrelImports: 0,
      totalImports: 0,
      aliases,
      typeImports: 0,
    };

    for (const file of files) {
      try {
        const content = await this.readFile(file);
        const lines = content.split("\n");

        for (const line of lines) {
          // Check for type imports
          if (/^import\s+type\s+/.test(line)) {
            stats.typeImports++;
          }

          // Extract import paths
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
        // Skip unreadable files
      }
    }

    return stats;
  }

  private classifyImport(importPath: string, stats: ImportStats): void {
    if (importPath.startsWith(".")) {
      stats.relativeImports++;
      // Check if it's importing from a directory (barrel)
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

  private async detectImportOrdering(
    files: string[],
    rootDir: string
  ): Promise<Finding | null> {
    let thirdPartyFirstCount = 0;
    let localFirstCount = 0;
    let filesWithMultipleImports = 0;

    for (const file of files) {
      try {
        const content = await this.readFile(file);
        const importPaths: string[] = [];

        IMPORT_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;
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
        // Skip
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
            detail: `${thirdPartyFirstCount} of ${total} files with mixed imports`,
          },
        ],
        ruleCandidate:
          "Order imports with third-party/external packages first, then local/relative imports.",
      });
    }

    return null;
  }
}

function sampleEvenly(files: string[], count: number): string[] {
  const step = Math.floor(files.length / count);
  const sampled: string[] = [];
  for (let i = 0; i < files.length && sampled.length < count; i += step) {
    sampled.push(files[i]);
  }
  return sampled;
}
