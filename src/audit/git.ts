import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommitRef } from "./types.js";

const exec = promisify(execFile);

const COMMIT_FORMAT = "%H%x09%cI%x09%s";

function parseCommitLine(line: string): CommitRef | null {
  const parts = line.split("\t");
  if (parts.length < 3 || !parts[0]) return null;
  return { hash: parts[0], date: parts[1], subject: parts.slice(2).join("\t") };
}

/** Most recent commit touching a path, or null if the path was never tracked. */
export async function lastCommitOf(
  resolvedRoot: string,
  relPath: string
): Promise<CommitRef | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", "-1", `--format=${COMMIT_FORMAT}`, "--", relPath],
      { cwd: resolvedRoot }
    );
    const line = stdout.trim().split("\n")[0];
    return line ? parseCommitLine(line) : null;
  } catch {
    return null;
  }
}

/** The commit that deleted a path, or null if none did. */
export async function deletingCommitOf(
  resolvedRoot: string,
  relPath: string
): Promise<CommitRef | null> {
  try {
    const { stdout } = await exec(
      "git",
      [
        "log",
        "-1",
        "--diff-filter=D",
        `--format=${COMMIT_FORMAT}`,
        "--",
        relPath,
      ],
      { cwd: resolvedRoot }
    );
    const line = stdout.trim().split("\n")[0];
    return line ? parseCommitLine(line) : null;
  } catch {
    return null;
  }
}

/** Oldest commit touching a path (used to date a directory's appearance). */
export async function firstCommitOf(
  resolvedRoot: string,
  relPath: string
): Promise<CommitRef | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", "--reverse", `--format=${COMMIT_FORMAT}`, "--", relPath],
      { cwd: resolvedRoot, maxBuffer: 10 * 1024 * 1024 }
    );
    const line = stdout.trim().split("\n")[0];
    return line ? parseCommitLine(line) : null;
  } catch {
    return null;
  }
}

export interface RangeCommits {
  commits: Array<CommitRef & { files: string[] }>;
  total: number;
}

/**
 * Commits in fromHash..HEAD touching any of the pathspecs, newest first, with
 * the touched files per commit. Rev-range, not --since: immune to rebase date
 * skew and CI checkout mtimes. Returns null when the range is uncomputable
 * (unreachable base commit, shallow clone, no git).
 */
export async function commitsTouchingSince(
  resolvedRoot: string,
  fromHash: string,
  pathspecs: string[]
): Promise<RangeCommits | null> {
  if (!fromHash || fromHash === "unknown") return null;
  try {
    const { stdout } = await exec(
      "git",
      [
        "log",
        `${fromHash}..HEAD`,
        `--format=%x01${COMMIT_FORMAT}`,
        "--name-only",
        "--",
        ...pathspecs,
      ],
      { cwd: resolvedRoot, maxBuffer: 10 * 1024 * 1024 }
    );

    const commits: Array<CommitRef & { files: string[] }> = [];
    // \x01 marks each commit header so name-only file lists can't be
    // mistaken for headers.
    for (const block of stdout.split("\x01")) {
      if (!block.trim()) continue;
      const lines = block.split("\n").filter((l) => l.trim().length > 0);
      const ref = parseCommitLine(lines[0]);
      if (!ref) continue;
      commits.push({ ...ref, files: lines.slice(1).map((l) => l.trim()) });
    }
    return { commits, total: commits.length };
  } catch {
    return null;
  }
}
