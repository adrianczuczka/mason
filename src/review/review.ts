import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getChangesWithStatus, touchedPaths } from "../drift/drift.js";
import { decisionProvenance, decisionKnowledge, effectiveDecision } from "../decisions/provenance.js";
import { loadDecisionStore } from "../decisions/decisions.js";
import { matchingPaths } from "../utils/paths.js";
import { computeDecisionDrift } from "../decisions/drift.js";
import type { Freshness } from "../context/trust.js";
import type { StoreDiagnostic } from "../utils/storage.js";
import type { DecisionRecord } from "../decisions/decisions.js";
import { findMissingPartners } from "./cochange.js";
import type { CochangeFinding } from "./cochange.js";
import { collectReviewEvidence, type ReviewEvidence } from "./evidence.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";

const exec = promisify(execFile);

/** Diffs larger than this are refactors; partner analysis would be noise. */
const MAX_ANALYZED_FILES = 50;

export interface TouchedDecision extends Partial<ReturnType<typeof decisionProvenance>> {
  id: string;
  title: string;
  body: string;
  category: string;
  anchors: string[];
  freshness?: Freshness;
  touchedFiles: string[];
  pendingProposal?: NonNullable<ReturnType<typeof decisionKnowledge>["pendingProposal"]> & { touchedFiles: string[] };
}

export interface ReviewReport {
  /** Additive-only schema. */
  version: 1;
  diagnostics?: StoreDiagnostic[];
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
  /** Optional imported CI results. Does not change the legacy review exit codes. */
  evidence?: ReviewEvidence;
}

async function resolveMergeBase(
  resolvedRoot: string,
  base: string,
  head: string
): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["merge-base", base, head], {
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
  return matchingPaths(record.files, changedFiles);
}

/**
 * Review a diff against what git history and the decision store know:
 * co-change partners the diff forgot, and recorded constraints it touches.
 * Deterministic — no LLM, no network. Returns null when the base ref or
 * merge base cannot be resolved.
 */
export async function computeReview(
  rootDir: string,
  base: string,
  options: { evidence?: string[] } = {}
): Promise<ReviewReport | null> {
  const resolvedRoot = path.resolve(rootDir);
  const head = await getCurrentGitHash(resolvedRoot);
  if (head === "unknown") return null;
  const mergeBase = await resolveMergeBase(resolvedRoot, base, head);
  if (!mergeBase) return null;

  const changes = await getChangesWithStatus(resolvedRoot, mergeBase, head);
  if (changes === null) return null;

  const changedFiles = touchedPaths(changes);

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
  const store = await loadDecisionStore(resolvedRoot);
  report.diagnostics = store.diagnostics;
  const decisionDrift = await computeDecisionDrift(resolvedRoot, store.records);
  if (options.evidence !== undefined) {
    report.evidence = await collectReviewEvidence(resolvedRoot, options.evidence, changedFiles, store.records, decisionDrift.freshness, head);
    if (store.diagnostics.length) {
      report.evidence.diagnostics.push("Invalid decision records make knowledge associations incomplete; consult review diagnostics.");
      if (report.evidence.status === "passed") report.evidence.status = "incomplete";
    }
  }
  const finalize = async () => {
    if (report.evidence && await getCurrentGitHash(resolvedRoot) !== head) {
      report.evidence.diagnostics.push("HEAD changed during the review; rerun to obtain consistent change and knowledge associations.");
      for (const check of report.evidence.checks) check.freshness = "unknown";
      report.evidence.summary.stale = 0;
      report.evidence.summary.unknown = report.evidence.checks.length;
      if (report.evidence.status !== "unavailable") report.evidence.status = "incomplete";
    }
    return report;
  };
  if (changedFiles.length === 0) return finalize();

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
    },
    changedFiles
  );
  if (partners === null) {
    report.historyAvailable = false;
  } else {
    report.missingPartners = partners;
  }

  const decisions = store.records;
  for (const record of decisions) {
    if (record.status !== "active") continue;
    const effective = effectiveDecision(record);
    const touched = anchorsTouched(effective, changedFiles);
    const proposalTouched = effective !== record ? anchorsTouched(record, changedFiles) : [];
    if (touched.length > 0 || proposalTouched.length > 0) {
      const { pendingProposal, ...knowledge } = decisionKnowledge(record, decisionDrift.freshness?.[record.id] ?? "unknown", decisionDrift.pendingProposals?.[record.id]?.freshness ?? "unknown");
      report.touchedDecisions.push({
        ...knowledge,
        ...(pendingProposal ? { pendingProposal: { ...pendingProposal, touchedFiles: proposalTouched } } : {}),
        id: record.id,
        anchors: effective.files,
        freshness: decisionDrift.freshness?.[record.id] ?? "unknown",
        touchedFiles: touched,
      });
    }
  }

  return finalize();
}
