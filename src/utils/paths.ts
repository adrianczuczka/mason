import path from "node:path";

/** One canonical representation for stored paths and decision anchors. */
export function normalizeRepoPath(value: string): string | null {
  const slash = value.replace(/\\/g, "/");
  if (!slash || slash.includes("\0") || path.posix.isAbsolute(slash) || /^[A-Za-z]:/.test(slash)) return null;
  if (slash.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(slash).replace(/\/$/, "");
  return normalized === "." ? null : normalized;
}

export function sanitizeRepoPaths(files: string[]): string[] {
  return [...new Set(files.map(normalizeRepoPath).filter((p): p is string => p !== null))];
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function anchorMatches(anchor: string, file: string): boolean {
  const a = normalizeRepoPath(anchor);
  const f = normalizeRepoPath(file);
  return a !== null && f !== null && (a === f || f.startsWith(`${a}/`));
}

export function matchingPaths(anchors: string[], files: Iterable<string>): string[] {
  return [...new Set(files)].filter(file => anchors.some(anchor => anchorMatches(anchor, file)));
}
