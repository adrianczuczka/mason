import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFileAccess } from "../utils/files.js";
export { SOURCE_GLOB, SOURCE_IGNORE } from "../utils/files.js";
import { readStoreJson, writeStoreJson, type StoreDiagnostic } from "../utils/storage.js";
import { z } from "zod";
import { normalizeRepoPath } from "../utils/paths.js";
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
   * when absent (older snapshots) — see normalizeFeatureType.
   */
  type?: "capability" | "infrastructure";
  /**
   * When an assistant last confirmed this entry's files actually implement
   * the claimed feature (verify_snapshot flow). Absent on older snapshots
   * and never-verified entries. Drift checks freshness against git; this
   * checks the map was CORRECT in the first place.
   */
  verifiedAt?: string;
  verifiedHash?: string;
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
  verifiedHash?: string;
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

const repoPath = z.string().refine(value => normalizeRepoPath(value) !== null, "Expected a relative repository path");
const verificationFields = {
  refreshedHash: z.string().optional(), verifiedAt: z.string().optional(),
  verifiedHash: z.string().optional(), verificationFailed: z.boolean().optional(),
  verificationNote: z.string().optional(),
};
export const featureSchema = z.object({
  description: z.string(), files: z.array(repoPath), tests: z.array(repoPath).optional(),
  type: z.enum(["capability", "infrastructure"]).optional(), ...verificationFields,
}).passthrough();
export const flowSchema = z.object({ description: z.string(), chain: z.array(repoPath), ...verificationFields }).passthrough();
const snapshotSchema = z.object({
  version: z.literal(2), createdAt: z.string(), updatedAt: z.string(), gitHash: z.string(),
  features: z.record(featureSchema), flows: z.record(flowSchema),
}).passthrough();

export async function loadSnapshot(rootDir: string): Promise<Snapshot | null> {
  const parsed = await readStoreJson(rootDir, ".mason/snapshot.json");
  if (parsed === null || (parsed as { version?: number }).version === 1) return null;
  const result = snapshotSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid Mason snapshot: ${result.error.message}`);
  return result.data;
}

/** Context and onboarding can use decisions even when the optional map is broken. */
export async function inspectSnapshot(rootDir: string): Promise<{
  status: "available" | "missing" | "invalid";
  snapshot: Snapshot | null;
  diagnostics: StoreDiagnostic[];
}> {
  try {
    const raw = await readStoreJson(rootDir, ".mason/snapshot.json");
    const snapshot = raw === null ? null : snapshotSchema.parse(raw);
    return { status: snapshot ? "available" : "missing", snapshot, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", snapshot: null, diagnostics: [{
      path: ".mason/snapshot.json", message: error instanceof Error ? error.message : String(error),
    }] };
  }
}

export async function saveSnapshot(rootDir: string, snapshot: Snapshot): Promise<void> {
  await writeStoreJson(rootDir, ".mason/snapshot.json", snapshotSchema.parse(snapshot));
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
  return (await createFileAccess(resolvedRoot)).list();
}

export async function prepareSnapshotBatch(
  rootDir: string,
  offset: number,
  batchSize: number = DEFAULT_BATCH_SIZE,
  scopeFiles?: string[]
): Promise<SnapshotBatch> {
  const resolvedRoot = path.resolve(rootDir);
  const access = await createFileAccess(resolvedRoot);
  let allFiles = await access.list();
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
    const full = await access.read(filePath);
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
      const full = await access.read(skeletons[i].path);
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
