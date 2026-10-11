import { execGit } from "../utils/git-read.js";
import { createFileAccess } from "../utils/files.js";
import { readStoreJson, writeStoreJson, type StoreDiagnostic } from "../utils/storage.js";
import { z } from "zod";
import { withSnapshotWrite } from "./lock.js";
import { normalizeRepoPath } from "../utils/paths.js";

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
   * Capabilities describe user-facing functionality;
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
  /** Digest of the entry and bounded source evidence reviewed for this verdict. */
  verificationToken?: string;
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
  /** Digest of the entry and bounded source evidence reviewed for this verdict. */
  verificationToken?: string;
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

const repoPath = z
  .string()
  .refine((value) => normalizeRepoPath(value) !== null, "Expected a relative repository path");
const verificationFields = {
  refreshedHash: z.string().optional(),
  verifiedAt: z.string().optional(),
  verifiedHash: z.string().optional(),
  verificationToken: z.string().optional(),
  verificationFailed: z.boolean().optional(),
  verificationNote: z.string().optional(),
};
export const featureSchema = z
  .object({
    description: z.string(),
    files: z.array(repoPath),
    tests: z.array(repoPath).optional(),
    type: z.enum(["capability", "infrastructure"]).optional(),
    ...verificationFields,
  })
  .passthrough();
export const flowSchema = z
  .object({ description: z.string(), chain: z.array(repoPath), ...verificationFields })
  .passthrough();
const snapshotSchema = z
  .object({
    version: z.literal(2),
    createdAt: z.string(),
    updatedAt: z.string(),
    gitHash: z.string(),
    features: z.record(featureSchema),
    flows: z.record(flowSchema),
  })
  .passthrough();

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
    return {
      status: "invalid",
      snapshot: null,
      diagnostics: [
        {
          path: ".mason/snapshot.json",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/** Read and commit under one cross-process lock; a null snapshot means no write. */
export async function updateSnapshot<T>(
  rootDir: string,
  update: (current: Snapshot | null) => Promise<{
    snapshot: Snapshot | null;
    result: T;
  }>,
): Promise<T> {
  return withSnapshotWrite(rootDir, async () => {
    const change = await update(await loadSnapshot(rootDir));
    if (change.snapshot) {
      await writeStoreJson(rootDir, ".mason/snapshot.json", snapshotSchema.parse(change.snapshot));
    }
    return change.result;
  });
}

export async function getCurrentGitHash(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execGit(["rev-parse", "HEAD"], {
      cwd: rootDir,
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

export async function listSourceFiles(resolvedRoot: string): Promise<string[]> {
  return (await createFileAccess(resolvedRoot)).list();
}
