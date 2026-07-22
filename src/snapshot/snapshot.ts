import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { readFullFile } from "../mcp/sampler.js";
import { buildTestMap } from "../test-map.js";

const exec = promisify(execFile);

export interface FeatureEntry {
  description: string;
  files: string[];
  tests?: string[];
  /**
   * Commit this entry was last verified against. Entries updated by an
   * incremental save carry HEAD here; untouched entries keep the hash the
   * map had before the save, so drift stays visible per entry. Absent means
   * "as of the snapshot's top-level gitHash".
   */
  refreshedHash?: string;
  /**
   * Whether this is a user-facing capability or internal infrastructure
   * (DI wiring, config loading, logging, provider/transport plumbing).
   * Capabilities are published to product-facing docs (Confluence);
   * infrastructure stays in the AI concept map only. Defaults to "capability"
   * when absent (older snapshots) or unrecognized — see normalizeFeatureType.
   */
  type?: "capability" | "infrastructure";
  /**
   * When an assistant last confirmed this entry's files actually implement
   * the claimed feature (verify_snapshot flow). Absent on older snapshots
   * and never-verified entries. Drift checks freshness against git; this
   * checks the map was CORRECT in the first place.
   */
  verifiedAt?: string;
  /** Set when verification judged the entry wrong — re-map it. */
  verificationFailed?: boolean;
  verificationNote?: string;
}

export type FeatureType = "capability" | "infrastructure";

/**
 * Coerce an arbitrary type value to a known classification. Anything that
 * isn't explicitly "infrastructure" defaults to "capability" — so older
 * snapshots and unclassified entries are treated as user-facing (published),
 * never silently hidden.
 */
export function normalizeFeatureType(value: unknown): FeatureType {
  return value === "infrastructure" ? "infrastructure" : "capability";
}

export interface FlowEntry {
  description: string;
  chain: string[];
  /** See FeatureEntry.refreshedHash. */
  refreshedHash?: string;
  /** See FeatureEntry.verifiedAt / verificationFailed. */
  verifiedAt?: string;
  verificationFailed?: boolean;
  verificationNote?: string;
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

export async function listSourceFiles(resolvedRoot: string): Promise<string[]> {
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
  batchSize: number = DEFAULT_BATCH_SIZE,
  scopeFiles?: string[]
): Promise<SnapshotBatch> {
  const resolvedRoot = path.resolve(rootDir);
  let allFiles = await listSourceFiles(resolvedRoot);
  if (scopeFiles) {
    // Intersect with the real source list: keeps ignore rules and path safety,
    // and silently drops scope entries that no longer exist on disk. An empty
    // scope stays empty — it must not fall back to walking the whole project.
    const scopeSet = new Set(scopeFiles);
    allFiles = allFiles.filter((f) => scopeSet.has(f));
  }
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
