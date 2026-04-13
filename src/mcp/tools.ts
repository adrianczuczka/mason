import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";

const exec = promisify(execFile);
import { runAll } from "../analyzers/index.js";
import { isGitRepo } from "../utils/git.js";
import { sampleFiles } from "./sampler.js";
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
  const { buildTestMap } = await import("../test-map.js");
  const result = await buildTestMap(dir);
  return JSON.stringify(result, null, 2);
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

  // Return compact format: feature/flow names -> file lists only.
  // Descriptions and metadata stay in the full snapshot on disk.
  // Deduplicate files that appear in multiple features.
  const seenFiles = new Set<string>();
  const compactFeatures: Record<string, { files: string[]; tests?: string[] }> = {};
  for (const [name, feat] of Object.entries(snapshot.features)) {
    const unique = feat.files.filter((f) => !seenFiles.has(f));
    if (unique.length === 0) continue; // Skip fully duplicate features
    for (const f of unique) seenFiles.add(f);
    const entry: { files: string[]; tests?: string[] } = { files: unique };
    if (feat.tests && feat.tests.length > 0) {
      entry.tests = feat.tests;
    }
    compactFeatures[name] = entry;
  }

  const compactFlows: Record<string, string[]> = {};
  for (const [name, flow] of Object.entries(snapshot.flows)) {
    compactFlows[name] = flow.chain; // Flows keep all files (order matters)
  }

  const output: Record<string, unknown> = {
    exists: true,
    updatedAt: snapshot.updatedAt,
    features: compactFeatures,
    flows: compactFlows,
    stale: isStale,
  };

  if (isStale) {
    output.message =
      "Snapshot is behind HEAD. Run 'mason snapshot-update' or call save_snapshot to refresh.";
  }

  return JSON.stringify(output);
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

export async function getImpact(
  dir: string,
  files: string[]
): Promise<string> {
  const { analyzeImpact } = await import("../impact/impact.js");
  const rootDir = path.resolve(dir);
  const result = await analyzeImpact(rootDir, files);
  return JSON.stringify(result, null, 2);
}
