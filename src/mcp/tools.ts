import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";

const exec = promisify(execFile);
import { runAll } from "../analyzers/index.js";
import { isGitRepo } from "../utils/git.js";
import { sampleFiles, readFullFile } from "./sampler.js";
import {
  loadSnapshot,
  saveSnapshot,
  getCurrentGitHash,
} from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot.js";
import type { AnalyzerContext } from "../types.js";

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
  "**/*.min.*",
  "**/*.map",
];

async function buildContext(dir: string): Promise<AnalyzerContext> {
  return {
    rootDir: dir,
    gitAvailable: await isGitRepo(dir),
  };
}

export async function analyzeProject(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);
  const context = await buildContext(rootDir);
  const results = await runAll(context);

  // Lightweight project snapshot — pure file existence checks, no parsing
  const projectSnapshot = await detectProjectSnapshot(rootDir);

  const output = {
    project: projectSnapshot,
    analyzers: results.map((r) => ({
      name: r.analyzer,
      durationMs: r.durationMs,
      findings: r.findings.map((f) => ({
        category: f.category,
        confidence: f.confidence,
        summary: f.summary,
        evidence: f.evidence,
        suggestedRule: f.ruleCandidate,
      })),
      gaps: r.gaps.map((g) => ({
        question: g.question,
        context: g.context,
      })),
    })),
  };

  return JSON.stringify(output, null, 2);
}

async function detectProjectSnapshot(rootDir: string): Promise<Record<string, unknown>> {
  // Build config files present (what exists, not what's in them)
  const buildFiles = [
    "package.json", "tsconfig.json",
    "build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle",
    "gradle/libs.versions.toml",
    "Cargo.toml", "go.mod", "go.sum",
    "pyproject.toml", "setup.py", "requirements.txt", "Pipfile",
    "Gemfile", "Package.swift",
    "Makefile", "CMakeLists.txt",
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
    ".github/workflows", ".gitlab-ci.yml", "Jenkinsfile",
  ];

  const present: string[] = [];
  for (const file of buildFiles) {
    try {
      await fs.access(path.join(rootDir, file));
      present.push(file);
    } catch {
      // Not found
    }
  }

  // Test directories and file counts
  const testDirs = [
    "test", "tests", "__tests__", "spec",
    "src/test", "src/tests",
    "**/src/test", "**/src/androidTest", "**/src/iosTest",
  ];
  const testInfo: Record<string, number> = {};
  for (const pattern of testDirs) {
    const files = await fg(`${pattern}/**/*`, {
      cwd: rootDir,
      ignore: IGNORE,
      onlyFiles: true,
    });
    if (files.length > 0) {
      testInfo[pattern] = files.length;
    }
  }

  // Also count test files by naming convention
  const testFilePatterns = [
    { pattern: "**/*.test.*", label: "*.test.*" },
    { pattern: "**/*.spec.*", label: "*.spec.*" },
    { pattern: "**/*Test.kt", label: "*Test.kt" },
    { pattern: "**/*Test.java", label: "*Test.java" },
    { pattern: "**/test_*.py", label: "test_*.py" },
    { pattern: "**/*_test.go", label: "*_test.go" },
    { pattern: "**/*Tests.swift", label: "*Tests.swift" },
    { pattern: "**/*_test.rs", label: "*_test.rs" },
  ];
  for (const { pattern, label } of testFilePatterns) {
    const files = await fg(pattern, { cwd: rootDir, ignore: IGNORE });
    if (files.length > 0) {
      testInfo[label] = files.length;
    }
  }

  // Source file counts by extension
  const sourceFiles = await fg("**/*.{ts,tsx,js,jsx,kt,kts,java,py,go,rs,swift,rb,cs,cpp,c,dart}", {
    cwd: rootDir,
    ignore: IGNORE,
  });
  const fileCounts: Record<string, number> = {};
  for (const file of sourceFiles) {
    const ext = path.extname(file).slice(1);
    fileCounts[ext] = (fileCounts[ext] ?? 0) + 1;
  }

  return {
    configFilesPresent: present,
    sourceFileCounts: fileCounts,
    totalSourceFiles: sourceFiles.length,
    testInfo: Object.keys(testInfo).length > 0 ? testInfo : undefined,
  };
}

export async function getCodeSamples(
  dir: string,
  count: number = 15
): Promise<string> {
  const rootDir = path.resolve(dir);
  const samples = await sampleFiles(rootDir, count);

  const output = {
    note: "These are previews (first ~60 lines). Use get_file_content to read the full file if needed.",
    files: samples.map((s) => ({
      path: s.path,
      reason: s.reason,
      totalLines: s.totalLines,
      sizeBytes: s.sizeBytes,
      preview: s.preview,
    })),
  };

  return JSON.stringify(output, null, 2);
}

