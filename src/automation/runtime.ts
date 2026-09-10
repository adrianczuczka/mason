import { recordExecution, executionStatus, failureNotifications } from "./execution.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prepareRepair, verifyRepair, findingId, repairFindingSchema, type RepairFinding, type RepairVerification } from "../audit/repair.js";
import { ALL_CHECKS, type AuditReport } from "../audit/types.js";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import { checkCache, git, hash, readInputs, workspace, type Inputs } from "./evidence.js";
import { parseState, withLock, type Event, type Host, type State } from "./store.js";

export interface AutomationEvent {
  event: Event;
  host?: Host;
  sessionId?: string;
  toolId?: string;
  mutating?: boolean;
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
  checks: { ran: string[]; reused: string[]; skipped: NonNullable<AuditReport>["skippedChecks"]; shared?: boolean };
  counts: RepairVerification["counts"];
  capture: "observed" | "unknown";
  scope: string;
}

const SCOPE = "Documentation audit evidence only. Hook receipts show observed events, not complete interception. Resolved claims no longer fail their checks; historical advisories need separate review. Repair only within the user's task authorization.";
const priority = { resolved: 0, "review-required": 1, unresolved: 2, unverified: 3 };
const cleanText = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 250);

/** Read tools cannot create repair evidence. Observe their lifecycle without rescanning the checkout. */
export async function observeReadOnlyTool(dir: string, event: AutomationEvent) {
  const ws = await workspace(dir);
  await withLock(ws.root, ws.directory, async () => {
    const statePath = ws.directory + "/state.json";
    const raw = await readStoreJson(ws.root, statePath);
    if (raw === null) return;
    const state = parseState(raw);
    if (state.root !== ws.root || state.gitDir !== ws.gitDir || state.branch !== ws.branch) {
      throw new Error("Automation state belongs to another branch or worktree; original evidence was retained.");
    }
    const session = event.host && event.sessionId ? state.sessions[hash([event.host, event.sessionId])] : null;
    if (!session) return;
    const now = new Date().toISOString();
    session.lastUsed = now;
    session.events[event.event] = { at: now, count: (session.events[event.event]?.count ?? 0) + 1 };
    // Do not advance the audit fingerprint, report, or execution verdict: no check ran.
    await writeStoreJson(ws.root, statePath, state);
  });
  return { root: ws.root, directory: ws.directory };
}

