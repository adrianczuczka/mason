import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
import { runAll } from "../analyzers/index.js";
import { isGitRepo } from "../utils/git.js";
import { sampleFiles } from "./sampler.js";
import { createFileAccess } from "../utils/files.js";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import { sanitizeRepoPaths } from "../utils/paths.js";
import { assessTrust, trustHint, type TrustState } from "../context/trust.js";
import { decisionProvenance, decisionTrust, DECISION_GUIDANCE } from "../decisions/provenance.js";
import type { UpsertDecisionInput } from "../decisions/decisions.js";
import { reviewDecision as runDecisionReview, type ReviewDecisionInput } from "../decisions/review.js";
import { computeDecisionDrift } from "../decisions/drift.js";
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
import type { Snapshot, FeatureEntry, FlowEntry } from "../snapshot/snapshot.js";
import type { AnalyzerContext } from "../types.js";
import {
  loadProjectMarker,
  saveProjectMarker,
  setupPlaybook,
  type ProjectMarker,
  type InitMode,
} from "./init.js";
import { inspectOnboarding } from "./onboarding.js";

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
  const access = await createFileAccess(rootDir);
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
    const files = await access.list(`${pattern}/**/*`);
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
    const files = await access.list(pattern);
    if (files.length > 0) {
      testInfo[label] = files.length;
    }
  }

  // Source file counts by extension
  const sourceFiles = await access.list();
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
    note: "These are previews (first ~60 lines). Read the file directly with your own tools to see it in full.",
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

const UNINIT_MAX_DIRECTORIES = 40;
const UNINIT_MAX_TEST_PAIRS = 30;

/** Keep architecture requests useful when the optional map is absent. */
async function unmappedContextResponse(rootDir: string): Promise<string> {
  const [structureRaw, analyzerResults, testMap] = await Promise.all([
    getProjectStructure(rootDir),
    runAll(await buildContext(rootDir)).catch(() => []),
    import("../test-map.js")
      .then((m) => m.buildTestMap(rootDir))
      .catch(() => null),
  ]);

  const structure = JSON.parse(structureRaw);
  structure.directories = (structure.directories ?? [])
    .sort(
      (a: { fileCount: number }, b: { fileCount: number }) =>
        b.fileCount - a.fileCount
    )
    .slice(0, UNINIT_MAX_DIRECTORIES);

  const gitSignals = analyzerResults.flatMap((r) =>
    r.findings.map((f) => ({
      category: f.category,
      summary: f.summary,
      evidence: f.evidence.slice(0, 5),
    }))
  );

  return JSON.stringify({
    exists: false,
    map: { status: "missing" },
    hint:
      `No Mason concept map exists here yet. Use the context below plus your own reads to answer now — ` +
      `get_context, save_decision, and get_impact work without a map. For an optional map, mason_init with mode: "map" provides the generate_snapshot_batch workflow.`,
    structure,
    gitSignals,
    testPairs: testMap?.paired?.slice(0, UNINIT_MAX_TEST_PAIRS) ?? [],
  });
}

