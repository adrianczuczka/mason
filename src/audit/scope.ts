import fs from "node:fs/promises";
import path from "node:path";
import { auditInputPath } from "./inputs.js";
import { documentScope } from "./docs.js";
import type { ClaimScope, PathClaim } from "./types.js";

/** Lexical containment, before inspecting any path from documentation. */
export function scopedPath(directory: string, value: string): string | null {
  if (path.posix.isAbsolute(value) || value.includes("\\") || /[\x00-\x1f]/.test(value)) return null;
  const resolved = path.posix.normalize(path.posix.join(directory, value));
  return resolved === ".." || resolved.startsWith("../") ? null : resolved;
}

export function pathClaimScope(doc: string, claim: PathClaim): ClaimScope | null {
  const directory = claim.relativeTo === "document" ? path.posix.dirname(doc) : documentScope(doc);
  const local = scopedPath(directory, claim.path);
  if (!local) return null;
  const candidates = claim.relativeTo === "document" || directory === "." ? [local]
    : [...new Set([local, scopedPath(".", claim.path)].filter((p): p is string => p !== null))];
  return { basis: claim.relativeTo === "document" ? "document-link" : directory === "." ? "repository" : "document",
    directory, candidates };
}

/** Missing is distinct from unreadable/unsafe; cache and checks use the same observation. */
export async function pathExists(root: string, file: string): Promise<boolean> {
  const absolute = await auditInputPath(root, file);
  try { await fs.access(absolute); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function optionalMasonPath(file: string): boolean {
  return file.split("/").includes(".mason");
}
