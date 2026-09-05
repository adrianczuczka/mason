import { computeDecisionDrift } from "../../decisions/drift.js";
import { loadDecisionStore } from "../../decisions/decisions.js";
import { decisionProvenance, effectiveDecision } from "../../decisions/provenance.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

/**
 * Advisory only, and only when .mason/decisions/ exists (the zero-setup
 * path stays dark on bare repos). Decision records encode human knowledge —
 * they are surfaced for re-verification, never rewritten by the fix agent.
 */
export async function checkDecisionAnchors(
  ctx: CheckContext
): Promise<CheckResult> {
  const result = emptyResult();
  if (!ctx.decisionsPresent) return result;

  const store = await loadDecisionStore(ctx.root);
  const records = store.records;
  for (const diagnostic of store.diagnostics) result.skipped.push({ check: "decision-anchor-drift", reason: `${diagnostic.path}: ${diagnostic.message}` });
  const drift = await computeDecisionDrift(ctx.root, records);
  if (!drift.historyAvailable) {
    result.skipped.push({
      check: "decision-anchor-drift",
      reason: "some decision base commits are unreachable (shallow clone?)",
    });
  }

  const changed = records.flatMap(record => [
    { record: effectiveDecision(record), changedFiles: drift.staleDecisions[record.id] ?? [], freshness: drift.freshness?.[record.id] ?? "unknown" },
    { record, changedFiles: drift.pendingProposals?.[record.id]?.changedFiles ?? [], freshness: drift.pendingProposals?.[record.id]?.freshness ?? "unknown" },
  ] as const);
  for (const { record, changedFiles, freshness } of changed) {
    if (!changedFiles.length) continue;
    const id = record.id;
    const provenance = decisionProvenance(record, freshness);
    result.advisories.push({
      type: "decision-anchor-drift",
      message: `decision "${record.title}" (${provenance.approval}) has anchor files that changed since its evidence baseline – needs human review`,
      anchor: {
        doc: `.mason/decisions/${id}.json`,
        line: null,
        excerpt: record.title,
      },
      evidence: {
        kind: "decision-anchor",
        provenance,
        decisionId: id,
        title: record.title,
        changedFiles,
        refreshedHash: record.refreshedHash,
      },
    });
  }

  return result;
}
