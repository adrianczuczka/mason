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
import type { Freshness } from "../context/trust.js";
import { matchingPaths } from "../utils/paths.js";

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

export interface WorkingTreeReport {
  available: boolean;
  changedFiles: string[];
  untrackedFiles: string[];
}

export interface DriftReport {
  /** Live entry state; committed drift alone continues to drive CLI exit codes. */
  featureFreshness?: Record<string, Freshness>;
  flowFreshness?: Record<string, Freshness>;
  workingTree?: WorkingTreeReport;
  verification?: { neverVerified: number; failed: string[] };
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

function parseChanges(output: string): FileChange[] {
  const fields = output.split("\0");
  const changes: FileChange[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const code = fields[i++];
    const first = fields[i++];
    if (!first) break;
    const second = /^[RC]/.test(code) ? fields[i++] : undefined;
    const change: FileChange = second
      ? code.startsWith("R") ? { status: "renamed", path: second, previousPath: first } : { status: "added", path: second }
      : { status: code === "A" ? "added" : code === "D" ? "deleted" : "modified", path: first };
    if (change.path.startsWith(".mason/") && (!change.previousPath || change.previousPath.startsWith(".mason/"))) continue;
    changes.push(change);
  }
  return changes;
}

export function touchedPaths(changes: FileChange[]): string[] {
  return [...new Set(changes.flatMap(c => c.previousPath ? [c.previousPath, c.path] : [c.path]))].sort();
}

export async function getChangesWithStatus(resolvedRoot: string, fromHash: string, toHash = "HEAD"): Promise<FileChange[] | null> {
  if (!fromHash || fromHash === "unknown" || fromHash.startsWith("-") || !toHash || toHash === "unknown" || toHash.startsWith("-")) return null;
  try {
    const { stdout } = await exec("git", ["diff", "--name-status", "-z", "-M", fromHash, toHash, "--"], { cwd: resolvedRoot, maxBuffer: 10 * 1024 * 1024 });
    return parseChanges(stdout);
  } catch { return null; }
}

export async function getWorkingTree(resolvedRoot: string): Promise<WorkingTreeReport> {
  try {
    const [diff, untracked] = await Promise.all([
      exec("git", ["diff", "--name-status", "-z", "-M", "HEAD", "--"], { cwd: resolvedRoot, maxBuffer: 10 * 1024 * 1024 }),
      exec("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: resolvedRoot, maxBuffer: 10 * 1024 * 1024 }),
    ]);
    const untrackedFiles = untracked.stdout.split("\0").filter(f => f && !f.startsWith(".mason/"));
    return { available: true, changedFiles: [...new Set([...touchedPaths(parseChanges(diff.stdout)), ...untrackedFiles])].sort(), untrackedFiles };
  } catch { return { available: false, changedFiles: [], untrackedFiles: [] }; }
}

async function countCommitsBehind(
  resolvedRoot: string,
  fromHash: string
): Promise<number | null> {
  if (!fromHash || fromHash === "unknown" || fromHash.startsWith("-")) return null;
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
export async function computeDrift(rootDir: string): Promise<DriftReport | null> {
  const root = path.resolve(rootDir);
  const snapshot = await loadSnapshot(root);
  if (!snapshot) return null;
  const [headHash, workingTree] = await Promise.all([getCurrentGitHash(root), getWorkingTree(root)]);
  const hashFor = (entry: { refreshedHash?: string }) => entry.refreshedHash ?? snapshot.gitHash;
  const entries = [...Object.values(snapshot.features), ...Object.values(snapshot.flows)];
  const hashes = new Set([snapshot.gitHash, ...entries.map(hashFor)]);
  const changesByHash = new Map<string, FileChange[] | null>();
  await Promise.all([...hashes].map(async hash => {
    changesByHash.set(hash, hash === headHash && headHash !== "unknown" ? [] : await getChangesWithStatus(root, hash));
  }));
  const historyAvailable = headHash !== "unknown" && [...changesByHash.values()].every(changes => changes !== null);
  const mappedFiles = collectMappedFiles(snapshot);
  const report: DriftReport = {
    stale: !historyAvailable,
    snapshotHash: snapshot.gitHash, headHash,
    commitsBehind: 0, historyAvailable,
    changedFiles: [], staleFeatures: {}, staleFlows: {},
    totalFeatures: Object.keys(snapshot.features).length,
    totalFlows: Object.keys(snapshot.flows).length,
    unmappedFiles: [], ghostFiles: await findGhostFiles(root, mappedFiles), renames: [],
    recommendation: historyAvailable ? "up-to-date" : "full-rebuild",
    featureFreshness: {}, flowFreshness: {}, workingTree,
    verification: {
      neverVerified: entries.filter(e => !e.verifiedAt).length,
      failed: [...Object.entries(snapshot.features), ...Object.entries(snapshot.flows)].filter(([, e]) => e.verificationFailed).map(([name]) => name),
    },
  };
  const counts = await Promise.all([...hashes].map(hash => hash === headHash ? 0 : countCommitsBehind(root, hash)));
  const knownCounts = counts.filter((n): n is number => n !== null);
  report.commitsBehind = knownCounts.length ? Math.max(...knownCounts) : null;

  const check = (name: string, files: string[], hash: string, staleEntries: Record<string, string[]>, freshness: Record<string, Freshness>) => {
    const changes = changesByHash.get(hash);
    const committedHits = changes ? matchingPaths(files, touchedPaths(changes)) : [];
    if (committedHits.length) staleEntries[name] = committedHits;
    const localHits = matchingPaths(files, workingTree.changedFiles);
    freshness[name] = files.length === 0 || changes === null || changes === undefined || !workingTree.available ? "unknown"
      : committedHits.length || localHits.length || files.some(f => report.ghostFiles.includes(f)) ? "changed" : "current";
  };
  for (const [name, feature] of Object.entries(snapshot.features)) {
    check(name, [...feature.files, ...(feature.tests ?? [])], hashFor(feature), report.staleFeatures, report.featureFreshness!);
  }
  for (const [name, flow] of Object.entries(snapshot.flows)) {
    check(name, flow.chain, hashFor(flow), report.staleFlows, report.flowFreshness!);
  }

  const allChanges = [...changesByHash.values()].flatMap(changes => changes ?? []);
  report.changedFiles = [...new Set(allChanges.map(c => c.path))].sort();
  // Complete coverage, including omissions from a map saved at HEAD. Untracked
  // files remain in workingTree and never change the committed-drift exit code.
  const sourceFiles = new Set(await listSourceFiles(root));
  let committedFiles: Set<string> = new Set();
  try {
    const { stdout } = await exec("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], { cwd: root, maxBuffer: 50 * 1024 * 1024 });
    committedFiles = new Set(stdout.split("\0").filter(Boolean));
  } catch { report.historyAvailable = false; report.stale = true; }
  report.unmappedFiles = [...sourceFiles].filter(f => committedFiles.has(f) && !mappedFiles.has(f)).sort();
  const renames = new Map<string, { from: string; to: string }>();
  for (const change of allChanges) {
    if (change.status === "renamed" && change.previousPath) renames.set(`${change.previousPath}\0${change.path}`, { from: change.previousPath, to: change.path });
  }
  report.renames = [...renames.values()];
  const changedMapped = new Set([...Object.values(report.staleFeatures).flat(), ...Object.values(report.staleFlows).flat()]);
  // A locally deleted file is a live-edit warning, not committed map drift.
  const committedGhosts = report.ghostFiles.filter(f => !workingTree.changedFiles.includes(f));
  report.stale ||= changedMapped.size > 0 || report.unmappedFiles.length > 0 || committedGhosts.length > 0;
  if (!report.historyAvailable) report.recommendation = "full-rebuild";
  else if (!report.stale) report.recommendation = "up-to-date";
  else report.recommendation = changedMapped.size >= FULL_REBUILD_MIN_CHANGED_MAPPED_FILES && changedMapped.size / Math.max(1, mappedFiles.size) > FULL_REBUILD_FRACTION ? "full-rebuild" : "incremental";
  return report;
}
