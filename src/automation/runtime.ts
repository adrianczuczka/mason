import { loadDecisionStore } from "../decisions/decisions.js";
import { driftExcerpt, formatDriftExcerpt } from "../decisions/excerpts.js";
import { checkDecisionAnchors } from "../audit/checks/decision-anchor.js";
import { readAutomationConfig } from "./config.js";
import {
  observeDecisionEdits,
  decisionStopReview,
  clearResolvedStopReviews,
} from "./stop-review.js";
import { observeUsefulness } from "./usefulness.js";
import { completionFindings, completionSummary, createNotificationState } from "./notifications.js";
import { profilePhase } from "../utils/profile.js";
import { withRepositoryInspection } from "../audit/inspection.js";
import { recordExecution, executionStatus, failureNotifications } from "./execution.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  withRepairSession,
  reportSchema,
  findingId,
  repairFindingSchema,
  type RepairFinding,
  type RepairVerification,
} from "../audit/repair.js";
import { ALL_CHECKS, type AuditReport } from "../audit/types.js";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import {
  checkCache,
  git,
  hash,
  readInputs,
  readGuidanceInputs,
  workspace,
  type Inputs,
} from "./evidence.js";
import { boundPending } from "./pending-tools.js";
import {
  clearPendingTools,
  parseState,
  pruneSessions,
  serializeState,
  SESSION_LIMIT,
  STATE_READ_MAX_BYTES,
  withLock,
  type Event,
  type Host,
  type State,
} from "./store.js";

export interface AutomationEvent {
  event: Event;
  host?: Host;
  sessionId?: string;
  toolId?: string;
  mutating?: boolean;
  retrievedDecisionIds?: string[];
  stopHookActive?: boolean;
}
export interface AutomationReport {
  version: 1;
  status: "verified" | "issues-remain" | "incomplete" | "unavailable";
  root: string;
  branch: string;
  head: string;
  baselinePaths: string[];
  reportPath: string;
  findings: RepairFinding[];
  diagnostics: string[];
  checks: {
    ran: string[];
    reused: string[];
    skipped: NonNullable<AuditReport>["skippedChecks"];
    shared?: boolean;
    auditReused?: boolean;
  };
  counts: RepairVerification["counts"];
  capture: "observed" | "unknown";
  scope: string;
}

const SCOPE =
  "Documentation audit evidence only. Hook receipts show observed events, not complete interception. Resolved findings no longer fail their checks or have a recorded assessment covering current evidence. Repair and review only within the user's task authorization.";
const priority = { resolved: 0, "review-required": 1, unresolved: 2, unverified: 3 };
const cleanText = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 250);

/** Read tools cannot create repair evidence. Observe their lifecycle without rescanning the checkout. */
export async function observeReadOnlyTool(dir: string, event: AutomationEvent) {
  const ws = await profilePhase("automation.workspace", () => workspace(dir));
  await withLock(ws.root, ws.directory, async () => {
    const statePath = ws.directory + "/state.json";
    const raw = await readStoreJson(ws.root, statePath, STATE_READ_MAX_BYTES);
    if (raw === null) return;
    const state = parseState(raw);
    if (state.root !== ws.root || state.gitDir !== ws.gitDir || state.branch !== ws.branch) {
      throw new Error(
        "Automation state belongs to another branch or worktree; original evidence was retained.",
      );
    }
    const session =
      event.host && event.sessionId ? state.sessions[hash([event.host, event.sessionId])] : null;
    if (!session) return;
    const now = new Date().toISOString();
    session.lastUsed = now;
    session.events[event.event] = { at: now, count: (session.events[event.event]?.count ?? 0) + 1 };
    // Do not advance the audit fingerprint, report, or execution verdict: no check ran.
    await writeStoreJson(
      ws.root,
      statePath,
      serializeState(state, hash([event.host, event.sessionId])),
      {
        compact: true,
      },
    );
  });
  return { root: ws.root, directory: ws.directory };
}