export async function getProjectStructure(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);

  // Get all files
  const allFiles = await (await createFileAccess(rootDir)).list("**/*");

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
  const access = await createFileAccess(rootDir);
  const capped = changedFiles.slice(0, STALE_DIFF_MAX_FILES);
  const previews: Array<{ path: string; totalLines: number; preview: string }> = [];
  for (const filePath of capped) {
    const full = await access.read(filePath);
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
    return unmappedContextResponse(rootDir);
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
    map: { status: "available" },
    updatedAt: snapshot.updatedAt,
    features: compactFeatures,
    flows: compactFlows,
    stale: isStale,
  };

  // Compact decision index — titles only, no bodies (up to 150 × 1.5KB is
  // too heavy for the orientation call). Full text via get_context or the
  // record file itself.
  const { loadDecisionStore } = await import("../decisions/decisions.js");
  const store = await loadDecisionStore(rootDir);
  const decisionRecords = store.records;
  const decisionDrift = await computeDecisionDrift(rootDir, decisionRecords);
  const trust: { features: Record<string, TrustState>; flows: Record<string, TrustState>; decisions: Record<string, TrustState> } = {
    features: Object.fromEntries(Object.entries(snapshot.features).map(([name, entry]) => [name, assessTrust(entry, drift?.featureFreshness?.[name] ?? "unknown")])),
    flows: Object.fromEntries(Object.entries(snapshot.flows).map(([name, entry]) => [name, assessTrust(entry, drift?.flowFreshness?.[name] ?? "unknown")])),
    decisions: Object.fromEntries(decisionRecords.filter(d => d.status === "active").map(d => [d.id, decisionTrust(d, decisionDrift.freshness?.[d.id] ?? "unknown")])),
  };
  output.trust = trust;
  output.workingTree = drift?.workingTree;
  output.diagnostics = store.diagnostics;
  if (decisionRecords.length > 0) {
    const compactDecisions: Record<
      string,
      { title: string; category: string; files: string[] } & ReturnType<typeof decisionProvenance>
    > = {};
    for (const d of decisionRecords) {
      if (d.status !== "active") continue;
      compactDecisions[d.id] = {
        ...decisionProvenance(d, decisionDrift.freshness?.[d.id] ?? "unknown"),
        title: d.title,
        category: d.category,
        files: d.files,
      };
    }
    output.decisions = compactDecisions;
    output.decisionsHint =
      DECISION_GUIDANCE + " Full bodies via get_context; full history via review_decision.";
  }

  if (isStale && drift) {
    output.hint = driftHint(drift);
    output.drift = {
      historyAvailable: drift.historyAvailable,
      staleFeatures: drift.staleFeatures,
      staleFlows: drift.staleFlows,
      unmappedFiles: drift.unmappedFiles,
      ghostFiles: drift.ghostFiles,
      renames: drift.renames,
      recommendation: drift.recommendation,
    };
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
    }
  }

  output.hint = [output.hint, trustHint([...Object.values(trust.features), ...Object.values(trust.flows), ...Object.values(trust.decisions)]), store.diagnostics.length ? "Some decision records are invalid; consult diagnostics." : ""].filter(Boolean).join(" ");
  return JSON.stringify(output);
}

function driftHint(report: DriftReport): string {
  if (!report.stale) {
    return "No committed changes affect the map. Consult verification and working-tree evidence before relying on it.";
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


  const report = await computeDrift(rootDir);
  if (!report) {
    return JSON.stringify({
      exists: false,
      hint: "No concept map exists to check. Decisions and impact work without one; mason_init with mode: \"map\" provides the optional map workflow.",
    });
  }

  // Report recorded correctness verdicts alongside freshness evidence.
  const snapshot = await loadSnapshot(rootDir);
  let verification: Record<string, unknown> | undefined;
  let hint = driftHint(report);
  if (snapshot) {
    const all = [
      ...Object.values(snapshot.features),
      ...Object.values(snapshot.flows),
    ];
    const failedNames = [
      ...Object.entries(snapshot.features)
        .filter(([, e]) => e.verificationFailed)
        .map(([n]) => n),
      ...Object.entries(snapshot.flows)
        .filter(([, e]) => e.verificationFailed)
        .map(([n]) => n),
    ];
    verification = {
      neverVerified: all.filter((e) => !e.verifiedAt).length,
      failed: failedNames,
    };
    if (failedNames.length > 0) {
      hint += ` Verification previously FAILED for [${failedNames.join(", ")}] — re-map those entries before trusting them.`;
    }
  }

  return JSON.stringify({ exists: true, ...report, verification, hint });
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
          type: normalizeFeatureType(feat.type),
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
    note: "Full project analysis. Code samples are previews (~60 lines). Read files directly with your own tools to see them in full.",
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
      "Full project analysis with concept map. The concept map shows which files implement each feature and how data flows through them. Use it to jump straight to relevant files instead of exploring, then read them directly with your own tools.";
  }

  return JSON.stringify(output, null, 2);
}

