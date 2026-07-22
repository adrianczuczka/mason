import path from "node:path";
import { getChangesWithStatus } from "../drift/drift.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { loadDecisions } from "./decisions.js";
import type { DecisionRecord } from "./decisions.js";

/**
 * Deliberately separate from DriftReport: mason-drift's exit codes and
 * --json shape are a CI contract, and `stale` there means MAP staleness.
 * Decision staleness is additive on top.
 */
export interface DecisionDriftReport {
  historyAvailable: boolean;
  totalDecisions: number;
  /** Decision id → anchor files changed since the record's refreshedHash. */
  staleDecisions: Record<string, string[]>;
}

/**
 * Flag active decisions whose anchor files changed since the record was
 * last verified. Anchorless decisions are pure prose and never go stale.
 * Deterministic — git only, no LLM.
 */
export async function computeDecisionDrift(
  rootDir: string,
  decisions?: DecisionRecord[]
): Promise<DecisionDriftReport> {
  const resolvedRoot = path.resolve(rootDir);
  const records = decisions ?? (await loadDecisions(resolvedRoot));
  const report: DecisionDriftReport = {
    historyAvailable: true,
    totalDecisions: records.length,
    staleDecisions: {},
  };

  const head = await getCurrentGitHash(resolvedRoot);
  const changesByHash = new Map<string, Set<string> | null>();

  for (const record of records) {
    if (record.status !== "active" || record.files.length === 0) continue;
    if (record.refreshedHash === head) continue;

    let touched = changesByHash.get(record.refreshedHash);
    if (touched === undefined) {
      const changes = await getChangesWithStatus(
        resolvedRoot,
        record.refreshedHash
      );
      if (changes === null) {
        touched = null;
      } else {
        touched = new Set<string>();
        for (const change of changes) {
          touched.add(change.path);
          if (change.previousPath) touched.add(change.previousPath);
        }
      }
      changesByHash.set(record.refreshedHash, touched);
    }

    if (touched === null) {
      // Unreachable base commit — we know nothing per-file; surface that
      // rather than silently reporting the record fresh.
      report.historyAvailable = false;
      continue;
    }

    const hits = record.files.filter((f) => touched.has(f));
    if (hits.length > 0) {
      report.staleDecisions[record.id] = hits;
    }
  }

  return report;
}