export function summarize(report: AutomationReport): string {
  const open = report.findings.filter((f) => f.status !== "resolved");
  const onlyReview =
    report.status === "incomplete" &&
    !report.diagnostics.length &&
    !report.counts.unresolved &&
    !report.counts.unverified &&
    report.counts["review-required"] > 0;
  return [
    onlyReview
      ? `Mason: ${report.counts["review-required"]} advisor${report.counts["review-required"] === 1 ? "y" : "ies"} awaiting review; no unresolved issues.`
      : `Mason: ${report.status}; ${report.counts.unresolved} unresolved, ${report.counts["review-required"]} need review, ${report.counts.unverified} unverified.`,
    ...open.slice(0, 4).map((f) => {
      const detail = f.current
        ? f.current.message
        : f.status === "review-required"
          ? `${f.original.type}: current check no longer reports ${f.original.type === "deps-changed" ? "this condition" : "the original finding"}; historical evidence awaits assessment.`
          : `Original evidence: ${f.original.message}. ${f.reason}`;
      return `[${f.status}] ${cleanText(f.original.anchor.doc)}: ${cleanText(detail)}`;
    }),
    ...(open.length > 4 ? [`${open.length - 4} more findings in the report.`] : []),
    ...report.diagnostics.slice(0, 2).map(cleanText),
    `Evidence: ${report.reportPath}. Resume/check with mason_automation(action: "check") or mason check.`,
    "Keep original evidence. Address findings relevant to the authorized task; report unrelated findings with a brief scope reason and suggested follow-up. Use mason audit review for authorized assessments; otherwise leave advisories open without approving them.",
  ].join("\n");
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

async function loadState(ws: Workspace): Promise<State> {
  const raw = await readStoreJson(ws.root, ws.directory + "/state.json", STATE_READ_MAX_BYTES);
  const state =
    raw === null
      ? {
          version: 1 as const,
          root: ws.root,
          gitDir: ws.gitDir,
          branch: ws.branch,
          baselines: [],
          sessions: {},
          updatedAt: new Date().toISOString(),
          fingerprint: null,
          latest: null,
        }
      : parseState(raw);
  if (state.root !== ws.root || state.gitDir !== ws.gitDir || state.branch !== ws.branch) {
    throw new Error(
      "Automation state belongs to another branch or worktree; original evidence was retained.",
    );
  }
  return state;
}

const analysisSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  completedAt: z.number(),
  baselineDigest: z.string(),
  currentAudit: reportSchema.nullable().optional(),
  report: z.object({
    version: z.literal(1),
    status: z.enum(["verified", "issues-remain", "incomplete", "unavailable"]),
    root: z.string(),
    branch: z.string(),
    head: z.string(),
    baselinePaths: z.array(z.string()),
    reportPath: z.string(),
    findings: z.array(repairFindingSchema),
    diagnostics: z.array(z.string()),
    checks: z.object({
      ran: z.array(z.string()),
      reused: z.array(z.string()),
      skipped: z.array(
        z.object({ check: z.string(), reason: z.string(), doc: z.string().optional() }),
      ),
      auditReused: z.boolean().optional(),
    }),
    counts: z.object({
      resolved: z.number(),
      unresolved: z.number(),
      "review-required": z.number(),
      unverified: z.number(),
    }),
    capture: z.enum(["observed", "unknown"]),
    scope: z.string(),
  }),
});
const sharedSchema = z.object({ analysis: analysisSchema, digest: z.string() });
type Analysis = z.infer<typeof analysisSchema>;
const baselineDigest = async (ws: Workspace, state: State) =>
  profilePhase("automation.baselines", async () =>
    hash(
      await Promise.all(
        state.baselines.map(async (b) => [b.path, await readStoreJson(ws.root, b.path)]),
      ),
    ),
  );

