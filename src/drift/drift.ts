import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadSnapshot,
  getCurrentGitHash,
  listSourceFiles,
} from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot.js";

const exec = promisify(execFile);

// Incremental refresh stops paying off once a large share of the map is
// touched — but small absolute counts are always cheap to refresh in place,
// so both thresholds must be exceeded before recommending a full rebuild.
const FULL_REBUILD_FRACTION = 0.4;
const FULL_REBUILD_MIN_CHANGED_MAPPED_FILES = 10;

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  status: ChangeStatus;
  /** Current path (the new path for renames). */
  path: string;
  /** Pre-rename path, only present for renames. */
  previousPath?: string;
}

export type DriftRecommendation = "up-to-date" | "incremental" | "full-rebuild";

export interface DriftReport {
  stale: boolean;
  snapshotHash: string;
  headHash: string;
  /** Commits between the snapshot and HEAD; null when history is unavailable. */
  commitsBehind: number | null;
  /**
   * False when the snapshot commit is unreachable (shallow clone, rewritten
   * history) — staleFeatures/unmappedFiles/renames cannot be computed then.
   */
  historyAvailable: boolean;
  /** Current paths of every file changed since the snapshot. */
  changedFiles: string[];
  /** Stale feature name → the mapped files that changed under it. */
  staleFeatures: Record<string, string[]>;
  /** Stale flow name → the chain files that changed under it. */
  staleFlows: Record<string, string[]>;
  totalFeatures: number;
  totalFlows: number;
  /** New source files not referenced by any feature or flow. */
  unmappedFiles: string[];
  /** Files referenced by the map that no longer exist on disk. */
  ghostFiles: string[];
  renames: Array<{ from: string; to: string }>;
  recommendation: DriftRecommendation;
}

export async function getChangesWithStatus(
  resolvedRoot: string,
  fromHash: string
): Promise<FileChange[] | null> {
  if (!fromHash || fromHash === "unknown") return null;
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "--name-status", "-M", fromHash, "HEAD"],
      { cwd: resolvedRoot, maxBuffer: 10 * 1024 * 1024 }
    );

    const changes: FileChange[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      // Mason's own metadata changes on every save — never count it as drift.
      if (parts.some((p) => p.startsWith(".mason/"))) continue;
      const code = parts[0];
      if (code.startsWith("R") && parts.length >= 3) {
        changes.push({
          status: "renamed",
          path: parts[2],
          previousPath: parts[1],
        });
      } else if (code.startsWith("C") && parts.length >= 3) {
        // A copy leaves the original in place — only the new path is a change.
        changes.push({ status: "added", path: parts[2] });
      } else if (code === "A" && parts.length >= 2) {
        changes.push({ status: "added", path: parts[1] });
      } else if (code === "D" && parts.length >= 2) {
        changes.push({ status: "deleted", path: parts[1] });
      } else if (parts.length >= 2) {
        // M, T (typechange), and anything unrecognized count as modified.
        changes.push({ status: "modified", path: parts[1] });
      }
    }
    return changes;
  } catch {
    return null;
  }
}

async function countCommitsBehind(
  resolvedRoot: string,
  fromHash: string
): Promise<number | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-list", "--count", `${fromHash}..HEAD`],
      { cwd: resolvedRoot }
    );
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

function collectMappedFiles(snapshot: Snapshot): Set<string> {
  const mappedFiles = new Set<string>();
  for (const feature of Object.values(snapshot.features)) {
    for (const f of feature.files) mappedFiles.add(f);
    for (const t of feature.tests ?? []) mappedFiles.add(t);
  }
  for (const flow of Object.values(snapshot.flows)) {
    for (const f of flow.chain) mappedFiles.add(f);
  }
  return mappedFiles;
}

async function findGhostFiles(
  resolvedRoot: string,
  mappedFiles: Set<string>
): Promise<string[]> {
  const ghosts: string[] = [];
  for (const file of mappedFiles) {
    try {
      await fs.access(path.join(resolvedRoot, file));
    } catch {
      ghosts.push(file);
    }
  }
  return ghosts.sort();
}

/**
 * Compare the concept map against HEAD and report feature-level drift.
 * Fully deterministic — git + filesystem only, no LLM involved.
 * Returns null when no snapshot exists.
 */
