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
  getChangedFilesSince,
  prepareSnapshotInput,
} from "../snapshot/snapshot.js";
import {
  SNAPSHOT_SYSTEM_PROMPT,
  buildSnapshotPrompt,
} from "../snapshot/prompt.js";
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

const STALE_DIFF_PREVIEW_LINES = 60;
const STALE_DIFF_MAX_FILES = 25;

async function buildChangedFilePreviews(
  rootDir: string,
  changedFiles: string[]
): Promise<Array<{ path: string; totalLines: number; preview: string }>> {
  const capped = changedFiles.slice(0, STALE_DIFF_MAX_FILES);
  const previews: Array<{ path: string; totalLines: number; preview: string }> = [];
  for (const filePath of capped) {
    const full = await readFullFile(rootDir, filePath);
    if (!full) continue;
    const lines = full.content.split("\n");
    previews.push({
      path: full.path,
      totalLines: full.totalLines,
      preview: lines.slice(0, STALE_DIFF_PREVIEW_LINES).join("\n"),
    });
  }
  return previews;
}

export async function getSnapshot(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);
  const snapshot = await loadSnapshot(rootDir);

  if (!snapshot) {
    return JSON.stringify({
      exists: false,
      hint: "No concept map yet. You MUST call generate_snapshot next, then save_snapshot to persist the result. The map is a granular feature-to-file index that prose overviews (like CLAUDE.md) do not provide — even when CLAUDE.md exists, the map indexes what the prose summarizes. Skip generate_snapshot ONLY if the user has already named a specific file path AND reading just that file is sufficient. Do not generalize this exception to 'I have other context' or 'CLAUDE.md is enough' — those are not valid reasons to skip.",
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
    const changedFiles = await getChangedFilesSince(rootDir, snapshot.gitHash);
    if (changedFiles && changedFiles.length > 0) {
      const samples = await buildChangedFilePreviews(rootDir, changedFiles);
      output.diff = {
        changedFiles,
        samples,
        truncated: changedFiles.length > STALE_DIFF_MAX_FILES,
      };
      output.hint =
        "Snapshot is behind HEAD. Use the `diff` to update affected features/flows and call save_snapshot — only entries that touch the changed files need to be re-sent.";
    } else {
      output.hint =
        "Snapshot is behind HEAD but the diff could not be computed. Call save_snapshot to refresh.";
    }
  }

  return JSON.stringify(output);
}

export async function generateSnapshot(dir: string): Promise<string> {
  const { filesWithContent, testPairs } = await prepareSnapshotInput(dir);

  if (filesWithContent.length === 0) {
    return JSON.stringify(
      {
        task: "Build a concept-to-files map for this project.",
        instructions: SNAPSHOT_SYSTEM_PROMPT,
        prompt: "(No source files found to map.)",
        next: "No source files were found, so there is nothing to map. Do not call save_snapshot.",
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      task: "Build a concept-to-files map for this project.",
      instructions: SNAPSHOT_SYSTEM_PROMPT,
      prompt: buildSnapshotPrompt(filesWithContent, testPairs),
      next: "Follow `instructions` to derive features and flows from `prompt`, then call save_snapshot(dir, features, flows) to persist them.",
    },
    null,
    2
  );
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

function sanitizePaths(
  rootDir: string,
  files: string[]
): string[] {
  return files.filter((f) => {
    const resolved = path.resolve(rootDir, f);
    return resolved.startsWith(rootDir) && !f.startsWith("/") && !f.includes("..");
  });
}

export async function saveSnapshotData(
  dir: string,
  features: Record<string, { description: string; files: string[]; tests?: string[] }>,
  flows: Record<string, { description: string; chain: string[] }>
): Promise<string> {
  const rootDir = path.resolve(dir);
  const gitHash = await getCurrentGitHash(rootDir);
  const now = new Date().toISOString();

  // Sanitize all file paths to prevent path traversal
  for (const feat of Object.values(features)) {
    feat.files = sanitizePaths(rootDir, feat.files);
    if (feat.tests) feat.tests = sanitizePaths(rootDir, feat.tests);
  }
  for (const flow of Object.values(flows)) {
    flow.chain = sanitizePaths(rootDir, flow.chain);
  }

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
