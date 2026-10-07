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

/** Match an inventory to every scope in one pass through its path components. */
export function indexMatchingPaths(scopes: readonly (readonly string[])[], files: Iterable<string>): string[][] {
  interface Node { children: Map<string, Node>; scopes: Set<number> }
  const node = (): Node => ({ children: new Map(), scopes: new Set() });
  const root = node();
  const matches: string[][] = scopes.map(() => []);
  scopes.forEach((anchors, index) => {
    for (const anchor of anchors) {
      const normalized = normalizeRepoPath(anchor);
      if (!normalized) continue;
      let current = root;
      for (const part of normalized.split("/")) {
        if (!current.children.has(part)) current.children.set(part, node());
        current = current.children.get(part)!;
      }
      current.scopes.add(index);
    }
  });
  for (const file of new Set(files)) {
    const normalized = normalizeRepoPath(file);
    if (!normalized) continue;
    const selected = new Set<number>();
    let current: Node | undefined = root;
    for (const part of normalized.split("/")) {
      current = current.children.get(part);
      if (!current) break;
      for (const index of current.scopes) selected.add(index);
    }
    for (const index of selected) matches[index].push(file);
  }
  return matches;
}