async function matchingAnalysis(
  ws: Workspace,
  state: State,
  inputs: Inputs,
): Promise<{ analysis: Analysis | null; diagnostic?: string }> {
  const pointer = state.analysis;
  if (!pointer || pointer.fingerprint !== inputs.fingerprint) return { analysis: null };
  if (pointer.path !== ws.directory + "/checks/analysis-" + inputs.fingerprint + ".json") {
    throw new Error("Invalid automation analysis cache path; inspect the retained state.");
  }
  // This is a derived cache, not original repair evidence. Missing or malformed
  // data can be rebuilt, but storage/permission failures and unsafe paths remain
  // errors. Never discard or replace an original baseline to recover a cache.
  const invalid = {
    analysis: null,
    diagnostic:
      "Discarded an invalid current-audit cache; audit preparation and original verification were repeated.",
  };
  let raw: unknown;
  try {
    raw = await readStoreJson(ws.root, pointer.path);
  } catch (error) {
    const cause = (error as Error).cause;
    if (
      cause instanceof SyntaxError ||
      (cause instanceof Error && cause.message === "expected a JSON object, received null")
    )
      return invalid;
    throw error;
  }
  if (raw === null) return { analysis: null };
  const parsed = sharedSchema.safeParse(raw);
  if (!parsed.success) return invalid;
  const stored = parsed.data;
  const a = stored.analysis;
  if (
    stored.digest !== hash(a) ||
    a.id !== pointer.id ||
    a.fingerprint !== inputs.fingerprint ||
    a.completedAt !== pointer.completedAt ||
    a.report.root !== ws.root ||
    a.report.branch !== ws.branch ||
    a.report.head !== inputs.head ||
    hash(a.report.baselinePaths) !== hash(state.baselines.map((b) => b.path))
  ) {
    return invalid;
  }
  if (a.baselineDigest !== (await baselineDigest(ws, state)))
    throw new Error("Repair baseline was modified; use the original baseline.");
  return { analysis: a };
}

async function verifyInputs(ws: Workspace, inputs: Inputs, guidance = false) {
  return profilePhase("automation.revalidate", () =>
    withRepositoryInspection(ws.root, async () => {
      const [after, currentWs] = await Promise.all([
        guidance ? readGuidanceInputs(ws.root) : readInputs(ws.root),
        workspace(ws.root),
      ]);
      if (after.fingerprint !== inputs.fingerprint || currentWs.directory !== ws.directory) {
        throw new Error(
          "Repository inputs or branch changed during automation; no current verification was recorded. Retry on a stable checkout.",
        );
      }
    }),
  );
}

