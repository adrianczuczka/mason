import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * History window for the co-change matrix. One capped git log for the whole
 * repo — unlike impact.ts's per-target walk, review analyzes many files at
 * once and needs a single pass.
 */
const HISTORY_COMMITS = 1500;

/** Below this many commits for a file, a co-change rate is noise. */
const MIN_FILE_COMMITS = 5;
/** A partner must share at least this many commits to count. */
const MIN_SHARED_COMMITS = 4;
/** ...and appear in at least this fraction of the changed file's commits. */
const MIN_COCHANGE_RATE = 0.6;
/** Commits touching more files than this are refactors, not signal. */
const MAX_COMMIT_FILES = 30;

export interface CochangeFinding {
  changedFile: string;
  missingPartner: string;
  sharedCommits: number;
  fileCommits: number;
  /** sharedCommits / fileCommits, rounded to 2 places. */
  rate: number;
}

interface CochangeMatrix {
  commitsByFile: Map<string, Set<number>>;
  totalCommits: number;
}

async function buildMatrix(resolvedRoot: string): Promise<CochangeMatrix | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", `-n${HISTORY_COMMITS}`, "--format=%x01", "--name-only", "-M"],
      { cwd: resolvedRoot, maxBuffer: 100 * 1024 * 1024 }
    );
    const commitsByFile = new Map<string, Set<number>>();
    const blocks = stdout.split("\x01");
    let index = 0;
    for (const block of blocks) {
      const files = block
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith(".mason/"));
      if (files.length === 0 || files.length > MAX_COMMIT_FILES) continue;
      for (const file of files) {
        let set = commitsByFile.get(file);
        if (!set) {
          set = new Set();
          commitsByFile.set(file, set);
        }
        set.add(index);
      }
      index++;
    }
    return { commitsByFile, totalCommits: index };
  } catch {
    return null;
  }
}

/**
 * For each changed file, find its historical co-change partners that this
 * diff leaves untouched: files that appeared in >= MIN_COCHANGE_RATE of the
 * changed file's commits (within the window) but are absent from the diff.
 * Deterministic — pure git history, no LLM. Returns null when history is
 * unavailable.
 */
export async function findMissingPartners(
  resolvedRoot: string,
  changedFiles: string[],
  existsOnDisk: (relPath: string) => Promise<boolean>
): Promise<CochangeFinding[] | null> {
  const matrix = await buildMatrix(resolvedRoot);
  if (!matrix) return null;

  const changedSet = new Set(changedFiles);
  const findings: CochangeFinding[] = [];

  for (const changedFile of changedFiles) {
    const fileCommits = matrix.commitsByFile.get(changedFile);
    if (!fileCommits || fileCommits.size < MIN_FILE_COMMITS) continue;

    for (const [partner, partnerCommits] of matrix.commitsByFile) {
      if (partner === changedFile || changedSet.has(partner)) continue;
      let shared = 0;
      for (const c of fileCommits) {
        if (partnerCommits.has(c)) shared++;
      }
      if (shared < MIN_SHARED_COMMITS) continue;
      const rate = shared / fileCommits.size;
      if (rate < MIN_COCHANGE_RATE) continue;
      if (!(await existsOnDisk(partner))) continue;
      findings.push({
        changedFile,
        missingPartner: partner,
        sharedCommits: shared,
        fileCommits: fileCommits.size,
        rate: Math.round(rate * 100) / 100,
      });
    }
  }

  findings.sort((a, b) => b.rate - a.rate || b.sharedCommits - a.sharedCommits);
  return findings;
}
