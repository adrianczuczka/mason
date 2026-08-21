import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractClaims } from "./claims.js";
import { lastCommitOf } from "./git.js";
import type { CommitRef, DocClaims } from "./types.js";

const exec = promisify(execFile);

/**
 * All context files audited in v1, in the precedence order the setup
 * playbook uses. Every candidate that exists is audited — a repo can
 * legitimately carry both AGENTS.md and CLAUDE.md, and drift can live in
 * either.
 */
export const DOC_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
] as const;

export interface AuditDoc {
  /** Repo-relative posix path. */
  path: string;
  content: string;
  lineCount: number;
  /** Null when the doc is untracked. */
  lastCommit: CommitRef | null;
  /** Uncommitted edits present. */
  dirty: boolean;
  claims: DocClaims;
}

async function isDirty(resolvedRoot: string, relPath: string): Promise<boolean> {
  try {
    const { stdout } = await exec(
      "git",
      ["status", "--porcelain", "--", relPath],
      { cwd: resolvedRoot }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function discoverDocs(resolvedRoot: string): Promise<AuditDoc[]> {
  const docs: AuditDoc[] = [];
  for (const candidate of DOC_CANDIDATES) {
    let content: string;
    try {
      content = await fs.readFile(path.join(resolvedRoot, candidate), "utf-8");
    } catch {
      continue;
    }
    docs.push({
      path: candidate,
      content,
      lineCount: content.split("\n").length,
      lastCommit: await lastCommitOf(resolvedRoot, candidate),
      dirty: await isDirty(resolvedRoot, candidate),
      claims: extractClaims(content),
    });
  }
  return docs;
}