/** Expensive reads and checks never hold the shared state lock. */
async function computeAnalysis(
  ws: Workspace,
  state: State,
  inputs: Inputs,
  event: AutomationEvent,
  previousAudit?: AuditReport | null,
  cacheDiagnostic?: string,
) {
  const baselines = [...state.baselines];
  const now = new Date().toISOString();
  const empty: AutomationReport = {
    version: 1,
    status: "unavailable",
    root: ws.root,
    branch: ws.branch,
    head: inputs.head,
    baselinePaths: [],
    reportPath: "",
    findings: [],
    diagnostics: [
      "No README.md or agent instruction files were discovered. Documentation capture is unavailable; other Mason tools remain usable.",
    ],
    checks: { ran: [], reused: [], skipped: [] },
    counts: { resolved: 0, unresolved: 0, "review-required": 0, unverified: 0 },
    capture: "unknown",
    scope: SCOPE,
  };
  if (!baselines.length && Object.values(inputs.docs).every((value) => value === null)) {
    await verifyInputs(ws, inputs);
    return { baselines, report: empty, cache: null };
  }
  if (ws.branch === "detached" && state.latest) {
    const previous = (await readStoreJson(ws.root, state.latest)) as AutomationReport | null;
    if (!previous?.head || !/^[a-f0-9]{40,64}$/.test(previous.head))
      throw new Error("The previous detached checkout evidence is unavailable.");
    try {
      await git(ws.root, "merge-base", "--is-ancestor", previous.head, inputs.head);
    } catch {
      throw new Error(
        "Detached checkout moved to a different history; original repair evidence was retained. Inspect that baseline explicitly.",
      );
    }
  }
  let cached: unknown = null;
  const diagnostics: string[] = cacheDiagnostic ? [cacheDiagnostic] : [];
  try {
    cached = await readStoreJson(ws.root, ws.directory + "/cache.json");
  } catch {
    diagnostics.push("Unreadable automation cache; checks are being recomputed.");
  }
  const cache = checkCache(cached, inputs);
  if (cache.diagnostic) diagnostics.push(cache.diagnostic);
  // Only complete, validated raw checks can bypass current-audit preparation.
  // Retained history and review outcomes are still evaluated on every invocation.
  const cachedAudit =
    previousAudit?.gitAvailable &&
    previousAudit.headHash === inputs.head &&
    previousAudit.root === ws.root &&
    !previousAudit.skippedChecks.length &&
    ALL_CHECKS.every((name) => previousAudit.checksRun?.includes(name) && cache.has(name))
      ? previousAudit
      : undefined;
  if (cachedAudit) for (const name of ALL_CHECKS) cache.reused.add(name);
  let currentAudit: AuditReport | null = null;
  const verifications = await withRepairSession(
    ws.root,
    cache.options,
    async (repairs) => {
      const saveBaseline = async () => {
        if (baselines.length >= 128)
          throw new Error(
            "128 retained baselines need review; automatic capture stopped without discarding original evidence.",
          );
        const prepared = await repairs.prepare();
        baselines.push({
          path: prepared.baselinePath,
          at: now,
          event: event.event,
          fingerprint: inputs.fingerprint,
        });
      };
      if (!baselines.length) await saveBaseline();
      const verifications: RepairVerification[] = [];
      for (const baseline of baselines) verifications.push(await repairs.verify(baseline.path));
      const known = new Set(verifications.flatMap((v) => v.findings.map((f) => f.id)));
      // A clean initial baseline cannot retain findings introduced by a later rename.
      // Preserve those findings now, before another tool can edit or commit the docs.
      if (verifications.some((v) => v.newFindings.some((f) => !known.has(findingId(f))))) {
        await saveBaseline();
        verifications.push(await repairs.verify(baselines.at(-1)!.path));
      }
      currentAudit = await repairs.currentAudit();
      return verifications;
    },
    () => verifyInputs(ws, inputs),
    cachedAudit,
  );
  const merged = new Map<string, RepairFinding>();
  for (const verification of verifications) {
    for (const finding of verification.findings) {
      const previous = merged.get(finding.id);
      if (!previous || priority[finding.status] > priority[previous.status])
        merged.set(finding.id, finding);
    }
    diagnostics.push(...verification.diagnostics);
  }

  const counts = { resolved: 0, unresolved: 0, "review-required": 0, unverified: 0 };
  for (const finding of merged.values()) counts[finding.status]++;
  const report: AutomationReport = {
    version: 1,
    status:
      diagnostics.length || verifications.some((v) => v.status === "incomplete")
        ? "incomplete"
        : counts.unresolved
          ? "issues-remain"
          : "verified",
    root: ws.root,
    branch: ws.branch,
    head: inputs.head,
    baselinePaths: baselines.map((b) => b.path),
    reportPath: "",
    findings: [...merged.values()],
    diagnostics: [...new Set(diagnostics)],
    checks: {
      ran: [...cache.ran],
      reused: [...cache.reused].filter((name) => !cache.ran.has(name)),
      skipped: verifications.at(-1)!.currentAudit?.skippedChecks ?? [],
      ...(cachedAudit ? { auditReused: true } : {}),
    },
    counts,
    capture: "unknown",
    scope: SCOPE,
  };
  return {
    baselines,
    report,
    currentAudit,
    cache: cache.ran.size || cached === null || cache.diagnostic ? cache.serialize() : null,
  };
}

/** Per-input coordination shares expensive work; unrelated inputs can be checked concurrently. */
async function analyze(ws: Workspace, inputs: Inputs, event: AutomationEvent, startedAt: number) {
  return withLock(
    ws.root,
    ws.directory + "/analysis/" + inputs.fingerprint,
    async () => {
      const before = await loadState(ws);
      const { analysis: previous, diagnostic } = await matchingAnalysis(ws, before, inputs);
      // Overlap may share the whole verification. Sequential calls reuse only its
      // current audit: original history and review scopes need fresh inspection.
      if (previous && previous.completedAt >= startedAt)
        return { analysis: previous, shared: true };
      const originalDigest = await baselineDigest(ws, before);
      const computed = await computeAnalysis(
        ws,
        before,
        inputs,
        event,
        previous?.currentAudit as AuditReport | undefined,
        diagnostic,
      );
      if (originalDigest !== (await baselineDigest(ws, before)))
        throw new Error(
          "Repair baseline was modified during automation; original evidence must be inspected.",
        );
      const id = randomUUID();
      const analysis = analysisSchema.parse({
        id,
        fingerprint: inputs.fingerprint,
        completedAt: Date.now(),
        baselineDigest: await baselineDigest(ws, { ...before, baselines: computed.baselines }),
        report: computed.report,
        currentAudit: computed.currentAudit,
      });
      const analysisPath = ws.directory + "/checks/analysis-" + inputs.fingerprint + ".json";
      await withLock(ws.root, ws.directory, async () => {
        const state = await loadState(ws);
        // A concurrent check may have retained different original evidence. Never overwrite it.
        if (
          hash(state.baselines) !== hash(before.baselines) ||
          state.analysis?.id !== before.analysis?.id
        ) {
          throw new Error(
            "Automation evidence changed during analysis; retry against the retained baselines.",
          );
        }
        await writeStoreJson(ws.root, analysisPath, { analysis, digest: hash(analysis) });
        if (computed.cache)
          await writeStoreJson(ws.root, ws.directory + "/cache.json", computed.cache);
        state.baselines = computed.baselines;
        state.analysis = {
          id,
          fingerprint: inputs.fingerprint,
          completedAt: analysis.completedAt,
          path: analysisPath,
        };
        await writeStoreJson(ws.root, ws.directory + "/state.json", serializeState(state, null), {
          compact: true,
        });
      });
      return { analysis, shared: false };
    },
    Math.max(0, 25000 - (Date.now() - startedAt)),
  );
}

