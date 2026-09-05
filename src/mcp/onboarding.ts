import { computeAudit } from "../audit/audit.js";
import { computeReview, defaultBase } from "../review/review.js";
import { getWorkingTree } from "../drift/drift.js";
import { inspectSnapshot } from "../snapshot/snapshot.js";
import { decisionApproval, effectiveDecision } from "../decisions/provenance.js";
import { summarizeEvidence } from "../review/evidence.js";
import { loadDecisionStore } from "../decisions/decisions.js";

const MAX_FINDINGS = 20;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

async function auditSummary(root: string) {
  try {
    const report = await computeAudit(root);
    if (!report) return { status: "no-context-files", reason: "No AGENTS.md, CLAUDE.md, or .claude/CLAUDE.md found to audit." };
    if (!report.gitAvailable) return { status: "unavailable", reason: "Audit needs readable Git history to verify documentation claims.", docs: report.docs };
    return {
      ...report, status: "complete",
      issues: report.issues.slice(0, MAX_FINDINGS),
      advisories: report.advisories.slice(0, MAX_FINDINGS),
      suppressedAdvisories: (report.suppressedAdvisories ?? []).slice(0, MAX_FINDINGS),
      counts: { issues: report.issues.length, advisories: report.advisories.length,
        suppressedAdvisories: report.suppressedAdvisories?.length ?? 0 },
      truncated: report.issues.length > MAX_FINDINGS || report.advisories.length > MAX_FINDINGS ||
        (report.suppressedAdvisories?.length ?? 0) > MAX_FINDINGS,
    };
  } catch (error) { return { status: "unavailable", reason: reason(error) }; }
}

async function reviewSummary(root: string, requestedBase?: string, evidence?: string[]) {
  const workingTree = await getWorkingTree(root);
  const scope = "committed" as const;
  try {
    const base = requestedBase ?? await defaultBase(root);
    if (!base) return { status: "unavailable", scope, workingTree, reason: "No default review base resolves. Pass base to mason_init, or run mason-review --base <ref>." };
    const report = await computeReview(root, base, { evidence });
    if (!report) return { status: "unavailable", scope, base, workingTree, reason: "The review base, merge base, or committed diff could not be read." };
    return {
      ...report, scope, workingTree,
      ...(report.evidence ? { evidence: summarizeEvidence(report.evidence) } : {}),
      status: !report.historyAvailable ? "unavailable" : report.changedFiles.length ? "complete" : "no-changes",
      ...(!report.historyAvailable ? { reason: "Co-change history could not be read; review findings are incomplete." } : {}),
      changedFiles: report.changedFiles.slice(0, MAX_FINDINGS),
      missingPartners: report.missingPartners.slice(0, MAX_FINDINGS),
      touchedDecisions: report.touchedDecisions.slice(0, MAX_FINDINGS),
      counts: { changedFiles: report.changedFiles.length, missingPartners: report.missingPartners.length, touchedDecisions: report.touchedDecisions.length },
      truncated: report.truncated || [report.changedFiles, report.missingPartners, report.touchedDecisions].some(list => list.length > MAX_FINDINGS),
      hint: "Reviews cover merge-base..HEAD. Uncommitted paths are reported separately in workingTree; they have not been reviewed.",
    };
  } catch (error) { return { status: "unavailable", scope, workingTree, reason: reason(error) }; }
}

/** Useful first-run results, with no writes, model calls, or map requirement. */
export async function inspectOnboarding(root: string, base?: string, evidence?: string[]) {
  const [audit, review, map, decisions] = await Promise.all([
    auditSummary(root), reviewSummary(root, base, evidence), inspectSnapshot(root), loadDecisionStore(root),
  ]);
  return {
    audit, review, map: { status: map.status },
    decisions: {
      active: decisions.records.filter(record => record.status === "active").length,
      ...Object.fromEntries(["accepted", "proposed", "unreviewed"].map(approval => [approval, decisions.records.filter(record => record.status === "active" && decisionApproval(effectiveDecision(record)) === approval).length])),
      pendingProposals: decisions.records.filter(record => effectiveDecision(record) !== record).length,
    },
    diagnostics: [...map.diagnostics, ...decisions.diagnostics],
  };
}
