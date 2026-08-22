import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getChangesWithStatus } from "../drift/drift.js";
import { loadDecisions } from "../decisions/decisions.js";
import type { DecisionRecord } from "../decisions/decisions.js";
import { findMissingPartners } from "./cochange.js";
import type { CochangeFinding } from "./cochange.js";

const exec = promisify(execFile);

/** Diffs larger than this are refactors; partner analysis would be noise. */
const MAX_ANALYZED_FILES = 50;

export interface TouchedDecision {
  id: string;
  title: string;
  body: string;
  category: string;
  anchors: string[];
  touchedFiles: string[];
}

export interface ReviewReport {
  /** Additive-only schema. */
  version: 1;
  root: string;
  base: string;
  mergeBase: string;
  changedFiles: string[];
  /** Historical partners this diff leaves untouched — drive exit 1. */
  missingPartners: CochangeFinding[];
  /** Decisions whose anchors the diff touches — informational only. */
  touchedDecisions: TouchedDecision[];
  historyAvailable: boolean;
  truncated: boolean;
}

async function resolveMergeBase(
  resolvedRoot: string,
  base: string
): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["merge-base", base, "HEAD"], {
      cwd: resolvedRoot,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** First base ref that resolves: origin/HEAD, origin/main, origin/master, main. */
export async function defaultBase(resolvedRoot: string): Promise<string | null> {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main"]) {
    try {
      await exec("git", ["rev-parse", "--verify", "--quiet", ref], {
        cwd: resolvedRoot,
      });
      return ref;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function anchorsTouched(
  record: DecisionRecord,
  changedFiles: string[]
): string[] {
  return changedFiles.filter((file) =>
    record.files.some((anchor) => {
      const a = anchor.replace(/\/+$/, "");
      return a === file || file.startsWith(`${a}/`);
    })
  );
}

/**
 * Review a diff against what git history and the decision store know:
 * co-change partners the diff forgot, and recorded constraints it touches.
 * Deterministic — no LLM, no network. Returns null when the base ref or
 * merge base cannot be resolved.
 */
export async function computeReview(
  rootDir: string,
  base: string
): Promise<ReviewReport | null> {
  const resolvedRoot = path.resolve(rootDir);
  const mergeBase = await resolveMergeBase(resolvedRoot, base);
  if (!mergeBase) return null;

  const changes = await getChangesWithStatus(resolvedRoot, mergeBase);
  if (changes === null) return null;

  const changedFiles = [
    ...new Set(
      changes
        .filter((c) => c.status !== "deleted")
        .map((c) => c.path)
    ),
  ].sort();

  const report: ReviewReport = {
    version: 1,
    root: resolvedRoot,
    base,
    mergeBase,
    changedFiles,
    missingPartners: [],
    touchedDecisions: [],
    historyAvailable: true,
    truncated: false,
  };
  if (changedFiles.length === 0) return report;

  let analyzed = changedFiles;
  if (changedFiles.length > MAX_ANALYZED_FILES) {
    analyzed = changedFiles.slice(0, MAX_ANALYZED_FILES);
    report.truncated = true;
  }

  const partners = await findMissingPartners(
    resolvedRoot,
    analyzed,
    async (relPath) => {
      try {
        await fs.access(path.join(resolvedRoot, relPath));
        return true;
      } catch {
        return false;
      }
    }
  );
  if (partners === null) {
    report.historyAvailable = false;
  } else {
    report.missingPartners = partners;
  }

  const decisions = await loadDecisions(resolvedRoot);
  for (const record of decisions) {
    if (record.status !== "active" || record.files.length === 0) continue;
    const touched = anchorsTouched(record, changedFiles);
    if (touched.length > 0) {
      report.touchedDecisions.push({
        id: record.id,
        title: record.title,
        body: record.body,
        category: record.category,
        anchors: record.files,
        touchedFiles: touched,
      });
    }
  }

  return report;
}
