import { z } from "zod";
import { anchorCaptureSchema, changedCaptureFiles } from "../decisions/anchors.js";
import type { Inputs } from "./evidence.js";
import { digest } from "../audit/findings.js";
import type { State } from "./store.js";
import type { AutomationEvent, AutomationReport } from "./runtime.js";

const evidenceSchema = z.record(z.object({ digest: z.string(), capture: anchorCaptureSchema }));
export const stopReviewSchema = z.object({
  pending: z.record(z.object({ head: z.string(), evidence: evidenceSchema })),
  edited: z.record(z.record(z.string().nullable())),
  delivered: z.record(z.object({ digest: z.string(), files: z.record(z.string().nullable()) })),
});
type Session = State["sessions"][string];
const empty = (): z.infer<typeof stopReviewSchema> => ({ pending: {}, edited: {}, delivered: {} });

/** Only paired captures establish observed edits, independently of commits and dirty status. */
export function observeDecisionEdits(session: Session, inputs: Inputs, event: AutomationEvent) {
  if (event.host !== "claude" || !event.mutating || !event.toolId) return;
  const state = (session.stopReview ??= empty());
  if (event.event === "before_tool") {
    state.pending[event.toolId] = { head: inputs.head, evidence: inputs.decisionEvidence };
  } else if (event.event === "after_tool") {
    const before = state.pending[event.toolId];
    delete state.pending[event.toolId];
    // A pull/merge/checkout can change content without a local edit. If HEAD moved,
    // retain earlier observations but do not attribute this interval to the agent.
    if (!before || before.head !== inputs.head) return;
    for (const [id, previous] of Object.entries(before.evidence)) {
      const current = inputs.decisionEvidence[id];
      if (
        !current ||
        !previous.capture.complete ||
        !current.capture.complete ||
        digest(previous.capture.anchors) !== digest(current.capture.anchors)
      )
        continue;
      const edited = (state.edited[id] ??= {});
      for (const file of changedCaptureFiles(previous.capture, current.capture)) {
        edited[file] = current.capture.files[file] ?? null;
      }
    }
  }
}

/** Delivery is not resolution. Only explicit resolution clears its receipt. */
export function clearResolvedStopReviews(sessions: State["sessions"], report: AutomationReport) {
  if (
    report.status === "unavailable" ||
    report.checks.skipped.some((check) => check.check === "decision-anchor-drift")
  )
    return;
  const active = new Set(
    report.findings.flatMap((finding) => {
      const evidence = (finding.current ?? finding.original).evidence;
      return evidence.kind === "decision-anchor" &&
        finding.status !== "resolved" &&
        (finding.current || finding.status === "unverified")
        ? [evidence.decisionId]
        : [];
    }),
  );
  for (const session of Object.values(sessions)) {
    if (!session.stopReview) continue;
    for (const id of Object.keys(session.stopReview.delivered)) {
      if (!active.has(id)) delete session.stopReview.delivered[id];
    }
  }
}

export function decisionStopReview(
  session: Session,
  inputs: Inputs,
  report: AutomationReport,
  reentry: boolean,
) {
  const state = (session.stopReview ??= empty());
  const decisions = new Map<
    string,
    { title: string; digest: string; files: Record<string, string | null> }
  >();
  for (const finding of report.findings) {
    const evidence = finding.current?.evidence;
    if (
      finding.status === "resolved" ||
      finding.status === "unverified" ||
      evidence?.kind !== "decision-anchor"
    )
      continue;
    const current = inputs.decisionEvidence[evidence.decisionId];
    const edited = state.edited[evidence.decisionId];
    if (
      !current?.capture.complete ||
      !edited ||
      !evidence.changedFiles.some(
        (file) =>
          Object.hasOwn(edited, file) && edited[file] === (current.capture.files[file] ?? null),
      )
    )
      continue;
    const value = decisions.get(evidence.decisionId) ?? {
      title: evidence.title,
      digest: current.digest,
      files: {},
    };
    for (const file of evidence.changedFiles) {
      if (Object.hasOwn(edited, file) && edited[file] === (current.capture.files[file] ?? null))
        value.files[file] = edited[file];
    }
    decisions.set(evidence.decisionId, value);
  }
  if (!decisions.size) return { reason: null, block: false };
  let fresh = false;
  for (const [id, value] of decisions) {
    const previous = state.delivered[id];
    if (
      previous?.digest !== value.digest ||
      Object.entries(value.files).some(
        ([file, digest]) => !Object.hasOwn(previous.files, file) || previous.files[file] !== digest,
      )
    )
      fresh = true;
    // Consume feedback on re-entry too: another hook may have continued the turn.
    state.delivered[id] = {
      digest: value.digest,
      files: { ...(previous?.digest === value.digest ? previous.files : {}), ...value.files },
    };
  }
  const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 250);
  const reason = [
    "Mason: unresolved decision drift overlaps changes observed during this session. Before ending the turn, inspect these decisions:",
    ...[...decisions].map(
      ([id, value]) =>
        `Decision ${JSON.stringify(safe(value.title))} (${safe(id)}): review_decision(action: "prepare", id: ${JSON.stringify(id)}).`,
    ),
    'Check the claims against the source and diff. If no contradiction is found, record action: "inspect" with the reviewToken, actual inspector, and a note explaining the evidence. "Expected changes" or "my own commits" are not evidence.',
    "If contradicted or uncertain, explain the mismatch to the user and request direction. Do not accept, reaffirm, or retire a decision without authorized human review. A revised proposal leaves the accepted revision operative until reviewed.",
    `Evidence: ${report.reportPath}. Concurrent changes can contribute; captures do not prove authorship. This reminder does not resolve the finding.`,
  ].join("\n");
  return { reason, block: !reentry && fresh };
}
