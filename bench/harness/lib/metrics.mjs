import path from "node:path";

/** Make session Read paths relative to the repo root, dropping outside reads. */
export function relativizeReads(readFiles, repoDir) {
  const root = path.resolve(repoDir) + path.sep;
  return readFiles
    .map((p) => (path.resolve(p).startsWith(root) ? path.resolve(p).slice(root.length) : null))
    .filter(Boolean);
}

/**
 * First-action precision: of the first K distinct files the agent read, how
 * many are in the ground-truth set? Denominator is min(K, reads) so an agent
 * that answers from fewer, correct reads is not penalized. Returns null when
 * the agent read nothing (e.g. answered entirely from the concept map) —
 * report that case separately, it is a success mode, not a zero.
 */
export function firstActionPrecision(relativeReads, groundTruth, k = 5) {
  const firstK = relativeReads.slice(0, k);
  if (firstK.length === 0) return null;
  const gt = new Set(groundTruth);
  const hits = firstK.filter((f) => gt.has(f)).length;
  return hits / firstK.length;
}

/** Recall of ground-truth files within the first K reads. */
export function groundTruthRecall(relativeReads, groundTruth, k = 5) {
  if (groundTruth.length === 0) return null;
  const firstK = new Set(relativeReads.slice(0, k));
  const hits = groundTruth.filter((f) => firstK.has(f)).length;
  return hits / groundTruth.length;
}
