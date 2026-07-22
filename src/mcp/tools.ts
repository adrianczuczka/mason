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
  prepareSnapshotBatch,
  normalizeFeatureType,
  DEFAULT_BATCH_SIZE,
  type FeatureType,
} from "../snapshot/snapshot.js";
import { computeDrift } from "../drift/drift.js";
import type { DriftReport } from "../drift/drift.js";
import {
  BATCH_SYSTEM_PROMPT,
  REDUCE_SYSTEM_PROMPT,
  REFRESH_REDUCE_SYSTEM_PROMPT,
  buildBatchPrompt,
  buildReducePrompt,
  buildRefreshReducePrompt,
} from "../snapshot/prompt.js";
import {
  batchIdFor,
  clearAllPartials,
  clearScope,
  loadAllPartials,
  loadScope,
  savePartial,
  saveScope,
} from "../snapshot/partials.js";
import type { Snapshot } from "../snapshot/snapshot.js";
import type { AnalyzerContext } from "../types.js";
import {
  isInitialized,
  loadProjectMarker,
  saveProjectMarker,
  setupPlaybook,
  uninitializedResponse,
  type ProjectMarker,
} from "./init.js";

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

  if (!(await isInitialized(rootDir))) {
    return uninitializedResponse("building the concept map");
  }

  const snapshot = await loadSnapshot(rootDir);

  if (!snapshot) {
    return JSON.stringify({
      exists: false,
      hint: "Project is initialized but no concept map exists yet. Call generate_snapshot, then save_snapshot.",
    });
  }

  // Staleness is per entry, not just top-level — a partially refreshed map
  // can be pinned to HEAD while individual entries lag behind.
  const drift = await computeDrift(rootDir);
  const isStale = drift?.stale ?? false;

  // Return compact format: feature/flow names -> file lists only.
  // Descriptions and metadata stay in the full snapshot on disk.
  // Deduplicate files that appear in multiple features.
  const seenFiles = new Set<string>();
  const compactFeatures: Record<
    string,
    { files: string[]; tests?: string[]; type: FeatureType }
  > = {};
  for (const [name, feat] of Object.entries(snapshot.features)) {
    const unique = feat.files.filter((f) => !seenFiles.has(f));
    if (unique.length === 0) continue; // Skip fully duplicate features
    for (const f of unique) seenFiles.add(f);
    const entry: { files: string[]; tests?: string[]; type: FeatureType } = {
      files: unique,
      type: normalizeFeatureType(feat.type),
    };
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

  if (isStale && drift) {
    output.hint = driftHint(drift);
    if (drift.historyAvailable && drift.changedFiles.length > 0) {
      const samples = await buildChangedFilePreviews(
        rootDir,
        drift.changedFiles
      );
      output.diff = {
        changedFiles: drift.changedFiles,
        samples,
        truncated: drift.changedFiles.length > STALE_DIFF_MAX_FILES,
      };
      output.drift = {
        staleFeatures: drift.staleFeatures,
        staleFlows: drift.staleFlows,
        unmappedFiles: drift.unmappedFiles,
        ghostFiles: drift.ghostFiles,
        renames: drift.renames,
        recommendation: drift.recommendation,
      };
    }
  }

  return JSON.stringify(output);
}

function driftHint(report: DriftReport): string {
  if (!report.stale) {
    return "Snapshot matches HEAD. No action needed.";
  }
  if (!report.historyAvailable) {
    return "Snapshot is stale but its commit is unreachable (shallow clone or rewritten history), so per-feature drift cannot be computed. Re-run the Map-Reduce build: generate_snapshot_batch → save_partial_snapshot → reduce_snapshot → save_snapshot.";
  }
  if (report.recommendation === "full-rebuild") {
    return "Drift is too large for an incremental update. Re-run the Map-Reduce build: generate_snapshot_batch → save_partial_snapshot → reduce_snapshot → save_snapshot.";
  }
  if (report.changedFiles.length + report.unmappedFiles.length > STALE_DIFF_MAX_FILES) {
    return "Many files drifted — use a scoped refresh instead of reading them all inline: call generate_snapshot_batch(dir, files=[...changedFiles, ...unmappedFiles]) repeatedly (same list every call) with save_partial_snapshot per batch, then reduce_snapshot and save_snapshot. Entries untouched by the drift are preserved in the reduce step.";
  }
  const nothingToRemap =
    Object.keys(report.staleFeatures).length === 0 &&
    Object.keys(report.staleFlows).length === 0 &&
    report.unmappedFiles.length === 0 &&
    report.ghostFiles.length === 0;
  if (nothingToRemap) {
    return "Changes since the snapshot don't touch any mapped files. Call save_snapshot with empty features/flows to re-pin the snapshot to HEAD.";
  }
  return "Read the changed files under staleFeatures/staleFlows, update those entries (fold unmappedFiles into the right features), and call save_snapshot with only the affected entries — unchanged entries are preserved. Drop ghostFiles from any entries that reference them, and delete features/flows that no longer exist via save_snapshot's removeFeatures/removeFlows.";
}

