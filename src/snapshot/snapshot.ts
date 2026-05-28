import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { sampleFiles, readFullFile } from "../mcp/sampler.js";
import { buildTestMap } from "../test-map.js";
import { callLLM } from "../llm/providers.js";
import type { MasonConfig } from "../llm/config.js";
import {
  SNAPSHOT_SYSTEM_PROMPT,
  buildSnapshotPrompt,
  buildIncrementalPrompt,
} from "./prompt.js";

const exec = promisify(execFile);

export interface FeatureEntry {
  description: string;
  files: string[];
  tests?: string[];
}

export interface FlowEntry {
  description: string;
  chain: string[];
}

export interface Snapshot {
  version: 2;
  createdAt: string;
  updatedAt: string;
  gitHash: string;
  features: Record<string, FeatureEntry>;
  flows: Record<string, FlowEntry>;
}

function snapshotDir(rootDir: string): string {
  return path.join(rootDir, ".mason");
}

function snapshotPath(rootDir: string): string {
  return path.join(snapshotDir(rootDir), "snapshot.json");
}

export async function loadSnapshot(rootDir: string): Promise<Snapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath(rootDir), "utf-8");
    const parsed = JSON.parse(raw);
    // Skip v1 snapshots — they're the old per-file format
    if (parsed.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSnapshot(
  rootDir: string,
  snapshot: Snapshot
): Promise<void> {
  await fs.mkdir(snapshotDir(rootDir), { recursive: true });
  await fs.writeFile(
    snapshotPath(rootDir),
    JSON.stringify(snapshot, null, 2),
    "utf-8"
  );
}

export async function getCurrentGitHash(rootDir: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

export async function getChangedFilesSince(
  rootDir: string,
  gitHash: string
): Promise<string[] | null> {
  if (!gitHash || gitHash === "unknown") return null;
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "--name-only", gitHash, "HEAD"],
      { cwd: rootDir }
    );
    return stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    return null;
  }
}

function parseSnapshotResponse(raw: string): {
  features: Record<string, FeatureEntry>;
  flows: Record<string, FlowEntry>;
} {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      features: parsed.features ?? {},
      flows: parsed.flows ?? {},
    };
  } catch {
    // Try to find JSON object in the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          features: parsed.features ?? {},
          flows: parsed.flows ?? {},
        };
      } catch {
        return { features: {}, flows: {} };
      }
    }
    return { features: {}, flows: {} };
  }
}

const SOURCE_GLOB =
  "**/*.{ts,tsx,js,jsx,kt,kts,java,py,go,rs,swift,rb,cs,cpp,c,dart}";
const SOURCE_IGNORE = [
  "**/node_modules/**", "**/dist/**", "**/build/**", "**/.gradle/**",
  "**/target/**", "**/.git/**", "**/vendor/**", "**/__pycache__/**",
  "**/venv/**", "**/.venv/**", "**/*.min.*", "**/*.map",
  "**/generated/**", "**/R.java", "**/BuildConfig.java",
];

export const DEFAULT_BATCH_SIZE = 50;
const SKELETON_CHARS = 500;
const DEEP_SAMPLE_CHARS = 1500;
const DEEP_SAMPLES_PER_BATCH = 3;

export interface SnapshotBatch {
  offset: number;
  batchSize: number;
  nextOffset: number | null;
  totalFiles: number;
  skeletons: Array<{ path: string; content: string }>;
  samples: Array<{ path: string; content: string }>;
  testPairs: Array<{ test: string; source: string; confidence: string }>;
}

async function listSourceFiles(resolvedRoot: string): Promise<string[]> {
  const all = await fg(SOURCE_GLOB, {
    cwd: resolvedRoot,
    ignore: SOURCE_IGNORE,
  });
  // Deterministic order so the same offset always returns the same batch.
  return [...all].sort();
}

