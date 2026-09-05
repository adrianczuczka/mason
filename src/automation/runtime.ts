import { randomUUID } from "node:crypto";
import { prepareRepair, verifyRepair, findingId, type RepairFinding, type RepairVerification } from "../audit/repair.js";
import { ALL_CHECKS, type AuditReport } from "../audit/types.js";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import { checkCache, git, hash, readInputs, workspace } from "./evidence.js";
import { stateSchema, withLock, type Event, type Host, type State } from "./store.js";

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
  checks: { ran: string[]; reused: string[]; skipped: NonNullable<AuditReport>["skippedChecks"] };
  counts: RepairVerification["counts"];
  capture: "observed" | "unknown";
  scope: string;
}

const SCOPE = "Documentation audit evidence only. Hook receipts show observed events, not complete interception. Resolved claims no longer fail their checks; advisories need separate review. Repair only within the user's task authorization.";
const priority = { resolved: 0, "review-required": 1, unresolved: 2, unverified: 3 };
const cleanText = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 250);

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

/** Durable, host-neutral lifecycle. Only evidence/cache/receipts are written. */
export async function automate(dir: string, event: AutomationEvent) {
  const ws = await workspace(dir);
  return withLock(ws.root, ws.directory, async () => {
    const inputs = await readInputs(ws.root);
    const statePath = ws.directory + "/state.json";
    const raw = await readStoreJson(ws.root, statePath);
    const now = new Date().toISOString();
    const state: State = raw === null ? {
      version: 1, root: ws.root, gitDir: ws.gitDir, branch: ws.branch, baselines: [], sessions: {},
      updatedAt: now, fingerprint: null, latest: null,
    } : stateSchema.parse(raw);
    if (state.root !== ws.root || state.gitDir !== ws.gitDir || state.branch !== ws.branch) {
      throw new Error("Automation state belongs to another branch or worktree; original evidence was retained.");
    }
    if (ws.branch === "detached" && state.latest) {
      const previous = await readStoreJson(ws.root, state.latest) as AutomationReport | null;
      if (!previous?.head || !/^[a-f0-9]{40,64}$/.test(previous.head)) throw new Error("The previous detached checkout evidence is unavailable.");
      try { await git(ws.root, "merge-base", "--is-ancestor", previous.head, inputs.head); }
      catch { throw new Error("Detached checkout moved to a different history; original repair evidence was retained. Inspect that baseline explicitly."); }
    }
    const key = event.host && event.sessionId ? hash([event.host, event.sessionId]) : null;
    const newSession = key !== null && !state.sessions[key];
    if (key && !state.sessions[key]) {
      // Receipts and notification dedupe are bounded; baselines are never evicted.
      const keys = Object.keys(state.sessions).sort((a, b) => state.sessions[a].lastUsed.localeCompare(state.sessions[b].lastUsed));
      for (const expired of keys.slice(0, Math.max(0, keys.length - 31))) delete state.sessions[expired];
      state.sessions[key] = { host: event.host!, seen: null, continued: false, initialIssues: [], initialDocs: inputs.docs,
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
    }
    if (!state.baselines.length && Object.values(inputs.docs).every(value => value === null)) {
      const report: AutomationReport = { version: 1, status: "unavailable", root: ws.root, branch: ws.branch, head: inputs.head,
        baselinePaths: [], reportPath: ws.directory + "/checks/" + randomUUID() + ".json", findings: [],
        diagnostics: ["No AGENTS.md, CLAUDE.md, or .claude/CLAUDE.md exists. Documentation capture is unavailable; other Mason tools remain usable."],
        checks: { ran: [], reused: [], skipped: [] }, counts: { resolved: 0, unresolved: 0, "review-required": 0, unverified: 0 },
        capture: "unknown", scope: SCOPE };
      const notify = !session || session.seen !== "no-docs";
      if (session) session.seen = "no-docs";
      state.fingerprint = inputs.fingerprint; state.latest = report.reportPath; state.updatedAt = now;
      await writeStoreJson(ws.root, report.reportPath, report);
      await writeStoreJson(ws.root, statePath, state);
      return { report, message: notify ? summarize(report) : null, continueOnce: false };
    }
    let cached: unknown = null;
    const diagnostics: string[] = [];
    try { cached = await readStoreJson(ws.root, ws.directory + "/cache.json"); }
    catch { diagnostics.push("Unreadable automation cache; checks are being recomputed."); }
    const cache = checkCache(cached, inputs);
    if (cache.diagnostic) diagnostics.push(cache.diagnostic);
    const saveBaseline = async () => {
      if (state.baselines.length >= 128) throw new Error("128 retained baselines need review; automatic capture stopped without discarding original evidence.");
      const prepared = await prepareRepair(ws.root, ALL_CHECKS, cache.options);
      state.baselines.push({ path: prepared.baselinePath, at: now, event: event.event, fingerprint: inputs.fingerprint });
    };
    if (!state.baselines.length) await saveBaseline();
    const verifications: RepairVerification[] = [];
    for (const baseline of state.baselines) verifications.push(await verifyRepair(ws.root, baseline.path, cache.options));
    const known = new Set(verifications.flatMap(v => v.findings.map(f => f.id)));
    // A clean initial baseline cannot retain findings introduced by a later rename.
    // Preserve those findings now, before another tool can edit or commit the docs.
    if (verifications.some(v => v.newFindings.some(f => !known.has(findingId(f))))) {
      await saveBaseline();
      verifications.push(await verifyRepair(ws.root, state.baselines.at(-1)!.path, cache.options));
    }
    const merged = new Map<string, RepairFinding>();
    for (const verification of verifications) {
      for (const finding of verification.findings) {
        const previous = merged.get(finding.id);
        if (!previous || priority[finding.status] > priority[previous.status]) merged.set(finding.id, finding);
      }
      diagnostics.push(...verification.diagnostics);
    }
    if (newSession && session) session.initialIssues = [...merged.values()].filter(f => f.status === "unresolved").map(f => f.id);
    const current = verifications.at(-1)!.currentAudit;
    const counts = { resolved: 0, unresolved: 0, "review-required": 0, unverified: 0 };
    for (const finding of merged.values()) counts[finding.status]++;
    if (session) diagnostics.push(...session.coverageGaps);
    const capture = session && !session.coverageGaps.length && (session.events.session_start || session.events.before_tool) ? "observed" : "unknown";
    const after = await readInputs(ws.root);
    const currentWs = await workspace(ws.root);
    if (after.fingerprint !== inputs.fingerprint || currentWs.directory !== ws.directory) {
      throw new Error("Repository inputs or branch changed during automation; no current verification was recorded. Retry on a stable checkout.");
    }
    const report: AutomationReport = {
      version: 1,
      status: diagnostics.length || verifications.some(v => v.status === "incomplete") ? "incomplete" : counts.unresolved ? "issues-remain" : "verified",
      root: ws.root, branch: ws.branch, head: inputs.head, baselinePaths: state.baselines.map(b => b.path),
      reportPath: ws.directory + "/checks/" + randomUUID() + ".json",
      findings: [...merged.values()], diagnostics: [...new Set(diagnostics)],
      checks: { ran: [...cache.ran], reused: [...cache.reused].filter(name => !cache.ran.has(name)), skipped: current?.skippedChecks ?? [] },
      counts, capture, scope: SCOPE,
    };
    const signature = hash([report.status, report.findings, report.diagnostics, report.checks.skipped]);
    const relevant = report.findings.some(f => f.status === "unresolved" && session &&
      (!session.initialIssues.includes(f.id) || session.initialDocs[f.original.anchor.doc] !== inputs.docs[f.original.anchor.doc]));
    const continueOnce = event.event === "task_end" && !!session?.mutationObserved && relevant &&
      !session.continued && !event.stopHookActive;
    const notify = !session || newSession || signature !== session.seen || continueOnce;
    if (session) {
      session.seen = signature;
      if (continueOnce) session.continued = true;
    }
    // Repeated tools with identical evidence need receipts, not another full report artifact.
    const persistReport = !state.latest || state.fingerprint !== inputs.fingerprint || notify || event.event === "task_end";
    if (!persistReport) report.reportPath = state.latest!;
    state.updatedAt = now;
    state.fingerprint = inputs.fingerprint;
    state.latest = report.reportPath;
    // Publish complete evidence before publishing the pointer that refers to it.
    if (persistReport) await writeStoreJson(ws.root, report.reportPath, report);
    await writeStoreJson(ws.root, ws.directory + "/cache.json", cache.serialize());
    await writeStoreJson(ws.root, statePath, state);
    return { report, message: notify ? summarize(report) : null, continueOnce };
  });
}

/** Read-only inspection: configured hooks and observed runtime events are different facts. */
export async function automationStatus(dir: string) {
  const ws = await workspace(dir);
  const raw = await readStoreJson(ws.root, ws.directory + "/state.json");
  if (raw === null) return { version: 1, status: "not-observed", root: ws.root, branch: ws.branch, baselinePaths: [], hosts: {} };
  const state = stateSchema.parse(raw);
  if (state.root !== ws.root || state.gitDir !== ws.gitDir || state.branch !== ws.branch) throw new Error("Automation state belongs to another workspace.");
  const inputs = await readInputs(ws.root);
  const latest = state.latest ? await readStoreJson(ws.root, state.latest) as AutomationReport | null : null;
  const hosts: Record<string, { sessions: number; observedEvents: string[] }> = {};
  for (const session of Object.values(state.sessions)) {
    const host = hosts[session.host] ??= { sessions: 0, observedEvents: [] };
    host.sessions++;
    host.observedEvents = [...new Set([...host.observedEvents, ...Object.keys(session.events)])];
  }
  return { version: 1, status: inputs.fingerprint === state.fingerprint ? "current" : "changed", root: ws.root,
    branch: ws.branch, baselinePaths: state.baselines.map(b => b.path), reportPath: state.latest,
    verificationStatus: latest?.status ?? "unavailable", hosts,
    note: "Observed events do not prove all tool paths are intercepted. Run check to verify the retained evidence." };
}