/** Changed hunks let an agent dismiss irrelevant drift without another tool call. They are
 * optional context: a failed excerpt omits itself and never resolves or hides a finding. */
async function driftExcerpts(root: string, report: AutomationReport, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 4);
  if (!unique.length) return null;
  const records = (await loadDecisionStore(root)).records;
  const sections: string[] = [];
  for (const id of unique) {
    const record = records.find((candidate) => candidate.id === id);
    const changed = new Set<string>();
    let title = record?.title ?? id;
    for (const finding of report.findings) {
      const evidence = finding.current?.evidence;
      if (finding.status === "resolved" || evidence?.kind !== "decision-anchor") continue;
      if (evidence.decisionId !== id) continue;
      title = evidence.title;
      for (const file of evidence.changedFiles) changed.add(file);
    }
    if (!record || !changed.size) continue;
    try {
      sections.push(formatDriftExcerpt(title, id, await driftExcerpt(root, record, [...changed])));
    } catch {
      // Excerpts are a convenience; the finding and its inspection request remain.
    }
  }
  return sections.join("\n") || null;
}

/** Current decision evidence uses the same publication/receipt path, without repair baselines. */
async function guidanceAnalysis(ws: Workspace, inputs: Inputs) {
  const checked = await checkDecisionAnchors({
    root: ws.root,
    docs: [],
    headHash: inputs.head,
    changesSinceDoc: new Map(),
    decisionsPresent: true,
  });
  const findings: RepairFinding[] = checked.advisories.map((current) => ({
    id: findingId(current),
    original: current,
    current,
    status: "review-required",
    reason: "Current decision anchors changed; inspect their reasoning.",
  }));
  // Reuse the last guidance receipt for explicit closure; absence alone is not proof.
  const before = await loadState(ws);
  if (before.guidance) {
    const prior = z
      .object({ findings: z.array(repairFindingSchema) })
      .parse(await readStoreJson(ws.root, before.guidance.path)) as { findings: RepairFinding[] };
    const currentIds = new Set(findings.map((finding) => finding.id));
    const records = (await loadDecisionStore(ws.root)).records;
    // An incomplete capture blocks closure for its own decision only.
    const incomplete = new Set(checked.incompleteDecisions);
    const sharedSkip = checked.skipped.length > checked.incompleteDecisions.length;
    for (const previous of prior.findings) {
      if (currentIds.has(previous.id) || previous.original.evidence.kind !== "decision-anchor")
        continue;
      const evidence = previous.original.evidence;
      const record = records.find((record) => record.id === evidence.decisionId);
      const capture = record && inputs.decisionEvidence[record.id]?.capture;
      const resolved =
        record?.status === "retired" ||
        (!!record &&
          !!capture?.complete &&
          capture.anchors.length > 0 &&
          !sharedSkip &&
          !incomplete.has(record.id));
      findings.push({
        id: previous.id,
        original: previous.original,
        status: resolved ? "resolved" : "unverified",
        reason: resolved
          ? "Current decision evidence no longer reports this drift, or the retained record is retired."
          : "Decision evidence could not establish closure.",
      });
    }
  }
  const counts = {
    resolved: 0,
    unresolved: 0,
    "review-required": 0,
    unverified: checked.skipped.length,
  };
  for (const finding of findings) counts[finding.status]++;
  const report: AutomationReport = {
    version: 1,
    status: counts.unverified || counts["review-required"] ? "incomplete" : "verified",
    root: ws.root,
    branch: ws.branch,
    head: inputs.head,
    baselinePaths: [],
    reportPath: "",
    findings,
    diagnostics: [
      ...checked.skipped.map((item) => item.reason),
      ...findings
        .filter((finding) => finding.status === "unverified")
        .map((finding) => `Decision ${finding.id}: ${finding.reason}`),
    ],
    checks: { ran: ["decision-anchor-drift"], reused: [], skipped: checked.skipped },
    counts,
    capture: "unknown",
    scope:
      "Decision anchor evidence only. Documentation audits and retained repair baselines were not checked. Source inspection remains separate from human approval.",
  };
  await verifyInputs(ws, inputs, true);
  return { analysis: { id: "guidance", report }, shared: false as const };
}

