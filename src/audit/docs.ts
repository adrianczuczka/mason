import { execGit } from "../utils/git-read.js";
import { profilePhase } from "../utils/profile.js";
import fs from "node:fs/promises";
import path from "node:path";
import { extractClaims } from "./claims.js";
import { lastCommitOf } from "./git.js";
import fg from "fast-glob";
import { auditGlob, auditInputPath, readAuditInput } from "./inputs.js";
import { loadProjectConfig } from "../utils/files.js";
import { auditGitPaths } from "./inspection.js";
import type { CommitRef, DocClaims } from "./types.js";


/**
 * Instruction entry points written by setup. Audit discovery is broader and
 * preserves actual filename casing; setup/teardown must not edit every README.
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
  /** Directory whose instructions this document describes, not a proven shell cwd. */
  scope: string;
  kind: "instructions" | "readme";
  lineCount: number;
  /** Null when the doc is untracked. */
  lastCommit: CommitRef | null;
  /** Uncommitted edits present. */
  dirty: boolean;
  claims: DocClaims;
}

async function dirtyDocs(resolvedRoot: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  try {
    const dirty = new Set<string>();
    for (let offset = 0; offset < files.length; offset += 256) {
      const { stdout } = await execGit(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files.slice(offset, offset + 256).map(file => `:(literal)${file}`)],
        { cwd: resolvedRoot, maxBuffer: 16 * 1024 * 1024, timeout: 10000 }
      );
      const entries = stdout.split("\0");
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i]) continue;
        const status = entries[i].slice(0, 2);
        dirty.add(entries[i].slice(3));
        // Porcelain -z emits destination first, then the original rename/copy path.
        if (/[RC]/.test(status) && entries[i + 1]) dirty.add(entries[++i]);
      }
    }
    return dirty;
  } catch {
    return new Set(files);
  }
}

/** Readme/instruction discovery shares the exact inventory used by automation. */
export async function discoverDocPaths(root: string): Promise<string[]> {
  let candidates: string[] = [];
  try {
    candidates = await auditGitPaths(root, "documents");
  } catch (error) {
    // Outside Git we still discover documents so the audit can report Git unavailable.
    try { await execGit(["rev-parse", "--git-dir"], { cwd: root }); }
    catch { return localDocPaths(root); }
    throw error;
  }
  candidates.push(...await localDocPaths(root));
  const config = await loadProjectConfig(root);
  const excluded = ["**/node_modules/**", "**/vendor/**", "**/dist/**", "**/build/**", "**/target/**",
    "**/.git/**", "**/.venv/**", "**/venv/**", ".mason/**", ...(config.ignore ?? [])];
  // Static patterns preserve literal metacharacters and reject selected symlinks.
  const paths: string[] = [];
  const unique = [...new Set(candidates)].sort();
  for (let offset = 0; offset < unique.length; offset += 256) {
    paths.push(...await auditGlob(root, unique.slice(offset, offset + 256).map(p => fg.escapePath(p)), {
      ignore: excluded, followSymbolicLinks: false, label: "Documentation discovery",
    }));
    if (paths.length > 10000) throw new Error("Documentation discovery exceeds 10,000 relevant files; narrow .mason/config.json ignore patterns.");
  }
  const priority = (file: string) => {
    const index = (DOC_CANDIDATES as readonly string[]).findIndex(p => p.toLowerCase() === file.toLowerCase());
    return index < 0 ? DOC_CANDIDATES.length : index;
  };
  return paths.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
}

/** Explicit local entry points may be ignored; preserve their real spelling. */
async function localDocPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const dir of [".", ".claude"]) {
    let entries;
    try { entries = await fs.readdir(await auditInputPath(root, dir), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const entry of entries) if (/^(?:agents|claude|readme)\.md$/i.test(entry.name)) {
      paths.push(path.posix.join(dir, entry.name));
    }
  }
  return paths;
}

export function documentScope(file: string): string {
  const parent = path.posix.dirname(file);
  return path.posix.basename(parent).toLowerCase() === ".claude" ? path.posix.dirname(parent) : parent;
}

export async function discoverDocs(resolvedRoot: string): Promise<AuditDoc[]> {
  return profilePhase("audit.documents", () => readDocs(resolvedRoot));
}

async function readDocs(resolvedRoot: string): Promise<AuditDoc[]> {
  const docs: AuditDoc[] = [];
  const files = await discoverDocPaths(resolvedRoot);
  const dirty = await dirtyDocs(resolvedRoot, files);
  // Bound concurrent Git processes even when discovery reaches thousands of docs.
  for (let offset = 0; offset < files.length; offset += 4) {
    docs.push(...await Promise.all(files.slice(offset, offset + 4).map(async (candidate): Promise<AuditDoc> => {
      const [content, lastCommit] = await Promise.all([readAuditInput(resolvedRoot, candidate),
        profilePhase("audit.document-history", () => lastCommitOf(resolvedRoot, candidate))]);
      if (content === null) throw new Error("Document disappeared during discovery: " + candidate);
      return { path: candidate, content, scope: documentScope(candidate),
        kind: /^readme\.md$/i.test(path.posix.basename(candidate)) ? "readme" : "instructions",
        lineCount: content.split("\n").length, lastCommit, dirty: dirty.has(candidate), claims: extractClaims(content) };
    })));
  }
  return docs;
}
