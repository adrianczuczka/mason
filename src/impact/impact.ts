import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";

const exec = promisify(execFile);

const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.gradle/**",
  "**/target/**",
  "**/.git/**",
  "**/vendor/**",
  "**/__pycache__/**",
  "**/venv/**",
  "**/.venv/**",
  "**/generated/**",
];

const SOURCE_EXTENSIONS =
  "*.{ts,tsx,js,jsx,kt,kts,java,py,go,rs,swift,rb,cs,cpp,c,h,dart,gradle.kts,gradle}";

export interface CochangeEntry {
  file: string;
  cochangeRate: number;
  sharedCommits: number;
}

export interface ReferenceEntry {
  file: string;
  matches: string[];
}

export interface TestEntry {
  file: string;
  confidence: "exact" | "best-guess";
}

export interface ImpactResult {
  targetFiles: string[];
  cochange: CochangeEntry[];
  references: ReferenceEntry[];
  tests: TestEntry[];
}

export async function analyzeImpact(
  rootDir: string,
  targetFiles: string[]
): Promise<ImpactResult> {
  const resolvedRoot = path.resolve(rootDir);

  // Resolve target files to full relative paths if only basename given
  const resolvedTargets = await resolveTargetFiles(resolvedRoot, targetFiles);

  const [cochange, references, tests] = await Promise.all([
    getCochangeFiles(resolvedRoot, resolvedTargets),
    getReferences(resolvedRoot, resolvedTargets),
    getRelatedTests(resolvedRoot, resolvedTargets),
  ]);

  return {
    targetFiles: resolvedTargets,
    cochange,
    references,
    tests,
  };
}

async function resolveTargetFiles(
  rootDir: string,
  targets: string[]
): Promise<string[]> {
  const resolved: string[] = [];

  for (const target of targets) {
    // If it contains a path separator, use as-is
    if (target.includes("/")) {
      resolved.push(target);
      continue;
    }

    // Otherwise, search for the filename
    const matches = await fg(`**/${target}`, {
      cwd: rootDir,
      ignore: IGNORE,
    });

    if (matches.length > 0) {
      resolved.push(matches[0]);
    } else {
      // Try without extension
      const noExt = target.replace(/\.[^.]+$/, "");
      const extMatches = await fg(`**/${noExt}.*`, {
        cwd: rootDir,
        ignore: IGNORE,
      });
      if (extMatches.length > 0) {
        resolved.push(extMatches[0]);
      } else {
        resolved.push(target); // Keep as-is, might still work for grep
      }
    }
  }

  return resolved;
}

async function getCochangeFiles(
  rootDir: string,
  targetFiles: string[]
): Promise<CochangeEntry[]> {
  const cochangeCounts = new Map<string, number>();
  let totalTargetCommits = 0;

  for (const targetFile of targetFiles) {
    try {
      // Get commits that touched this file (cap at 500)
      const { stdout: commitLog } = await exec(
        "git",
        ["log", "--format=%H", "-n", "500", "--", targetFile],
        { cwd: rootDir, maxBuffer: 5_000_000 }
      );

      const commits = commitLog.trim().split("\n").filter(Boolean);
      totalTargetCommits += commits.length;

      if (commits.length === 0) continue;

      // For each commit, get the other files that changed
      for (const commit of commits) {
        try {
          const { stdout: filesInCommit } = await exec(
            "git",
            ["diff-tree", "--no-commit-id", "--name-only", "-r", commit],
            { cwd: rootDir }
          );

          const files = filesInCommit.trim().split("\n").filter(Boolean);
          for (const file of files) {
            if (targetFiles.includes(file)) continue; // Skip the target itself
            cochangeCounts.set(file, (cochangeCounts.get(file) ?? 0) + 1);
          }
        } catch {
          // Skip this commit
        }
      }
    } catch {
      // No git or file not tracked
    }
  }

  if (totalTargetCommits === 0) return [];

  // Filter to files that co-change >30% of the time, sort by rate
  return [...cochangeCounts.entries()]
    .map(([file, count]) => ({
      file,
      cochangeRate: Math.round((count / totalTargetCommits) * 100) / 100,
      sharedCommits: count,
    }))
    .filter((e) => e.cochangeRate >= 0.3 || e.sharedCommits >= 3)
    .sort((a, b) => b.cochangeRate - a.cochangeRate)
    .slice(0, 20);
}

async function getReferences(
  rootDir: string,
  targetFiles: string[]
): Promise<ReferenceEntry[]> {
  // Extract searchable names from target files
  const searchNames = new Set<string>();
  for (const target of targetFiles) {
    const basename = path.basename(target).replace(/\.[^.]+$/, "");
    searchNames.add(basename);
  }

  const allSourceFiles = await fg(`**/${SOURCE_EXTENSIONS}`, {
    cwd: rootDir,
    ignore: IGNORE,
  });

  // Exclude target files from search
  const targetSet = new Set(targetFiles);
  const filesToSearch = allSourceFiles.filter((f) => !targetSet.has(f));

  const results = new Map<string, Set<string>>();

  // Read files in batches to avoid too many open handles
  const batchSize = 50;
  for (let i = 0; i < filesToSearch.length; i += batchSize) {
    const batch = filesToSearch.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (file) => {
        try {
          const content = await fs.readFile(
            path.join(rootDir, file),
            "utf-8"
          );

          for (const name of searchNames) {
            // Match the name as a word boundary (not part of another word)
            const regex = new RegExp(`\\b${escapeRegex(name)}\\b`);
            if (regex.test(content)) {
              if (!results.has(file)) results.set(file, new Set());
              results.get(file)!.add(name);
            }
          }
        } catch {
          // Skip unreadable files
        }
      })
    );
  }

  return [...results.entries()]
    .map(([file, matches]) => ({
      file,
      matches: [...matches],
    }))
    .sort((a, b) => b.matches.length - a.matches.length);
}

async function getRelatedTests(
  rootDir: string,
  targetFiles: string[]
): Promise<TestEntry[]> {
  const testPatterns = [
    "**/*.test.*",
    "**/*.spec.*",
    "**/*Test.kt",
    "**/*Test.java",
    "**/*Tests.kt",
    "**/*Tests.java",
    "**/test_*.py",
    "**/*_test.py",
    "**/*_test.go",
    "**/*Tests.swift",
    "**/*Test.swift",
    "**/*_test.rs",
  ];

  const testFiles = await fg(testPatterns, { cwd: rootDir, ignore: IGNORE });
  const results: TestEntry[] = [];

  for (const target of targetFiles) {
    const targetBaseName = path
      .basename(target)
      .replace(/\.[^.]+$/, "");

    for (const testFile of testFiles) {
      const testBaseName = path
        .basename(testFile)
        .replace(/\.[^.]+$/, "");

      // Strip test suffixes to get the source name
      const sourceName = testBaseName
        .replace(/Test$|Tests$|Spec$|\.test$|\.spec$/, "")
        .replace(/^test_|_test$/, "");

      if (sourceName === targetBaseName) {
        results.push({
          file: testFile,
          confidence: "exact",
        });
      }
    }
  }

  return results;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