export async function getFileContent(
  dir: string,
  filePath: string
): Promise<string> {
  const rootDir = path.resolve(dir);
  const result = await readFullFile(rootDir, filePath);

  if (!result) {
    return JSON.stringify({ error: `Could not read file: ${filePath}` });
  }

  return JSON.stringify(result, null, 2);
}

export async function getProjectStructure(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);

  // Get all files
  const allFiles = await fg("**/*", {
    cwd: rootDir,
    ignore: IGNORE,
    onlyFiles: true,
  });

  // Build directory summary with file counts and extension breakdown
  const dirInfo = new Map<
    string,
    { fileCount: number; extensions: Map<string, number> }
  >();

  for (const file of allFiles) {
    const parts = file.split("/");
    // Track up to 2 levels deep
    for (let depth = 1; depth <= Math.min(parts.length, 2); depth++) {
      const dirPath = parts.slice(0, depth).join("/");
      if (!dirInfo.has(dirPath)) {
        dirInfo.set(dirPath, { fileCount: 0, extensions: new Map() });
      }
      const info = dirInfo.get(dirPath)!;
      info.fileCount++;
      const ext = path.extname(file).slice(1);
      if (ext) {
        info.extensions.set(ext, (info.extensions.get(ext) ?? 0) + 1);
      }
    }
  }

  // Format directories sorted by path
  const directories = [...dirInfo.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dirPath, info]) => {
      const extensions: Record<string, number> = {};
      for (const [ext, count] of info.extensions) {
        extensions[ext] = count;
      }
      return { path: dirPath, fileCount: info.fileCount, extensions };
    });

  // Top-level files
  const topLevelFiles = allFiles.filter((f) => !f.includes("/"));

  const output = {
    totalFiles: allFiles.length,
    topLevelFiles,
    directories,
  };

  return JSON.stringify(output, null, 2);
}

export async function getTestMap(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);

  // Find all test files
  const testPatterns = [
    "**/*.test.*", "**/*.spec.*",
    "**/*Test.kt", "**/*Test.java", "**/*Tests.kt", "**/*Tests.java",
    "**/test_*.py", "**/*_test.py",
    "**/*_test.go",
    "**/*Tests.swift", "**/*Test.swift",
    "**/*_test.rs",
  ];
  const testFiles = await fg(testPatterns, { cwd: rootDir, ignore: IGNORE });

  // Find all source files
  const sourceFiles = await fg(
    "**/*.{ts,tsx,js,jsx,kt,kts,java,py,go,rs,swift,rb,cs,cpp,dart}",
    { cwd: rootDir, ignore: IGNORE }
  );

  // Build source file index by base name (without extension)
  const sourceByBaseName = new Map<string, string[]>();
  for (const file of sourceFiles) {
    if (testFiles.includes(file)) continue; // Skip test files
    const baseName = path.basename(file).replace(/\.[^.]+$/, "");
    const existing = sourceByBaseName.get(baseName) ?? [];
    existing.push(file);
    sourceByBaseName.set(baseName, existing);
  }

  // Match test files to source files by name
  const pairs: Array<{ test: string; source: string | null; confidence: string }> = [];
  const unmatched: string[] = [];

  for (const testFile of testFiles) {
    const testBaseName = path.basename(testFile).replace(/\.[^.]+$/, "");

    // Strip test suffixes/prefixes to get the source name
    const sourceName = testBaseName
      .replace(/Test$|Tests$|Spec$|\.test$|\.spec$/, "")
      .replace(/^test_|_test$/, "");

    if (!sourceName) {
      unmatched.push(testFile);
      continue;
    }

    const candidates = sourceByBaseName.get(sourceName);
    if (candidates && candidates.length > 0) {
      // If multiple candidates, prefer one in a similar directory path
      const testDir = path.dirname(testFile);
      const bestMatch = candidates.reduce((best, candidate) => {
        const candidateDir = path.dirname(candidate);
        const bestDir = path.dirname(best);
        // Prefer candidates that share more path segments
        const candidateOverlap = commonSegments(testDir, candidateDir);
        const bestOverlap = commonSegments(testDir, bestDir);
        return candidateOverlap > bestOverlap ? candidate : best;
      });

      pairs.push({
        test: testFile,
        source: bestMatch,
        confidence: candidates.length === 1 ? "exact" : "best-guess",
      });
    } else {
      unmatched.push(testFile);
    }
  }

  const output = {
    totalTestFiles: testFiles.length,
    paired: pairs,
    unmatched,
  };

  return JSON.stringify(output, null, 2);
}

