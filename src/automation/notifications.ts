import { z } from "zod";
import type { RepairFinding } from "../audit/repair.js";
import { digest } from "../audit/findings.js";

// Compare conditions, not report wording, line numbers, commit IDs, or timestamps.
const conditionSchema = z.object({
  level: z.number(), facts: z.array(z.string()), magnitude: z.number().optional(),
});
const MAX_COMPLETION_FINDINGS = 4;

type Condition = z.infer<typeof conditionSchema>;
export const notificationStateSchema = z.object({
  version: z.literal(1), baselineHead: z.string(),
  baseline: z.record(conditionSchema),
  delivered: z.record(conditionSchema),
  cleared: z.array(z.string()),
  diagnostics: z.array(z.string()),
});
export type NotificationState = z.infer<typeof notificationStateSchema>;

function condition(finding: RepairFinding): { id: string; condition: Condition } {
  const source = finding.current ?? finding.original;
  const e = source.evidence;
  // Decision approval/revision changes alone do not create a new drift condition.
  const id = e.kind === "decision-anchor" ? digest([source.type, source.anchor.doc, e.decisionId]) : finding.id;
  const result: Condition = { level: "confidence" in source ? 2 : 1, facts: [] };
  switch (e.kind) {
    case "count-mismatch": result.magnitude = Math.abs(e.actual - e.claimed); break;
    case "unmentioned-dir": result.magnitude = e.sourceFileCount; break;
    case "decision-anchor": result.facts = [...e.changedFiles].sort(); break;
    case "doc-behind-manifests":
      result.facts = (e.matches ?? []).map(m => JSON.stringify([m.manifest, m.dependency, m.after])).sort();
      break;
    // For missing paths/scripts, the finding ID already identifies the condition.
  }
  return { id, condition: result };
}

export function notificationConditions(findings: RepairFinding[]): Record<string, Condition> {
  const active = findings.filter(f => f.status !== "resolved");
  const currentIds = new Set(active.filter(f => f.current).map(f => condition(f).id));
  const result: Record<string, Condition> = {};
  for (const f of active) {
    const value = condition(f);
    // Historical revisions must not override current evidence for the same decision.
    if (!f.current && currentIds.has(value.id)) continue;
    const previous = result[value.id];
    result[value.id] = previous ? {
      level: Math.max(previous.level, value.condition.level),
      facts: [...new Set([...previous.facts, ...value.condition.facts])].sort(),
      ...(previous.magnitude !== undefined || value.condition.magnitude !== undefined
        ? { magnitude: Math.max(previous.magnitude ?? 0, value.condition.magnitude ?? 0) } : {}),
    } : value.condition;
  }
  return result;
}

export function createNotificationState(findings: RepairFinding[], head: string): NotificationState {
  return { version: 1, baselineHead: head, baseline: notificationConditions(findings), delivered: {}, cleared: [], diagnostics: [] };
}

function worsened(current: Condition, previous?: Condition): boolean {
  return !previous || current.level > previous.level ||
    (current.magnitude ?? 0) > (previous.magnitude ?? 0) ||
    current.facts.some(fact => !previous.facts.includes(fact));
}

/** Called only at completion. Sessions and explicit audits never consume pending notices. */
export function completionFindings(state: NotificationState, findings: RepairFinding[]): RepairFinding[] {
  const current = notificationConditions(findings);
  const cleared = new Set(state.cleared);
  const resolvedIds = new Set(findings.filter(f => f.status === "resolved").map(f => condition(f).id));
  for (const id of Object.keys(state.baseline)) if (resolvedIds.has(id) && !current[id]) cleared.add(id);
  state.cleared = [...cleared];

  const selected: RepairFinding[] = [];
  const selectedIds = new Set<string>();
  const delivered: Record<string, Condition> = { ...state.delivered };
  for (const finding of findings) {
    const value = condition(finding);
    const previous = state.delivered[value.id];
    value.condition = current[value.id] ?? value.condition;
    // Missing or temporarily unverified evidence must not erase delivery history.
    if (finding.status === "unverified" || !finding.current && finding.status !== "resolved") {
      continue;
    }
    if (finding.status === "resolved") {
      if (!current[value.id]) delete delivered[value.id];
      continue;
    }
    const eligible = cleared.has(value.id) || worsened(value.condition, state.baseline[value.id]);
    if (!eligible) continue;
    if (!selectedIds.has(value.id) && worsened(value.condition, previous)) {
      selectedIds.add(value.id);
      const source = finding.current!;
      selected.push(source.evidence.kind === "decision-anchor"
        ? { ...finding, current: { ...source, evidence: { ...source.evidence, changedFiles: value.condition.facts } } }
        : finding);
      // Only displayed findings count as delivered. Overflow remains eligible
      // for the next completion, including after a session restart.
      if (selected.length <= MAX_COMPLETION_FINDINGS) delivered[value.id] = value.condition;
    }
  }
  state.delivered = delivered;
  return selected;
}

export function completionSummary(findings: RepairFinding[], reportPath: string): string | null {
  if (!findings.length) return null;
  const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 250);
  return [
    `Mason: ${findings.length} new or worsened finding(s) since the retained baseline.`,
    ...findings.slice(0, MAX_COMPLETION_FINDINGS).map(f => {
      const source = f.current ?? f.original;
      const detail = source.evidence.kind === "decision-anchor"
        ? `Changes to ${source.evidence.changedFiles.join(", ")} may affect decision "${source.evidence.title}". Inspect the diff if relevant; acceptance is not required.`
        : source.message;
      return `[${f.status === "unresolved" ? "issue" : "advisory"}] ${safe(source.anchor.doc)}: ${safe(detail)}`;
    }),
    ...(findings.length > MAX_COMPLETION_FINDINGS ? [`${findings.length - MAX_COMPLETION_FINDINGS} more in the report; pending a later completion notice.`] : []),
    `Evidence: ${reportPath}. Explicit audit: mason_automation(action: "check").`,
    "Inspect findings within the authorized work. Concurrent changes may also contribute; this summary does not establish who introduced them.",
  ].join("\n");
}