export async function automate(dir: string, event: AutomationEvent) {
  return runAutomation(dir, event, false);
}

export async function observeDecisionLifecycle(dir: string, event: AutomationEvent) {
  return runAutomation(dir, event, true);
}

/** Durable lifecycle: read concurrently, then merge each call into the latest state. */
async function runAutomation(dir: string, event: AutomationEvent, guidance: boolean) {
  const startedAt = Date.now();
  const ws = await profilePhase("automation.workspace", () => workspace(dir));
  const config = await readAutomationConfig(ws.root);
  const output = await recordExecution(ws.root, ws.directory, event.event, () =>
    withRepositoryInspection(ws.root, async () => {
      const inputs = await (guidance ? readGuidanceInputs(ws.root) : readInputs(ws.root));
      const result = await profilePhase("automation.analysis", async () =>
        guidance ? await guidanceAnalysis(ws, inputs) : await analyze(ws, inputs, event, startedAt),
      );
      if (!guidance && result.shared) {
        await verifyInputs(ws, inputs);
        if (result.analysis.baselineDigest !== (await baselineDigest(ws, await loadState(ws)))) {
          throw new Error(
            "Repair baseline was modified during shared automation; original evidence must be inspected.",
          );
        }
      }
      return profilePhase("automation.publish", () =>
        withLock(ws.root, ws.directory, async () => {
          const state = await loadState(ws);
          if (!guidance && state.analysis?.id !== result.analysis.id)
            throw new Error(
              "Automation evidence changed during publication; retry against the current inputs.",
            );
          const report = structuredClone(result.analysis.report) as AutomationReport;
          if (guidance) await verifyInputs(ws, inputs, true);
          if (!state.notifications) {
            // Upgrade from the last retained observation, not a fresh session's state.
            // This keeps changes made since that observation eligible for notification.
            let baseline = { findings: report.findings, head: report.head };
            const previousPath = guidance ? state.guidance?.path : state.latest;
            if (previousPath) {
              try {
                const previous = z
                  .object({ findings: z.array(repairFindingSchema), head: z.string() })
                  .safeParse(await readStoreJson(ws.root, previousPath));
                if (!previous.success) throw new Error("Unsupported saved report");
                baseline = previous.data as typeof baseline;
              } catch {
                report.diagnostics.push(
                  "The saved notification baseline could not be read; initialized from the current audit. Original repair evidence is retained. Run an explicit check for all outstanding findings.",
                );
              }
            }
            state.notifications = createNotificationState(baseline.findings, baseline.head);
          }
          if (result.shared)
            report.checks = {
              ...report.checks,
              ran: [],
              reused: [...new Set([...report.checks.ran, ...report.checks.reused])],
              shared: true,
            };
          report.reportPath =
            ws.directory + "/checks/" + (guidance ? "guidance-" : "") + randomUUID() + ".json";
          const now = new Date().toISOString();
          const key = event.host && event.sessionId ? hash([event.host, event.sessionId]) : null;
          const newSession = key !== null && !state.sessions[key];
          pruneSessions(
            state,
            new Date(now),
            newSession ? null : key,
            newSession ? SESSION_LIMIT - 1 : SESSION_LIMIT,
          );
          if (key && !state.sessions[key]) {
            state.sessions[key] = {
              host: event.host!,
              notifiedDiagnostics: [],
              lastUsed: now,
              pending: {},
              coverageGaps: [],
              events: {},
            };
          }
          const session = key ? state.sessions[key] : null;
          clearResolvedStopReviews(state.sessions, report);
          if (session) {
            observeDecisionEdits(session, inputs, event);
            session.lastUsed = now;
            session.events[event.event] = {
              at: now,
              count: (session.events[event.event]?.count ?? 0) + 1,
            };
            if (event.event === "before_tool" && event.mutating && event.toolId) {
              boundPending(session.pending);
              session.pending[event.toolId] = inputs.fingerprint;
            }
            if (event.event === "after_tool" && event.mutating) {
              if (!event.toolId || !session.pending[event.toolId]) {
                const gap =
                  "A tool completed without an observed matching pre-tool capture in this checkout; pre-edit coverage is unknown. The tool may have changed checkouts; captures are kept separately for each worktree.";
                if (!session.coverageGaps.includes(gap)) session.coverageGaps.push(gap);
              }
              if (event.toolId) delete session.pending[event.toolId];
            }
            report.diagnostics.push(...session.coverageGaps);
            if (session.coverageGaps.length && report.status !== "unavailable")
              report.status = "incomplete";
            report.capture =
              report.status !== "unavailable" &&
              !session.coverageGaps.length &&
              (session.events.session_start || session.events.before_tool)
                ? "observed"
                : "unknown";
          }
          // Checks and original repair baselines are independent of conversational output.
          // Potentially mutating tool names do not establish that anything changed.
          const selected =
            session && event.event === "task_end"
              ? completionFindings(state.notifications, report.findings)
              : [];
          // Agent delivery and user completion summaries must not consume each other.
          state.agentNotifications ??= { ...structuredClone(state.notifications), delivered: {} };
          const feedback =
            session && ["turn_start", "after_tool"].includes(event.event)
              ? completionFindings(state.agentNotifications, report.findings)
              : [];
          const diagnostics = session
            ? report.diagnostics.filter((d) => !session.notifiedDiagnostics.includes(d)).slice(0, 2)
            : [];
          if (session)
            session.notifiedDiagnostics = [
              ...new Set([
                ...session.notifiedDiagnostics.filter((d) => report.diagnostics.includes(d)),
                ...diagnostics,
              ]),
            ];
          const stopReview =
            session &&
            event.host === "claude" &&
            event.event === "task_end" &&
            config.stopBlock === "drift"
              ? decisionStopReview(session, inputs, report, !!event.stopHookActive)
              : { reason: null, block: false, decisions: [] };
          const excerpts = session
            ? await driftExcerpts(ws.root, report, [
                ...stopReview.decisions,
                ...[...selected, ...feedback].flatMap((finding) => {
                  const evidence = (finding.current ?? finding.original).evidence;
                  return evidence.kind === "decision-anchor" ? [evidence.decisionId] : [];
                }),
              ])
            : null;
          const message = !session
            ? summarize(report)
            : [
                stopReview.reason,
                completionSummary(selected, report.reportPath),
                completionSummary(feedback, report.reportPath),
                excerpts,
                ...(diagnostics.length
                  ? [
                      `Mason: verification limited. ${diagnostics.slice(0, 2).map(cleanText).join(" ")} Evidence: ${report.reportPath}.`,
                    ]
                  : []),
              ]
                .filter(Boolean)
                .join("\n") || null;
          const notify = message !== null;
          // Completion notices are advisory; no automatic retry/repair loop.
          const previousPath = guidance ? state.guidance?.path : state.latest;
          const previousFingerprint = guidance ? state.guidance?.fingerprint : state.fingerprint;
          const persistReport =
            !previousPath ||
            previousFingerprint !== inputs.fingerprint ||
            notify ||
            newSession ||
            event.event === "task_end";
          if (!persistReport) report.reportPath = previousPath!;
          state.updatedAt = now;
          if (guidance)
            state.guidance = { fingerprint: inputs.fingerprint, path: report.reportPath };
          else {
            state.fingerprint = inputs.fingerprint;
            state.latest = report.reportPath;
          }
          if (persistReport) await writeStoreJson(ws.root, report.reportPath, report);
          // The turn is over: calls still pending never reported completion.
          if (session && event.event === "task_end") clearPendingTools(session);
          await writeStoreJson(ws.root, ws.directory + "/state.json", serializeState(state, key), {
            compact: true,
          });
          return {
            report,
            message,
            stopBlockReason: stopReview.block ? stopReview.reason : null,
            observedAt: now,
            delivery: { agent: feedback.slice(0, 4), completion: selected.slice(0, 4) },
          };
        }),
      );
    }),
  );
  try {
    await observeUsefulness(
      ws.root,
      event,
      output.report,
      output.delivery.agent,
      output.delivery.completion,
      Date.now() - startedAt,
      output.observedAt,
    );
  } catch {
    // Optional observations must never suppress the audit result or existing feedback.
    if (event.event === "task_end")
      output.message = [
        output.message,
        "Mason: local usefulness tracking unavailable; inspect mason stats --json.",
      ]
        .filter(Boolean)
        .join("\n");
  }
  return output;
}

