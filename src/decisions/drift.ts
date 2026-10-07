import { captureAnchorScopes, changedCaptureFiles, type AnchorCapture } from "./anchors.js";
import path from "node:path";
import { getChangesWithStatus, getWorkingTree, touchedPaths } from "../drift/drift.js";
import { matchingPaths } from "../utils/paths.js";
import type { Freshness } from "../context/trust.js";
import type { StoreDiagnostic } from "../utils/storage.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { loadDecisionStore } from "./decisions.js";
import type { DecisionRecord } from "./decisions.js";
import { effectiveDecision, latestDecisionInspection } from "./provenance.js";

/**
 * Deliberately separate from DriftReport: mason-drift's exit codes and
 * --json shape are a CI contract, and `stale` there means MAP staleness.
 * Decision staleness is additive on top.
 */
export interface DecisionDriftReport {
  historyAvailable: boolean;
  freshness?: Record<string, Freshness>;
  diagnostics?: StoreDiagnostic[];
  totalDecisions: number;
  /** Decision id → anchor files changed since the record's refreshedHash. */
  staleDecisions: Record<string, string[]>;
  /** Draft anchors have their own freshness; they cannot replace accepted anchors. */
  pendingProposals?: Record<string, { freshness: Freshness; changedFiles: string[] }>;
}

/**
 * Flag active decisions whose anchor files changed since the record was
 * last verified. Anchorless decisions have unknown freshness and do not
 * contribute to committed drift.
 * Deterministic — git only, no LLM.
 */
export async function computeDecisionDrift(
  rootDir: string,
  decisions?: DecisionRecord[]
): Promise<DecisionDriftReport> {
  const resolvedRoot = path.resolve(rootDir);
  const store = decisions ? { records: decisions, diagnostics: [] } : await loadDecisionStore(resolvedRoot);
  const report: DecisionDriftReport = { historyAvailable: true, totalDecisions: store.records.length, staleDecisions: {}, freshness: {}, diagnostics: store.diagnostics };
  const [head, workingTree] = await Promise.all([getCurrentGitHash(resolvedRoot), getWorkingTree(resolvedRoot)]);
  const changesByHash = new Map<string, string[] | null>();
  const baselines = store.records.filter(record => record.status === "active").flatMap(record => {
    const inspection = latestDecisionInspection(record);
    if (inspection) return [inspection.capture];
    return [...new Set([effectiveDecision(record), record])].flatMap(candidate =>
      candidate.version === 2 && candidate.capture ? [candidate.capture] : []);
  });
  const captures = await captureAnchorScopes(resolvedRoot, baselines.map(baseline => baseline.anchors));
  const currentCaptures = new Map(baselines.map((baseline, index) => [JSON.stringify(baseline.anchors), captures[index]]));
  const inspect = async (record: DecisionRecord, inspectionCapture?: AnchorCapture): Promise<{ freshness: Freshness; changedFiles: string[] }> => {
    if (record.files.length === 0) return { freshness: "unknown", changedFiles: [] };
    const baseline = inspectionCapture ?? (record.version === 2 ? record.capture : undefined);
    if (baseline) {
      const current = currentCaptures.get(JSON.stringify(baseline.anchors))!;
      const hits = changedCaptureFiles(baseline, current).filter(file => matchingPaths(record.files, [file]).length);
      return { freshness: !baseline.complete || !current.complete ? "unknown" : hits.length ? "changed" : "current", changedFiles: hits };
    }
    let touched = changesByHash.get(record.refreshedHash);
    if (touched === undefined) {
      const changes = record.refreshedHash === head && head !== "unknown" ? [] : await getChangesWithStatus(resolvedRoot, record.refreshedHash);
      touched = changes === null ? null : touchedPaths(changes);
      changesByHash.set(record.refreshedHash, touched);
    }
    if (touched === null) report.historyAvailable = false;
    const hits = touched ? matchingPaths(record.files, touched) : [];
    const localHits = matchingPaths(record.files, workingTree.changedFiles);
    return { freshness: touched === null || !workingTree.available ? "unknown" : hits.length || localHits.length ? "changed" : "current", changedFiles: hits };
  };
  for (const record of store.records) {
    if (record.status !== "active") continue;
    const effective = effectiveDecision(record);
    const inspection = latestDecisionInspection(record);
    const state = await inspect(effective, inspection?.capture);
    report.freshness![record.id] = state.freshness;
    if (state.changedFiles.length) report.staleDecisions[record.id] = state.changedFiles;
    if (effective !== record) (report.pendingProposals ??= {})[record.id] = await inspect(record, inspection?.capture);
  }
  return report;
}