export function summarize(report: AutomationReport): string {
  const open = report.findings.filter(f => f.status !== "resolved");
  return [
    `Mason: ${report.status}; ${report.counts.unresolved} unresolved, ${report.counts["review-required"]} need review, ${report.counts.unverified} unverified.`,
    ...open.slice(0, 4).map(f => `[${f.status}] ${cleanText(f.original.anchor.doc)}: ${cleanText(f.original.message)}`),
    ...(open.length > 4 ? [`${open.length - 4} more findings in the report.`] : []),
    ...report.diagnostics.slice(0, 2).map(cleanText),
    `Evidence: ${report.reportPath}. Resume/check with mason_automation(action: "check") or mason-auto check.`,
    "Keep original evidence. Address findings relevant to the authorized task; report unrelated findings and unresolved advisories without approving them.",
  ].join("\n");
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

async function loadState(ws: Workspace): Promise<State> {
  const raw = await readStoreJson(ws.root, ws.directory + "/state.json");
  const state = raw === null ? {
    version: 1 as const, root: ws.root, gitDir: ws.gitDir, branch: ws.branch, baselines: [], sessions: {},
    updatedAt: new Date().toISOString(), fingerprint: null, latest: null,
  } : parseState(raw);
  if (state.root !== ws.root || state.gitDir !== ws.gitDir || state.branch !== ws.branch) {
    throw new Error("Automation state belongs to another branch or worktree; original evidence was retained.");
  }
  return state;
}

const analysisSchema = z.object({
  id: z.string(), fingerprint: z.string(), completedAt: z.number(), baselineDigest: z.string(),
  report: z.object({
    version: z.literal(1), status: z.enum(["verified", "issues-remain", "incomplete", "unavailable"]),
    root: z.string(), branch: z.string(), head: z.string(), baselinePaths: z.array(z.string()), reportPath: z.string(),
    findings: z.array(repairFindingSchema), diagnostics: z.array(z.string()),
    checks: z.object({ ran: z.array(z.string()), reused: z.array(z.string()),
      skipped: z.array(z.object({ check: z.string(), reason: z.string(), doc: z.string().optional() })) }),
    counts: z.object({ resolved: z.number(), unresolved: z.number(), "review-required": z.number(), unverified: z.number() }),
    capture: z.enum(["observed", "unknown"]), scope: z.string(),
  }),
});
const sharedSchema = z.object({ analysis: analysisSchema, digest: z.string() });
type Analysis = z.infer<typeof analysisSchema>;
const baselineDigest = async (ws: Workspace, state: State) => hash(await Promise.all(
  state.baselines.map(async b => [b.path, await readStoreJson(ws.root, b.path)]),
));

async function sharedAnalysis(ws: Workspace, state: State, inputs: Inputs, startedAt: number): Promise<Analysis | null> {
  const pointer = state.analysis;
  // Share only overlapping calls, never treat an earlier check as a new verification.
  if (!pointer || pointer.fingerprint !== inputs.fingerprint || pointer.completedAt < startedAt) return null;
  const stored = sharedSchema.parse(await readStoreJson(ws.root, pointer.path));
  const a = stored.analysis;
  if (stored.digest !== hash(a) || a.id !== pointer.id || a.fingerprint !== inputs.fingerprint ||
      a.completedAt !== pointer.completedAt || a.report.root !== ws.root || a.report.branch !== ws.branch ||
      a.report.head !== inputs.head || hash(a.report.baselinePaths) !== hash(state.baselines.map(b => b.path))) {
    throw new Error("Invalid shared automation evidence; run a new check.");
  }
  if (a.baselineDigest !== await baselineDigest(ws, state)) throw new Error("Repair baseline was modified; use the original baseline.");
  return a;
}

async function verifyInputs(ws: Workspace, inputs: Inputs) {
  const [after, currentWs] = await Promise.all([readInputs(ws.root), workspace(ws.root)]);
  if (after.fingerprint !== inputs.fingerprint || currentWs.directory !== ws.directory) {
    throw new Error("Repository inputs or branch changed during automation; no current verification was recorded. Retry on a stable checkout.");
  }
}

/** Expensive reads and checks never hold the shared state lock. */
async function computeAnalysis(ws: Workspace, state: State, inputs: Inputs, event: AutomationEvent) {
  const baselines = [...state.baselines];
  const now = new Date().toISOString();
  const empty: AutomationReport = { version: 1, status: "unavailable", root: ws.root, branch: ws.branch, head: inputs.head,
    baselinePaths: [], reportPath: "", findings: [],
    diagnostics: ["No README.md or agent instruction files were discovered. Documentation capture is unavailable; other Mason tools remain usable."],
    checks: { ran: [], reused: [], skipped: [] }, counts: { resolved: 0, unresolved: 0, "review-required": 0, unverified: 0 },
    capture: "unknown", scope: SCOPE };
  if (!baselines.length && Object.values(inputs.docs).every(value => value === null)) return { baselines, report: empty, cache: null };
  if (ws.branch === "detached" && state.latest) {
    const previous = await readStoreJson(ws.root, state.latest) as AutomationReport | null;
    if (!previous?.head || !/^[a-f0-9]{40,64}$/.test(previous.head)) throw new Error("The previous detached checkout evidence is unavailable.");
    try { await git(ws.root, "merge-base", "--is-ancestor", previous.head, inputs.head); }
    catch { throw new Error("Detached checkout moved to a different history; original repair evidence was retained. Inspect that baseline explicitly."); }
  }
  let cached: unknown = null;
  const diagnostics: string[] = [];
  try { cached = await readStoreJson(ws.root, ws.directory + "/cache.json"); }
  catch { diagnostics.push("Unreadable automation cache; checks are being recomputed."); }
  const cache = checkCache(cached, inputs);
  if (cache.diagnostic) diagnostics.push(cache.diagnostic);
  const saveBaseline = async () => {
    if (baselines.length >= 128) throw new Error("128 retained baselines need review; automatic capture stopped without discarding original evidence.");
    const prepared = await prepareRepair(ws.root, ALL_CHECKS, cache.options);
    baselines.push({ path: prepared.baselinePath, at: now, event: event.event, fingerprint: inputs.fingerprint });
  };
  if (!baselines.length) await saveBaseline();
  const verifications: RepairVerification[] = [];
  for (const baseline of baselines) verifications.push(await verifyRepair(ws.root, baseline.path, cache.options));
  const known = new Set(verifications.flatMap(v => v.findings.map(f => f.id)));
  // A clean initial baseline cannot retain findings introduced by a later rename.
  // Preserve those findings now, before another tool can edit or commit the docs.
  if (verifications.some(v => v.newFindings.some(f => !known.has(findingId(f))))) {
    await saveBaseline();
    verifications.push(await verifyRepair(ws.root, baselines.at(-1)!.path, cache.options));
  }
  const merged = new Map<string, RepairFinding>();
  for (const verification of verifications) {
    for (const finding of verification.findings) {
      const previous = merged.get(finding.id);
      if (!previous || priority[finding.status] > priority[previous.status]) merged.set(finding.id, finding);
    }
    diagnostics.push(...verification.diagnostics);
  }

  const counts = { resolved: 0, unresolved: 0, "review-required": 0, unverified: 0 };
  for (const finding of merged.values()) counts[finding.status]++;
  const report: AutomationReport = {
    version: 1, status: diagnostics.length || verifications.some(v => v.status === "incomplete") ? "incomplete" : counts.unresolved ? "issues-remain" : "verified",
    root: ws.root, branch: ws.branch, head: inputs.head, baselinePaths: baselines.map(b => b.path), reportPath: "",
    findings: [...merged.values()], diagnostics: [...new Set(diagnostics)],
    checks: { ran: [...cache.ran], reused: [...cache.reused].filter(name => !cache.ran.has(name)), skipped: verifications.at(-1)!.currentAudit?.skippedChecks ?? [] },
    counts, capture: "unknown", scope: SCOPE,
  };
  return { baselines, report, cache: cache.ran.size || cached === null || cache.diagnostic ? cache.serialize() : null };
}

/** Per-input coordination shares expensive work; unrelated inputs can be checked concurrently. */
async function analyze(ws: Workspace, inputs: Inputs, event: AutomationEvent, startedAt: number) {
  return withLock(ws.root, ws.directory + "/analysis/" + inputs.fingerprint, async () => {
    const before = await loadState(ws);
    const shared = await sharedAnalysis(ws, before, inputs, startedAt);
    if (shared) return { analysis: shared, shared: true };
    const originalDigest = await baselineDigest(ws, before);
    const computed = await computeAnalysis(ws, before, inputs, event);
    await verifyInputs(ws, inputs);
    if (originalDigest !== await baselineDigest(ws, before)) throw new Error("Repair baseline was modified during automation; original evidence must be inspected.");
    const id = randomUUID();
    const analysis = analysisSchema.parse({ id, fingerprint: inputs.fingerprint, completedAt: Date.now(),
      baselineDigest: await baselineDigest(ws, { ...before, baselines: computed.baselines }), report: computed.report });
    const analysisPath = ws.directory + "/checks/analysis-" + inputs.fingerprint + ".json";
    await withLock(ws.root, ws.directory, async () => {
      const state = await loadState(ws);
      // A concurrent check may have retained different original evidence. Never overwrite it.
      if (hash(state.baselines) !== hash(before.baselines) || state.analysis?.id !== before.analysis?.id) {
        throw new Error("Automation evidence changed during analysis; retry against the retained baselines.");
      }
      await writeStoreJson(ws.root, analysisPath, { analysis, digest: hash(analysis) });
      if (computed.cache) await writeStoreJson(ws.root, ws.directory + "/cache.json", computed.cache);
      state.baselines = computed.baselines;
      state.analysis = { id, fingerprint: inputs.fingerprint, completedAt: analysis.completedAt, path: analysisPath };
      await writeStoreJson(ws.root, ws.directory + "/state.json", state);
    });
    return { analysis, shared: false };
  }, Math.max(0, 25000 - (Date.now() - startedAt)));
}

/** Durable lifecycle: read concurrently, then merge each call into the latest state. */
export async function automate(dir: string, event: AutomationEvent) {
  const startedAt = Date.now();
  const ws = await workspace(dir);
  return recordExecution(ws.root, ws.directory, event.event, async () => {
    const inputs = await readInputs(ws.root);
    const result = await analyze(ws, inputs, event, startedAt);
    if (result.shared) {
      await verifyInputs(ws, inputs);
      if (result.analysis.baselineDigest !== await baselineDigest(ws, await loadState(ws))) {
        throw new Error("Repair baseline was modified during shared automation; original evidence must be inspected.");
      }
    }
    return withLock(ws.root, ws.directory, async () => {
      const state = await loadState(ws);
      if (state.analysis?.id !== result.analysis.id) throw new Error("Automation evidence changed during publication; retry against the current inputs.");
      const report = structuredClone(result.analysis.report) as AutomationReport;
      if (result.shared) report.checks = { ...report.checks, ran: [], reused: [...new Set([...report.checks.ran, ...report.checks.reused])], shared: true };
      report.reportPath = ws.directory + "/checks/" + randomUUID() + ".json";
      const now = new Date().toISOString();
      const key = event.host && event.sessionId ? hash([event.host, event.sessionId]) : null;
      const newSession = key !== null && !state.sessions[key];
      if (key && !state.sessions[key]) {
        const keys = Object.keys(state.sessions).sort((a, b) => state.sessions[a].lastUsed.localeCompare(state.sessions[b].lastUsed));
        // Pending pre-edit captures cannot be evicted by another session's arrival.
        const removable = keys.filter(k => !Object.keys(state.sessions[k].pending).length);
        for (const expired of removable.slice(0, Math.max(0, keys.length - 31))) delete state.sessions[expired];
        if (Object.keys(state.sessions).length >= 128) throw new Error("Too many sessions with unfinished tool calls; original evidence was retained.");
        state.sessions[key] = { host: event.host!, seen: null, continued: false,
          initialIssues: report.findings.filter(f => f.status === "unresolved").map(f => f.id), initialDocs: inputs.docs,
          lastUsed: now, mutationObserved: false, pending: {}, coverageGaps: [], events: {} };
      }
      const session = key ? state.sessions[key] : null;
      if (session) {
        session.lastUsed = now;
        session.events[event.event] = { at: now, count: (session.events[event.event]?.count ?? 0) + 1 };
        if (event.event === "before_tool" && event.mutating && event.toolId) {
          if (Object.keys(session.pending).length >= 128) throw new Error("Too many unfinished tool calls to track pre-edit evidence.");
          session.pending[event.toolId] = inputs.fingerprint;
        }
        if (event.event === "after_tool" && event.mutating) {
          session.mutationObserved = true;
          if (!event.toolId || !session.pending[event.toolId]) {
            const gap = "A tool completed without an observed matching pre-tool capture; pre-edit coverage is unknown.";
            if (!session.coverageGaps.includes(gap)) session.coverageGaps.push(gap);
          }
          if (event.toolId) delete session.pending[event.toolId];
        }
        report.diagnostics.push(...session.coverageGaps);
        if (session.coverageGaps.length && report.status !== "unavailable") report.status = "incomplete";
        report.capture = report.status !== "unavailable" && !session.coverageGaps.length &&
          (session.events.session_start || session.events.before_tool) ? "observed" : "unknown";
      }
      const signature = hash([report.status, report.findings, report.diagnostics, report.checks.skipped]);
      const relevant = report.findings.some(f => f.status === "unresolved" && session &&
        (!session.initialIssues.includes(f.id) || session.initialDocs[f.original.anchor.doc] !== inputs.docs[f.original.anchor.doc]));
      const continueOnce = event.event === "task_end" && !!session?.mutationObserved && relevant && !session.continued && !event.stopHookActive;
      const notify = !session || newSession || signature !== session.seen || continueOnce;
      if (session) { session.seen = signature; if (continueOnce) session.continued = true; }
      const persistReport = !state.latest || state.fingerprint !== inputs.fingerprint || notify || event.event === "task_end";
      if (!persistReport) report.reportPath = state.latest!;
      state.updatedAt = now; state.fingerprint = inputs.fingerprint; state.latest = report.reportPath;
      if (persistReport) await writeStoreJson(ws.root, report.reportPath, report);
      await writeStoreJson(ws.root, ws.directory + "/state.json", state);
      return { report, message: notify ? summarize(report) : null, continueOnce };
    });
  });
}

/** Read-only inspection: configured hooks and observed runtime events are different facts. */
export async function automationStatus(dir: string) {
  const ws = await workspace(dir);
  const execution = await executionStatus(ws.root, ws.directory);
  const notifications = await failureNotifications(ws.root, ws.directory);
  const raw = await readStoreJson(ws.root, ws.directory + "/state.json");
  if (raw === null) return { version: 1, status: execution.status === "not-observed" ? "not-observed" : "unavailable", root: ws.root, branch: ws.branch, baselinePaths: [], hosts: {}, execution, notifications };
  const state = parseState(raw);
  if (state.root !== ws.root || state.gitDir !== ws.gitDir || state.branch !== ws.branch) throw new Error("Automation state belongs to another workspace.");
  const inputs = await readInputs(ws.root);
  const latest = state.latest ? await readStoreJson(ws.root, state.latest) as AutomationReport | null : null;
  const hosts: Record<string, { sessions: number; observedEvents: string[] }> = {};
  for (const session of Object.values(state.sessions)) {
    const host = hosts[session.host] ??= { sessions: 0, observedEvents: [] };
    host.sessions++;
    host.observedEvents = [...new Set([...host.observedEvents, ...Object.keys(session.events)])];
  }
  const unfinished = ["failed", "unknown", "running"].includes(execution.status);
  return { version: 1, status: unfinished ? "unavailable" : inputs.fingerprint === state.fingerprint ? "current" : "changed", root: ws.root,
    branch: ws.branch, baselinePaths: state.baselines.map(b => b.path), reportPath: state.latest,
    verificationStatus: unfinished ? "unavailable" : latest?.status ?? "unavailable", hosts, execution, notifications,
    note: "Observed events do not prove all tool paths are intercepted. Run check to verify the retained evidence." };
}
