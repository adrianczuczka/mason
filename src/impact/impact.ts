import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFileAccess, SOURCE_GLOB } from "../utils/files.js";
import { normalizeRepoPath } from "../utils/paths.js";
import { createReferenceMatcher, sortReferences, type ReferenceEntry } from "./references.js";
export type { ReferenceEntry } from "./references.js";

const exec = promisify(execFile);

export interface CochangeEntry {
  file: string;
  cochangeRate: number;
  sharedCommits: number;
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
  const access = await createFileAccess(rootDir);

  for (const target of targets) {
    // If it contains a path separator, use as-is
    if (target.includes("/")) {
      const normalized = normalizeRepoPath(target);
      if (normalized) resolved.push(normalized);
      continue;
    }

    // Otherwise, search for the filename
    const matches = await access.list(`**/${target}`);

    if (matches.length > 0) {
      resolved.push(matches[0]);
    } else {
      // Try without extension
      const noExt = target.replace(/\.[^.]+$/, "");
      const extMatches = await access.list(`**/${noExt}.*`);
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
  const access = await createFileAccess(rootDir);
  const allSourceFiles = await access.list(SOURCE_GLOB);
  const available = new Set(allSourceFiles);
  const targetContents = new Map<string, string>();
  for (const target of targetFiles) {
    const source = await access.read(target);
    if (source) { available.add(target); targetContents.set(target, source.content); }
  }
  const match = createReferenceMatcher(targetFiles, available, targetContents);
  const references: ReferenceEntry[] = [];
  for (let i = 0; i < allSourceFiles.length; i += 50) {
    const batch = await Promise.all(allSourceFiles.slice(i, i + 50).map(file => access.read(file)));
    for (const source of batch) if (source) references.push(...match(source));
  }
  return sortReferences(references);
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

  const testFiles = await (await createFileAccess(rootDir)).list(testPatterns);
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