export async function checkDrift(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);

  if (!(await isInitialized(rootDir))) {
    return uninitializedResponse("checking concept-map drift");
  }

  const report = await computeDrift(rootDir);
  if (!report) {
    return JSON.stringify({
      exists: false,
      hint: "No concept map exists yet. Build one first: generate_snapshot_batch → save_partial_snapshot → reduce_snapshot → save_snapshot.",
    });
  }

  return JSON.stringify({ exists: true, ...report, hint: driftHint(report) });
}

export async function generateSnapshotBatch(
  dir: string,
  offset: number = 0,
  batchSize: number = DEFAULT_BATCH_SIZE,
  files?: string[]
): Promise<string> {
  const rootDir = path.resolve(dir);
  const scoped = files !== undefined && files.length > 0;
  const scopeFiles = scoped ? sanitizePaths(rootDir, files) : undefined;
  const batch = await prepareSnapshotBatch(dir, offset, batchSize, scopeFiles);

  if (scoped && batch.totalFiles > 0) {
    // Mark this partial run as a scoped refresh so reduce_snapshot merges
    // into the existing map instead of rebuilding it from partials alone.
    await saveScope(rootDir, scopeFiles!);
  } else if (!scoped) {
    // A full build must never inherit a scope marker left behind by an
    // abandoned refresh run — its reduce step would wrongly merge instead
    // of rebuilding.
    await clearScope(rootDir);
  }

  const task = scoped
    ? "Refresh the concept map for a scoped set of drifted files (batch step)."
    : "Build a concept-to-files map for this project (batch step).";

  if (batch.totalFiles === 0) {
    return JSON.stringify(
      {
        task,
        offset: 0,
        nextOffset: null,
        totalFiles: 0,
        batchId: batchIdFor(0),
        instructions: BATCH_SYSTEM_PROMPT,
        prompt: scoped
          ? "(None of the requested files exist as source files in this project.)"
          : "(No source files found to map.)",
        next: scoped
          ? "None of the requested files matched project source files. Check the paths passed in `files` — they must be repo-relative."
          : "No source files were found. Skip the rest of the playbook and call mason_complete_init.",
      },
      null,
      2
    );
  }

  const batchId = batchIdFor(batch.offset);
  const continueCall = scoped
    ? `generate_snapshot_batch(dir, offset=${batch.nextOffset}, files=<the same list>)`
    : `generate_snapshot_batch(dir, offset=${batch.nextOffset})`;

  return JSON.stringify(
    {
      task,
      offset: batch.offset,
      nextOffset: batch.nextOffset,
      totalFiles: batch.totalFiles,
      batchId,
      batchSize: batch.batchSize,
      filesInBatch: batch.skeletons.length,
      scoped,
      instructions: BATCH_SYSTEM_PROMPT,
      prompt: buildBatchPrompt(batch),
      next:
        batch.nextOffset === null
          ? `Derive partial features/flows for this batch and call save_partial_snapshot(dir, batchId="${batchId}", features, flows). This is the last batch — after saving, proceed to reduce_snapshot.`
          : `Derive partial features/flows for this batch and call save_partial_snapshot(dir, batchId="${batchId}", features, flows). Then call ${continueCall} to continue.`,
    },
    null,
    2
  );
}