export async function prepareSnapshotBatch(
  rootDir: string,
  offset: number,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<SnapshotBatch> {
  const resolvedRoot = path.resolve(rootDir);
  const allFiles = await listSourceFiles(resolvedRoot);
  const totalFiles = allFiles.length;
  const safeOffset = Math.max(0, Math.min(offset, totalFiles));
  const batchPaths = allFiles.slice(safeOffset, safeOffset + batchSize);

  const skeletons: Array<{ path: string; content: string }> = [];
  for (const filePath of batchPaths) {
    const full = await readFullFile(resolvedRoot, filePath);
    if (full) {
      skeletons.push({
        path: full.path,
        content: full.content.slice(0, SKELETON_CHARS),
      });
    }
  }

  // Pick a few files from this batch to read deeply for grounding. Spread
  // evenly across the batch so the deep samples represent the batch's range.
  const samples: Array<{ path: string; content: string }> = [];
  if (skeletons.length > 0) {
    const step = Math.max(1, Math.floor(skeletons.length / DEEP_SAMPLES_PER_BATCH));
    for (let i = 0; i < skeletons.length && samples.length < DEEP_SAMPLES_PER_BATCH; i += step) {
      const full = await readFullFile(resolvedRoot, skeletons[i].path);
      if (full) {
        samples.push({
          path: full.path,
          content: full.content.slice(0, DEEP_SAMPLE_CHARS),
        });
      }
    }
  }

  // Only include test pairs that involve files in this batch — keeps the
  // appendix relevant and small.
  const batchPathSet = new Set(batchPaths);
  const allTestPairs = (await buildTestMap(resolvedRoot)).paired;
  const testPairs = allTestPairs.filter(
    (p) => batchPathSet.has(p.test) || batchPathSet.has(p.source)
  );

  const nextOffset =
    safeOffset + batchSize >= totalFiles ? null : safeOffset + batchSize;

  return {
    offset: safeOffset,
    batchSize,
    nextOffset,
    totalFiles,
    skeletons,
    samples,
    testPairs,
  };
}

export async function prepareSnapshotInput(
  rootDir: string
): Promise<{
  filesWithContent: Array<{ path: string; content: string }>;
  testPairs: Array<{ test: string; source: string; confidence: string }>;
}> {
  const resolvedRoot = path.resolve(rootDir);

  // Scale sample count with codebase size: ~15% of source files, clamped to [20, 80]
  const allFiles = await fg(
    "**/*.{ts,tsx,js,jsx,kt,kts,java,py,go,rs,swift,rb,cs,cpp,c,dart}",
    {
      cwd: resolvedRoot,
      ignore: [
        "**/node_modules/**", "**/dist/**", "**/build/**", "**/.gradle/**",
        "**/target/**", "**/.git/**", "**/vendor/**", "**/__pycache__/**",
        "**/venv/**", "**/.venv/**", "**/*.min.*", "**/*.map",
        "**/generated/**", "**/R.java", "**/BuildConfig.java",
      ],
    }
  );
  const sampleCount = Math.min(80, Math.max(20, Math.round(allFiles.length * 0.15)));

  const sampled = await sampleFiles(resolvedRoot, sampleCount);

  const filesWithContent: Array<{ path: string; content: string }> = [];
  for (const sample of sampled) {
    const full = await readFullFile(resolvedRoot, sample.path);
    if (full) {
      filesWithContent.push({ path: full.path, content: full.content });
    }
  }

  const testMap = await buildTestMap(resolvedRoot);

  return { filesWithContent, testPairs: testMap.paired };
}

export async function createSnapshot(
  rootDir: string,
  config: MasonConfig
): Promise<Snapshot> {
  const resolvedRoot = path.resolve(rootDir);
  const { filesWithContent, testPairs } = await prepareSnapshotInput(rootDir);

  const gitHash = await getCurrentGitHash(resolvedRoot);
  const now = new Date().toISOString();

  if (filesWithContent.length === 0) {
    return {
      version: 2,
      createdAt: now,
      updatedAt: now,
      gitHash,
      features: {},
      flows: {},
    };
  }

  // Call LLM to build concept map
  const userMessage = buildSnapshotPrompt(filesWithContent, testPairs);
  const result = await callLLM(config, userMessage, SNAPSHOT_SYSTEM_PROMPT);

  const resultText =
    typeof result === "string" ? result : result.type === "response" ? result.text : "";

  if (!resultText) {
    throw new Error(
      "No CLI or API key available for this provider. Use claude or ollama (no key needed), or provide an API key."
    );
  }

  const { features, flows } = parseSnapshotResponse(resultText);

  const snapshot: Snapshot = {
    version: 2,
    createdAt: now,
    updatedAt: now,
    gitHash,
    features,
    flows,
  };

  await saveSnapshot(resolvedRoot, snapshot);
  return snapshot;
}

export async function updateSnapshot(
  rootDir: string,
  config: MasonConfig
): Promise<{ status: string; details: string }> {
  const resolvedRoot = path.resolve(rootDir);
  const existing = await loadSnapshot(resolvedRoot);

  if (!existing) {
    const snapshot = await createSnapshot(rootDir, config);
    const featureCount = Object.keys(snapshot.features).length;
    const flowCount = Object.keys(snapshot.flows).length;
    return {
      status: "created",
      details: `New snapshot: ${featureCount} features, ${flowCount} flows`,
    };
  }

  // Find files changed since last snapshot
  const changed = await getChangedFilesSince(resolvedRoot, existing.gitHash);
  if (changed === null) {
    // Full rebuild if git diff fails
    const snapshot = await createSnapshot(rootDir, config);
    const featureCount = Object.keys(snapshot.features).length;
    return { status: "rebuilt", details: `${featureCount} features` };
  }
  const changedFiles = changed;

  if (changedFiles.length === 0) {
    return { status: "up-to-date", details: "No changes since last snapshot" };
  }

  // Check which changed files are architecturally relevant
  const sampled = await sampleFiles(resolvedRoot, 30);
  const sampledPaths = new Set(sampled.map((s) => s.path));

  // Also check which changed files are referenced in the existing snapshot
  const snapshotFiles = new Set<string>();
  for (const feature of Object.values(existing.features)) {
    for (const f of feature.files) snapshotFiles.add(f);
    for (const t of feature.tests ?? []) snapshotFiles.add(t);
  }
  for (const flow of Object.values(existing.flows)) {
    for (const f of flow.chain) snapshotFiles.add(f);
  }

  const relevantChanges = changedFiles.filter(
    (f) => sampledPaths.has(f) || snapshotFiles.has(f)
  );

  if (relevantChanges.length === 0) {
    // Changes don't affect snapshot files
    existing.gitHash = await getCurrentGitHash(resolvedRoot);
    existing.updatedAt = new Date().toISOString();
    await saveSnapshot(resolvedRoot, existing);
    return {
      status: "unchanged",
      details: `${changedFiles.length} files changed but none affect the concept map`,
    };
  }

  // Read changed files and ask LLM to update the map
  const filesWithContent: Array<{ path: string; content: string }> = [];
  for (const filePath of relevantChanges) {
    const full = await readFullFile(resolvedRoot, filePath);
    if (full) {
      filesWithContent.push({ path: full.path, content: full.content });
    }
  }

  if (filesWithContent.length === 0) {
    return { status: "unchanged", details: "Changed files could not be read" };
  }

  const userMessage = buildIncrementalPrompt(filesWithContent, {
    features: existing.features,
    flows: existing.flows,
  });

  const result = await callLLM(config, userMessage, SNAPSHOT_SYSTEM_PROMPT);
  const resultText =
    typeof result === "string" ? result : result.type === "response" ? result.text : "";

  if (!resultText) {
    throw new Error("No CLI or API key available for this provider.");
  }

  const { features, flows } = parseSnapshotResponse(resultText);
  const gitHash = await getCurrentGitHash(resolvedRoot);

  existing.features = features;
  existing.flows = flows;
  existing.updatedAt = new Date().toISOString();
  existing.gitHash = gitHash;

  await saveSnapshot(resolvedRoot, existing);

  return {
    status: "updated",
    details: `${Object.keys(features).length} features, ${Object.keys(flows).length} flows (${relevantChanges.length} files changed)`,
  };
}