function commonSegments(pathA: string, pathB: string): number {
  const segsA = pathA.split("/");
  const segsB = pathB.split("/");
  let count = 0;
  for (let i = 0; i < Math.min(segsA.length, segsB.length); i++) {
    if (segsA[i] === segsB[i]) count++;
    else break;
  }
  return count;
}

export async function getSnapshot(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);
  const snapshot = await loadSnapshot(rootDir);

  if (!snapshot) {
    return JSON.stringify({
      exists: false,
      message:
        "No concept map found. Run 'mason snapshot' to create one, or call save_snapshot with features and flows.",
    });
  }

  // Check staleness
  const currentHash = await getCurrentGitHash(rootDir);
  const isStale = snapshot.gitHash !== currentHash && snapshot.gitHash !== "unknown";

  const output: Record<string, unknown> = {
    exists: true,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    featureCount: Object.keys(snapshot.features).length,
    flowCount: Object.keys(snapshot.flows).length,
    features: snapshot.features,
    flows: snapshot.flows,
    stale: isStale,
  };

  if (isStale) {
    output.message =
      "Snapshot is behind HEAD. Some features/flows may reference changed files. Run 'mason snapshot-update' or call save_snapshot to refresh.";
  }

  return JSON.stringify(output, null, 2);
}

export async function fullAnalysis(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);

  const [analysis, structure, samples, testMap, snapshot] = await Promise.all([
    analyzeProject(dir),
    getProjectStructure(dir),
    getCodeSamples(dir, 25),
    getTestMap(dir),
    loadSnapshot(rootDir),
  ]);

  const output: Record<string, unknown> = {
    note: "Full project analysis. Code samples are previews (~60 lines). Use get_file_content to read any file in full.",
    analysis: JSON.parse(analysis),
    structure: JSON.parse(structure),
    codeSamples: JSON.parse(samples),
    testMap: JSON.parse(testMap),
  };

  if (snapshot) {
    output.conceptMap = {
      updatedAt: snapshot.updatedAt,
      features: snapshot.features,
      flows: snapshot.flows,
    };
    output.note =
      "Full project analysis with concept map. The concept map shows which files implement each feature and how data flows through them. Use it to jump straight to relevant files instead of exploring. Use get_file_content to read specific files.";
  }

  return JSON.stringify(output, null, 2);
}

export async function saveSnapshotData(
  dir: string,
  features: Record<string, { description: string; files: string[]; tests?: string[] }>,
  flows: Record<string, { description: string; chain: string[] }>
): Promise<string> {
  const rootDir = path.resolve(dir);
  const gitHash = await getCurrentGitHash(rootDir);
  const now = new Date().toISOString();

  const existing = await loadSnapshot(rootDir);

  if (existing) {
    // Merge: overwrite matching features/flows, keep the rest
    existing.features = { ...existing.features, ...features };
    existing.flows = { ...existing.flows, ...flows };
    existing.updatedAt = now;
    existing.gitHash = gitHash;
    await saveSnapshot(rootDir, existing);
    return JSON.stringify({
      status: "updated",
      features: Object.keys(existing.features).length,
      flows: Object.keys(existing.flows).length,
    });
  }

  const snapshot: Snapshot = {
    version: 2,
    createdAt: now,
    updatedAt: now,
    gitHash,
    features,
    flows,
  };

  await saveSnapshot(rootDir, snapshot);
  return JSON.stringify({
    status: "created",
    features: Object.keys(features).length,
    flows: Object.keys(flows).length,
  });
}

export async function configureProject(
  dir: string,
  config: {
    patterns?: string[];
    alwaysInclude?: string[];
    ignore?: string[];
  }
): Promise<string> {
  const rootDir = path.resolve(dir);
  const configDir = path.join(rootDir, ".mason");
  const configPath = path.join(configDir, "config.json");

  // Load existing config and merge
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // No existing config
  }

  if (config.patterns) existing.patterns = config.patterns;
  if (config.alwaysInclude) existing.alwaysInclude = config.alwaysInclude;
  if (config.ignore) existing.ignore = config.ignore;

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");

  return JSON.stringify({
    status: "saved",
    path: configPath,
    config: existing,
  });
}

export async function checkDrift(dir: string): Promise<string> {
  const { detectDrift } = await import("../lint/drift.js");
  const rootDir = path.resolve(dir);
  const result = await detectDrift(rootDir);

  if (!result.claudeMdPath) {
    return JSON.stringify({
      hasClaude: false,
      message: "No CLAUDE.md found. Run mason generate to create one.",
    });
  }

  return JSON.stringify({
    hasClaude: true,
    claudeMdPath: result.claudeMdPath,
    lastGenerated: result.lastGenerated,
    issueCount: result.issues.length,
    issues: result.issues,
    drifted: result.issues.length > 0,
  });
}