/** Read-only inspection: configured hooks and observed runtime events are different facts. */
export async function automationStatus(dir: string) {
  const { pendingKnowledge } = await import("../decisions/pending.js");
  const ws = await profilePhase("automation.workspace", () => workspace(dir));
  const config = await readAutomationConfig(ws.root);
  const knowledge = await pendingKnowledge(ws.root);
  const execution = await executionStatus(ws.root, ws.directory);
  const notifications = await failureNotifications(ws.root, ws.directory);
  const raw = await readStoreJson(ws.root, ws.directory + "/state.json", STATE_READ_MAX_BYTES);
  if (raw === null)
    return {
      version: 1,
      stopBlock: config.stopBlock,
      status: execution.status === "not-observed" ? "not-observed" : "unavailable",
      root: ws.root,
      branch: ws.branch,
      baselinePaths: [],
      scope: "not-observed",
      auditReportPath: null,
      hosts: {},
      execution,
      notifications,
      knowledge,
    };
  const state = parseState(raw);
  if (state.root !== ws.root || state.gitDir !== ws.gitDir || state.branch !== ws.branch)
    throw new Error("Automation state belongs to another workspace.");
  const inputs = await (state.guidance ? readGuidanceInputs(ws.root) : readInputs(ws.root));
  const reportPath = state.guidance?.path ?? state.latest;
  const latest = reportPath
    ? ((await readStoreJson(ws.root, reportPath!)) as AutomationReport | null)
    : null;
  const hosts: Record<string, { sessions: number; observedEvents: string[] }> = {};
  for (const session of Object.values(state.sessions)) {
    const host = (hosts[session.host] ??= { sessions: 0, observedEvents: [] });
    host.sessions++;
    host.observedEvents = [...new Set([...host.observedEvents, ...Object.keys(session.events)])];
  }
  const unfinished = ["failed", "unknown"].includes(execution.status);
  // Tool calls that have not reported completion; they expire at Stop or after 24 idle hours.
  const pendingSessions = Object.values(state.sessions).filter(
    (session) => Object.keys(session.pending).length,
  );
  return {
    version: 1,
    stopBlock: config.stopBlock,
    status: unfinished
      ? "unavailable"
      : inputs.fingerprint === (state.guidance?.fingerprint ?? state.fingerprint)
        ? "current"
        : "changed",
    root: ws.root,
    branch: ws.branch,
    baselinePaths: state.baselines.map((b) => b.path),
    reportPath,
    scope: state.guidance ? "decision-guidance" : "documentation-audit",
    auditReportPath: state.latest,
    verificationStatus: unfinished ? "unavailable" : (latest?.status ?? "unavailable"),
    hosts,
    sessions: Object.keys(state.sessions).length,
    unfinishedToolCalls: pendingSessions.reduce(
      (total, session) => total + Object.keys(session.pending).length,
      0,
    ),
    oldestUnfinishedSessionUsedAt:
      pendingSessions.map((session) => session.lastUsed).sort()[0] ?? null,
    execution,
    notifications,
    knowledge,
    notificationBaselineHead: state.notifications?.baselineHead ?? null,
    note: "Status describes the reported scope only. Decision guidance does not verify documentation repairs. Observed events do not prove all tool paths are intercepted. Run mason check for retained audit evidence.",
  };
}