export async function computeDrift(
  rootDir: string
): Promise<DriftReport | null> {
  const resolvedRoot = path.resolve(rootDir);
  const snapshot = await loadSnapshot(resolvedRoot);
  if (!snapshot) return null;

  const headHash = await getCurrentGitHash(resolvedRoot);
  const totalFeatures = Object.keys(snapshot.features).length;
  const totalFlows = Object.keys(snapshot.flows).length;

  // Each entry is only verified as of its refreshedHash (falling back to the
  // top-level gitHash), so drift is evaluated per distinct hash — a partially
  // refreshed map can be fresh at the top level and still hold stale entries.
  const hashFor = (entry: { refreshedHash?: string }): string =>
    entry.refreshedHash ?? snapshot.gitHash;

  const distinctHashes = new Set<string>([snapshot.gitHash]);
  for (const feature of Object.values(snapshot.features)) {
    distinctHashes.add(hashFor(feature));
  }
  for (const flow of Object.values(snapshot.flows)) {
    distinctHashes.add(hashFor(flow));
  }
  distinctHashes.delete("unknown");

  const staleHashes =
    headHash === "unknown"
      ? []
      : [...distinctHashes].filter((h) => h !== headHash);
  const stale = staleHashes.length > 0;

  const report: DriftReport = {
    stale,
    snapshotHash: snapshot.gitHash,
    headHash,
    commitsBehind: stale ? null : 0,
    historyAvailable: true,
    changedFiles: [],
    staleFeatures: {},
    staleFlows: {},
    totalFeatures,
    totalFlows,
    unmappedFiles: [],
    ghostFiles: [],
    renames: [],
    recommendation: "up-to-date",
  };

  if (!stale) return report;

  const mappedFiles = collectMappedFiles(snapshot);
  report.ghostFiles = await findGhostFiles(resolvedRoot, mappedFiles);

  const changesByHash = new Map<string, FileChange[]>();
  const touchedByHash = new Map<string, Set<string>>();
  for (const hash of staleHashes) {
    const changes = await getChangesWithStatus(resolvedRoot, hash);
    if (changes === null) {
      // One unreachable base commit is enough to make per-entry drift
      // uncomputable — we know the map is stale but not how.
      report.historyAvailable = false;
      report.recommendation = "full-rebuild";
      return report;
    }
    changesByHash.set(hash, changes);
    // Every path a change touches, old and new — an entry referencing either
    // side of a rename is stale.
    const touched = new Set<string>();
    for (const change of changes) {
      touched.add(change.path);
      if (change.previousPath) touched.add(change.previousPath);
    }
    touchedByHash.set(hash, touched);
  }

  // The oldest verification state in the map is the honest answer to "how
  // far behind is this snapshot".
  const commitCounts = await Promise.all(
    staleHashes.map((hash) => countCommitsBehind(resolvedRoot, hash))
  );
  const validCounts = commitCounts.filter((c): c is number => c !== null);
  report.commitsBehind =
    validCounts.length > 0 ? Math.max(...validCounts) : null;

  const emptySet = new Set<string>();
  const touchedFor = (entry: { refreshedHash?: string }): Set<string> =>
    touchedByHash.get(hashFor(entry)) ?? emptySet;

  for (const [name, feature] of Object.entries(snapshot.features)) {
    const touched = touchedFor(feature);
    const hits = [...feature.files, ...(feature.tests ?? [])].filter((f) =>
      touched.has(f)
    );
    if (hits.length > 0) report.staleFeatures[name] = [...new Set(hits)];
  }
  for (const [name, flow] of Object.entries(snapshot.flows)) {
    const touched = touchedFor(flow);
    const hits = flow.chain.filter((f) => touched.has(f));
    if (hits.length > 0) report.staleFlows[name] = [...new Set(hits)];
  }

  const allChanges = [...changesByHash.values()].flat();
  report.changedFiles = [...new Set(allChanges.map((c) => c.path))].sort();

  // New source files (added, or the new side of a rename) missing from the map.
  const sourceFileSet = new Set(await listSourceFiles(resolvedRoot));
  const newPaths = allChanges
    .filter((c) => c.status === "added" || c.status === "renamed")
    .map((c) => c.path);
  report.unmappedFiles = [...new Set(newPaths)]
    .filter((p) => sourceFileSet.has(p) && !mappedFiles.has(p))
    .sort();

  const renameKeys = new Set<string>();
  for (const change of allChanges) {
    if (change.status !== "renamed" || !change.previousPath) continue;
    const key = `${change.previousPath} ${change.path}`;
    if (renameKeys.has(key)) continue;
    renameKeys.add(key);
    report.renames.push({ from: change.previousPath, to: change.path });
  }

  const changedMapped = new Set<string>([
    ...Object.values(report.staleFeatures).flat(),
    ...Object.values(report.staleFlows).flat(),
  ]);
  const changedFraction =
    mappedFiles.size > 0 ? changedMapped.size / mappedFiles.size : 0;
  report.recommendation =
    changedMapped.size >= FULL_REBUILD_MIN_CHANGED_MAPPED_FILES &&
    changedFraction > FULL_REBUILD_FRACTION
      ? "full-rebuild"
      : "incremental";

  return report;
}