function sanitizePaths(
  rootDir: string,
  files: string[]
): string[] {
  return sanitizeRepoPaths(files);
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
  const previous = await loadSnapshot(rootDir);
  const existing = replaceMode ? null : previous;
  // Copy-through entries must not silently lose a failed verification during
  // a scoped rebuild. A changed description/path set requires a new verdict.
  const preserveVerification = (next: FeatureEntry | FlowEntry, old?: FeatureEntry | FlowEntry) => {
    if (!old) return;
    const semantic = (entry: FeatureEntry | FlowEntry) => JSON.stringify({
      description: entry.description,
      files: "files" in entry ? entry.files : undefined,
      chain: "chain" in entry ? entry.chain : undefined,
      tests: "files" in entry ? entry.tests : undefined,
      type: "files" in entry ? normalizeFeatureType(entry.type) : undefined,
    });
    if (semantic(next) !== semantic(old)) return;
    next.verifiedAt = old.verifiedAt;
    next.verifiedHash = old.verifiedHash;
    next.verificationFailed = old.verificationFailed;
    next.verificationNote = old.verificationNote;
  };
  for (const [name, entry] of Object.entries(features)) preserveVerification(entry, previous?.features[name]);
  for (const [name, entry] of Object.entries(flows)) preserveVerification(entry, previous?.flows[name]);

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
  const existing = (await readStoreJson(rootDir, ".mason/config.json") ?? {}) as Record<string, unknown>;

  if (config.patterns) existing.patterns = config.patterns;
  if (config.alwaysInclude) existing.alwaysInclude = config.alwaysInclude;
  if (config.ignore) existing.ignore = config.ignore;

  await writeStoreJson(rootDir, ".mason/config.json", existing);

  return JSON.stringify({
    status: "saved",
    path: path.join(rootDir, ".mason/config.json"),
    config: existing,
  });
}

export async function getImpact(
  dir: string,
  files: string[]
): Promise<string> {
  const rootDir = path.resolve(dir);
  const { analyzeImpact } = await import("../impact/impact.js");
  const result = await analyzeImpact(rootDir, files);
  return JSON.stringify(result, null, 2);
}

const VERIFY_DEFAULT_SAMPLE = 5;
const VERIFY_MAX_FILES_PER_ENTRY = 8;
const VERIFY_SKELETON_CHARS = 500;

/**
 * Verification closes the day-one hole drift can't: drift proves the map is
 * current against git, but nothing proves an entry was CORRECT when written.
 * Sample entries weighted toward never-verified, then oldest-verified.
 */
export async function verifySnapshot(
  dir: string,
  sample: number = VERIFY_DEFAULT_SAMPLE
): Promise<string> {
  const rootDir = path.resolve(dir);
  const snapshot = await loadSnapshot(rootDir);
  if (!snapshot) {
    return JSON.stringify({
      exists: false,
      hint: "No concept map exists yet — nothing to verify.",
    });
  }

  const entries = [
    ...Object.entries(snapshot.features).map(([name, e]) => ({
      name,
      kind: "feature" as const,
      description: e.description,
      files: e.files,
      verifiedAt: e.verifiedAt,
    })),
    ...Object.entries(snapshot.flows).map(([name, e]) => ({
      name,
      kind: "flow" as const,
      description: e.description,
      files: e.chain,
      verifiedAt: e.verifiedAt,
    })),
  ];

  entries.sort((a, b) => {
    if (!a.verifiedAt && !b.verifiedAt) return a.name.localeCompare(b.name);
    if (!a.verifiedAt) return -1;
    if (!b.verifiedAt) return 1;
    return a.verifiedAt.localeCompare(b.verifiedAt);
  });

  const access = await createFileAccess(rootDir);
  const picked = entries.slice(0, Math.max(1, sample));
  const toVerify = [];
  for (const entry of picked) {
    const skeletons: Array<{ path: string; content: string } | { path: string; missing: true }> = [];
    for (const filePath of entry.files.slice(0, VERIFY_MAX_FILES_PER_ENTRY)) {
      const full = await access.read(filePath);
      if (full) {
        skeletons.push({
          path: full.path,
          content: full.content.slice(0, VERIFY_SKELETON_CHARS),
        });
      } else {
        skeletons.push({ path: filePath, missing: true });
      }
    }
    toVerify.push({
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      lastVerified: entry.verifiedAt ?? "never",
      skeletons,
      truncated: entry.files.length > VERIFY_MAX_FILES_PER_ENTRY,
    });
  }

  const neverVerified = entries.filter((e) => !e.verifiedAt).length;

  return JSON.stringify({
    exists: true,
    totalEntries: entries.length,
    neverVerified,
    entries: toVerify,
    instructions:
      "For each entry, judge from the skeletons whether the listed files actually implement the claimed feature/flow (missing files count against it). Then call save_verification with verdicts: {\"<entry name>\": {\"ok\": true|false, \"note\": \"<one line, required when ok is false>\"}}. Be skeptical — a plausible description is not evidence; the files must show it.",
  });
}