export async function saveSnapshotPartial(
  dir: string,
  batchId: string,
  offset: number,
  features: Record<
    string,
    { description: string; files: string[]; tests?: string[]; type?: FeatureType }
  >,
  flows: Record<string, { description: string; chain: string[] }>
): Promise<string> {
  const rootDir = path.resolve(dir);

  // Sanitize all file paths to prevent path traversal in stored partials, and
  // normalize the capability/infrastructure classification so it survives reduce.
  for (const feat of Object.values(features)) {
    feat.files = sanitizePaths(rootDir, feat.files);
    if (feat.tests) feat.tests = sanitizePaths(rootDir, feat.tests);
    feat.type = normalizeFeatureType(feat.type);
  }
  for (const flow of Object.values(flows)) {
    flow.chain = sanitizePaths(rootDir, flow.chain);
  }

  await savePartial(rootDir, {
    batchId,
    offset,
    features,
    flows,
    savedAt: new Date().toISOString(),
  });

  const all = await loadAllPartials(rootDir);
  return JSON.stringify(
    {
      status: "stored",
      batchId,
      partialsStored: all.length,
      hint:
        "Partial saved. Continue with the next generate_snapshot_batch call, or proceed to reduce_snapshot when nextOffset is null.",
    },
    null,
    2
  );
}

