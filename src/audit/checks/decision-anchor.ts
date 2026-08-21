import { computeDecisionDrift } from "../../decisions/drift.js";
import { loadDecisions } from "../../decisions/decisions.js";
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

  const records = await loadDecisions(ctx.root);
  const drift = await computeDecisionDrift(ctx.root, records);
  if (!drift.historyAvailable) {
    result.skipped.push({
      check: "decision-anchor-drift",
      reason: "some decision base commits are unreachable (shallow clone?)",
    });
  }

  const byId = new Map(records.map((r) => [r.id, r]));
  for (const [id, changedFiles] of Object.entries(drift.staleDecisions)) {
    const record = byId.get(id);
    if (!record) continue;
    result.advisories.push({
      type: "decision-anchor-drift",
      message: `decision "${record.title}" has anchor files that changed since it was verified – needs human re-verification`,
      anchor: {
        doc: `.mason/decisions/${id}.json`,
        line: null,
        excerpt: record.title,
      },
      evidence: {
        kind: "decision-anchor",
        decisionId: id,
        title: record.title,
        changedFiles,
        refreshedHash: record.refreshedHash,
      },
    });
  }

  return result;
}