export async function saveVerification(
  dir: string,
  verdicts: Record<string, { ok: boolean; note?: string }>
): Promise<string> {
  const rootDir = path.resolve(dir);
  const snapshot = await loadSnapshot(rootDir);
  if (!snapshot) {
    return JSON.stringify({ exists: false, hint: "No concept map exists." });
  }

  const now = new Date().toISOString();
  const verifiedHash = await getCurrentGitHash(rootDir);
  const stamped: string[] = [];
  const unknown: string[] = [];
  const failed: string[] = [];

  for (const [name, verdict] of Object.entries(verdicts)) {
    const entry = snapshot.features[name] ?? snapshot.flows[name];
    if (!entry) {
      unknown.push(name);
      continue;
    }
    entry.verifiedAt = now;
    entry.verifiedHash = verifiedHash;
    if (verdict.ok) {
      delete entry.verificationFailed;
      delete entry.verificationNote;
    } else {
      entry.verificationFailed = true;
      entry.verificationNote = verdict.note ?? "verification failed";
      failed.push(name);
    }
    stamped.push(name);
  }

  snapshot.updatedAt = now;
  await saveSnapshot(rootDir, snapshot);

  return JSON.stringify({
    stamped,
    unknown,
    failed,
    hint:
      failed.length > 0
        ? `Entries [${failed.join(", ")}] are mis-mapped. Re-map them: read their actual files, correct the entries, and call save_snapshot with only those entries (plus removeFeatures/removeFlows if a concept no longer exists).`
        : "All sampled entries verified. Re-run verify_snapshot periodically — it always picks the least-recently-verified entries next.",
  });
}

export async function saveDecision(
  dir: string,
  input: UpsertDecisionInput
): Promise<string> {
  const rootDir = path.resolve(dir);
  const { upsertDecision } = await import("../decisions/decisions.js");
  const result = await upsertDecision(rootDir, input);
  return JSON.stringify(result);
}

export async function reviewDecision(dir: string, input: ReviewDecisionInput): Promise<string> {
  return JSON.stringify(await runDecisionReview(path.resolve(dir), input));
}

export async function getContext(
  dir: string,
  task: string,
  files?: string[]
): Promise<string> {
  const rootDir = path.resolve(dir);
  const { assembleContext } = await import("../context/assemble.js");
  const bundle = await assembleContext(rootDir, task, files);
  return JSON.stringify(bundle);
}

// ===== Init MCP tools =====

export async function masonInit(dir: string, options: { mode?: InitMode; base?: string; evidence?: string[] } = {}): Promise<string> {
  const rootDir = path.resolve(dir);
  const marker = await loadProjectMarker(rootDir);
  const mode = options.mode ?? "quickstart";
  const findings = await inspectOnboarding(rootDir, options.base, options.evidence);
  return JSON.stringify(
    {
      initialized: marker !== null,
      ...(marker ? { initializedAt: marker.initializedAt } : {}),
      confluenceConfigured: marker?.features?.confluence === true,
      mode,
      ...findings,
      playbook: setupPlaybook(mode),
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
  const existing = await loadProjectMarker(rootDir);
  const marker: ProjectMarker = {
    version: 1,
    initializedAt: existing?.initializedAt ?? new Date().toISOString(),
    features: {
      ...existing?.features,
      confluence: options.confluenceConfigured ?? existing?.features?.confluence ?? false,
    },
  };
  await saveProjectMarker(rootDir, marker);
  return JSON.stringify(
    {
      status: "initialized",
      marker,
      hint: "Assistant setup recorded. Save decisions as you learn, review and commit them, and retrieve them with get_context. A concept map is optional.",
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

  const { loadConfig } = await import("../llm/config.js");
  const { exportToConfluence } = await import("../confluence/sync.js");

  const config = await loadConfig();
  if (!config?.confluence) {
    return JSON.stringify({
      status: "error",
      error:
        'No Confluence credentials configured. Call mason_set_confluence first.',
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