export async function reduceSnapshot(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);
  const partials = await loadAllPartials(rootDir);

  if (partials.length === 0) {
    return JSON.stringify(
      {
        status: "error",
        error:
          "No partial snapshots found. Run generate_snapshot_batch and save_partial_snapshot at least once before calling reduce_snapshot.",
      },
      null,
      2
    );
  }

  // A scope marker means these partials re-analyzed only a drifted subset —
  // merge them into the existing map instead of rebuilding from scratch.
  const scope = await loadScope(rootDir);
  const existing =
    scope && scope.length > 0 ? await loadSnapshot(rootDir) : null;

  if (scope && existing) {
    // Strip bookkeeping fields — the assistant shouldn't echo them back.
    const cleanFeatures = Object.fromEntries(
      Object.entries(existing.features).map(([name, feat]) => [
        name,
        {
          description: feat.description,
          files: feat.files,
          ...(feat.tests && feat.tests.length > 0 ? { tests: feat.tests } : {}),
        },
      ])
    );
    const cleanFlows = Object.fromEntries(
      Object.entries(existing.flows).map(([name, flow]) => [
        name,
        { description: flow.description, chain: flow.chain },
      ])
    );

    return JSON.stringify(
      {
        task: "Merge a scoped refresh into the existing concept map.",
        partialsCount: partials.length,
        refreshedFiles: scope.length,
        instructions: REFRESH_REDUCE_SYSTEM_PROMPT,
        prompt: buildRefreshReducePrompt(
          { features: cleanFeatures, flows: cleanFlows },
          scope,
          partials
        ),
        next: "Follow `instructions` to produce the COMPLETE updated features/flows (entries untouched by the refresh copied through unchanged), then call save_snapshot(dir, features, flows). Partials and the scope marker are cleaned up automatically after save_snapshot succeeds.",
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      task: "Merge partial concept maps into one unified map.",
      partialsCount: partials.length,
      instructions: REDUCE_SYSTEM_PROMPT,
      prompt: buildReducePrompt(partials),
      next: "Follow `instructions` to produce the unified features/flows, then call save_snapshot(dir, features, flows). Partial files will be cleaned up automatically after save_snapshot succeeds. Finish with mason_complete_init(dir).",
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
  features: Record<
    string,
    {
      description: string;
      files: string[];
      tests?: string[];
      refreshedHash?: string;
      type?: FeatureType;
    }
  >,
  flows: Record<
    string,
    { description: string; chain: string[]; refreshedHash?: string }
  >,
  removeFeatures: string[] = [],
  removeFlows: string[] = []
): Promise<string> {
  const rootDir = path.resolve(dir);
  const gitHash = await getCurrentGitHash(rootDir);
  const now = new Date().toISOString();

  // Sanitize all file paths to prevent path traversal, and normalize the
  // capability/infrastructure classification (defaults to "capability").
  for (const feat of Object.values(features)) {
    feat.files = sanitizePaths(rootDir, feat.files);
    if (feat.tests) feat.tests = sanitizePaths(rootDir, feat.tests);
    feat.type = normalizeFeatureType(feat.type);
  }
  for (const flow of Object.values(flows)) {
    flow.chain = sanitizePaths(rootDir, flow.chain);
  }

  // If partials exist we're consolidating a Map-Reduce run: replace the
  // snapshot wholesale. Merging here would pollute the unified map with any
  // earlier (possibly hallucinated) call to save_snapshot. Outside of
  // Map-Reduce — incremental refresh of one feature — fall back to merge.
  const partials = await loadAllPartials(rootDir);
  const replaceMode = partials.length > 0;
  const existing = replaceMode ? null : await loadSnapshot(rootDir);

  if (existing) {
    // Entries not re-sent in this call are only verified as of the previous
    // hash — record that before the top-level gitHash moves to HEAD, so
    // drift detection can still see which entries were skipped.
    if (existing.gitHash !== "unknown") {
      for (const feat of Object.values(existing.features)) {
        feat.refreshedHash ??= existing.gitHash;
      }
      for (const flow of Object.values(existing.flows)) {
        flow.refreshedHash ??= existing.gitHash;
      }
    }

    const removedFeatures = removeFeatures.filter(
      (name) => name in existing.features
    );
    const removedFlows = removeFlows.filter((name) => name in existing.flows);
    for (const name of removedFeatures) delete existing.features[name];
    for (const name of removedFlows) delete existing.flows[name];

    if (gitHash !== "unknown") {
      for (const feat of Object.values(features)) feat.refreshedHash = gitHash;
      for (const flow of Object.values(flows)) flow.refreshedHash = gitHash;
    }

    existing.features = { ...existing.features, ...features };
    existing.flows = { ...existing.flows, ...flows };
    existing.updatedAt = now;
    existing.gitHash = gitHash;
    await saveSnapshot(rootDir, existing);
    await clearAllPartials(rootDir);
    return JSON.stringify({
      status: "updated",
      mode: "merged",
      features: Object.keys(existing.features).length,
      flows: Object.keys(existing.flows).length,
      removedFeatures: removedFeatures.length,
      removedFlows: removedFlows.length,
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
  await clearAllPartials(rootDir);
  return JSON.stringify({
    status: replaceMode ? "replaced" : "created",
    mode: replaceMode ? "replaced-from-partials" : "fresh",
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
  const rootDir = path.resolve(dir);
  if (!(await isInitialized(rootDir))) {
    return uninitializedResponse("analyzing change impact");
  }
  const { analyzeImpact } = await import("../impact/impact.js");
  const result = await analyzeImpact(rootDir, files);
  return JSON.stringify(result, null, 2);
}

export async function getContext(
  dir: string,
  task: string,
  files?: string[]
): Promise<string> {
  const rootDir = path.resolve(dir);
  if (!(await isInitialized(rootDir))) {
    return uninitializedResponse("assembling task context");
  }
  const { assembleContext } = await import("../context/assemble.js");
  const bundle = await assembleContext(rootDir, task, files);
  if (!bundle) {
    return JSON.stringify({
      exists: false,
      hint: "No concept map exists yet. Build one first: generate_snapshot_batch → save_partial_snapshot → reduce_snapshot → save_snapshot.",
    });
  }
  return JSON.stringify(bundle);
}

// ===== Init MCP tools =====

export async function masonInit(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);
  const marker = await loadProjectMarker(rootDir);

  if (marker) {
    return JSON.stringify(
      {
        initialized: true,
        initializedAt: marker.initializedAt,
        confluenceConfigured: marker.features?.confluence === true,
        hint:
          "This project is already set up for Mason. To refresh the concept map, call generate_snapshot_batch. To (re)configure Confluence, call mason_set_confluence directly.",
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      initialized: false,
      playbook: setupPlaybook(),
    },
    null,
    2
  );
}

export async function masonCompleteInit(
  dir: string,
  options: { confluenceConfigured?: boolean } = {}
): Promise<string> {
  const rootDir = path.resolve(dir);
  const marker: ProjectMarker = {
    version: 1,
    initializedAt: new Date().toISOString(),
    features: {
      confluence: options.confluenceConfigured ?? false,
    },
  };
  await saveProjectMarker(rootDir, marker);
  return JSON.stringify(
    {
      status: "initialized",
      marker,
      hint: "Setup complete. Future calls to other Mason tools will work normally.",
    },
    null,
    2
  );
}

// ===== Confluence MCP tools =====

export async function masonSetConfluence(input: {
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey?: string;
  parentPageId?: string;
}): Promise<string> {
  const { createConfluenceClient } = await import("../confluence/client.js");
  const { saveConfluenceConfig } = await import("../llm/config.js");
  const { normalizeAtlassianBaseUrl } = await import("../confluence/url.js");

  let baseUrl: string;
  try {
    baseUrl = normalizeAtlassianBaseUrl(input.baseUrl);
  } catch (err) {
    return JSON.stringify({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!input.email.includes("@")) {
    return JSON.stringify({
      status: "error",
      error: `Email looks invalid: "${input.email}".`,
    });
  }
  if (!input.apiToken.trim()) {
    return JSON.stringify({
      status: "error",
      error: "API token is required.",
    });
  }

  const probeConfig = {
    baseUrl,
    email: input.email,
    apiToken: input.apiToken,
    spaceKey: input.spaceKey ?? "",
    parentPageId: input.parentPageId,
  };
  const client = createConfluenceClient(probeConfig);

  let spaces;
  try {
    spaces = await client.listSpaces();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("403")) {
      return JSON.stringify({
        status: "error",
        error:
          "Credentials rejected by Confluence. Re-check the email and that the API token hasn't expired or been revoked.",
      });
    }
    return JSON.stringify({
      status: "error",
      error: `Confluence validation failed: ${msg}`,
    });
  }

  if (!input.spaceKey) {
    // Step 1 — return spaces for the assistant to relay to the user.
    return JSON.stringify(
      {
        status: "spaces_listed",
        baseUrl,
        spaces: spaces.map((s) => ({ key: s.key, name: s.name })),
        hint:
          spaces.length === 0
            ? "Authenticated, but no spaces are visible to this account. Create one in Confluence first, then re-run mason_set_confluence."
            : "Ask the user which space to use, then call mason_set_confluence again with the same baseUrl/email/apiToken plus the chosen spaceKey.",
      },
      null,
      2
    );
  }

  const match = spaces.find((s) => s.key === input.spaceKey);
  if (!match) {
    return JSON.stringify({
      status: "error",
      error: `Space key "${input.spaceKey}" was not found among the spaces visible to this account. Available keys: ${spaces.map((s) => s.key).join(", ") || "(none)"}.`,
    });
  }

  await saveConfluenceConfig({
    baseUrl,
    email: input.email,
    apiToken: input.apiToken,
    spaceKey: input.spaceKey,
    parentPageId: input.parentPageId,
  });

  return JSON.stringify(
    {
      status: "saved",
      spaceKey: input.spaceKey,
      spaceName: match.name,
      hint:
        "Confluence is configured. The credentials are stored in ~/.mason/config.json. Call export_to_confluence to sync the concept map.",
    },
    null,
    2
  );
}

export async function exportToConfluenceTool(
  dir: string,
  overrides?: {
    spaceKey?: string;
    parentPageId?: string;
    indexPageTitle?: string;
    changelogPageTitle?: string;
    featurePagePrefix?: string;
  }
): Promise<string> {
  const rootDir = path.resolve(dir);
  if (!(await isInitialized(rootDir))) {
    return uninitializedResponse("syncing to Confluence");
  }

  const { loadConfig } = await import("../llm/config.js");
  const { exportToConfluence } = await import("../confluence/sync.js");

  const config = await loadConfig();
  if (!config?.confluence) {
    return JSON.stringify({
      status: "error",
      error:
        'No Confluence credentials configured. Call mason_set_confluence first (or re-run mason_init and walk through the Confluence section).',
    });
  }

  const merged = {
    ...config,
    confluence: {
      ...config.confluence,
      spaceKey: overrides?.spaceKey ?? config.confluence.spaceKey,
      parentPageId: overrides?.parentPageId ?? config.confluence.parentPageId,
    },
  };

  try {
    const summary = await exportToConfluence(rootDir, merged, {
      indexPageTitle: overrides?.indexPageTitle,
      changelogPageTitle: overrides?.changelogPageTitle,
      featurePagePrefix: overrides?.featurePagePrefix,
    });
    return JSON.stringify({ status: "ok", ...summary }, null, 2);
  } catch (err) {
    return JSON.stringify({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
