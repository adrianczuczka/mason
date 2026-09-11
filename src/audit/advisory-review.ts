import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { advisorySchema, digest, findingId, type Finding } from "./findings.js";
import { manifestPathspecs } from "./checks/deps-changed.js";
import { readAuditInput } from "./inputs.js";
import { pathExists } from "./scope.js";
import { readStoreJson, storePath, writeStoreJson } from "../utils/storage.js";
import { normalizeRepoPath } from "../utils/paths.js";
import { withLock } from "../automation/store.js";
import { loadDecisionStore } from "../decisions/decisions.js";
import { computeDecisionDrift } from "../decisions/drift.js";

const execute = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await execute("git", args, { cwd: root, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const evidenceSchema = z.object({
  head: commitSchema, fingerprint: hashSchema, scope: z.array(z.string()).min(1).max(1000),
  tree: z.string().max(2 * 1024 * 1024), lastScopeCommit: commitSchema,
  paths: z.array(z.object({ path: z.string(), exists: z.boolean() })).max(1000),
});
const eventSchema = z.object({
  at: z.string().datetime(), reviewer: z.string().trim().min(1).max(200), note: z.string().trim().min(1).max(2500),
  outcome: z.enum(["addressed", "inapplicable", "deferred"]),
  finding: advisorySchema.refine(finding => finding.evidence.kind !== "decision-anchor", "Decision findings use decision reviews"), evidence: evidenceSchema,
});
const recordSchema = z.object({ version: z.literal(1), id: hashSchema, events: z.array(eventSchema).min(1).max(200), digest: hashSchema });
type ReviewRecord = z.infer<typeof recordSchema>;
export const reviewSummarySchema = z.object({
  id: hashSchema, status: z.enum(["current", "reopened", "deferred", "unverified"]), reason: z.string(),
  recordPath: z.string().optional(), reviewer: z.string().optional(), note: z.string().optional(),
  outcome: z.enum(["addressed", "inapplicable", "deferred", "accepted", "reaffirmed", "retired"]).optional(),
  reviewedHead: z.string().optional(),
});
export type AdvisoryReviewSummary = z.infer<typeof reviewSummarySchema>;
export const advisoryReviewRequest = z.object({
  baselinePath: z.string().min(1), findingId: hashSchema,
  action: z.enum(["prepare", "addressed", "inapplicable", "deferred"]).default("prepare"),
  reviewer: eventSchema.shape.reviewer.optional(), note: eventSchema.shape.note.optional(), reviewToken: hashSchema.optional(),
});
export type AdvisoryReviewInput = z.input<typeof advisoryReviewRequest>;
const recordPath = (id: string) => `.mason/reviews/advisories/${hashSchema.parse(id)}.json`;

async function readRecord(root: string, id: string): Promise<ReviewRecord | null> {
  const raw = await readStoreJson(root, recordPath(id));
  if (raw === null) return null;
  const record = recordSchema.parse(raw);
  const { digest: stored, ...payload } = record;
  if (record.id !== id || digest(payload) !== stored || record.events.some(event => findingId(event.finding as Finding) !== id
    || event.evidence.fingerprint !== digest([event.evidence.scope, event.evidence.tree, event.evidence.lastScopeCommit, event.evidence.paths]))) {
    throw new Error("Advisory review record is inconsistent or modified; inspect its history.");
  }
  return record;
}

function scopes(finding: Finding): string[] {
  const files = [finding.anchor.doc], e = finding.evidence;
  if (e.kind === "decision-anchor") throw new Error("Use review_decision for decision acceptance, reaffirmation or retirement.");
  if (e.kind === "doc-behind-manifests") return [`:(literal)${finding.anchor.doc}`, ...manifestPathspecs(finding.anchor.doc)];
  if (e.kind === "missing-path") files.push(...(e.scope?.candidates ?? [e.resolvedPath ?? e.claimed]));
  else if (e.kind === "missing-script") files.push(...e.manifestsChecked, ...(e.scope?.candidates ?? []));
  else if (e.kind === "unmentioned-dir") files.push(e.dir, ...e.checkedDocs);
  else throw new Error("This advisory has no supported review scope.");
  return [...new Set(files)].map(file => {
    if (normalizeRepoPath(file) !== file) throw new Error("Advisory contains an invalid scoped path: " + file);
    return `:(literal)${file}`;
  }).sort();
}

/** Committed, scoped Git evidence survives unrelated and review-record-only commits. */
async function reviewEvidence(root: string, finding: Finding) {
  if (normalizeRepoPath(finding.anchor.doc) !== finding.anchor.doc) throw new Error("Invalid advisory document path.");
  const scope = scopes(finding);
  const head = (await git(root, "rev-parse", "HEAD")).trim();
  const tracked = (await git(root, "ls-files", "--cached", "-z", "--", ...scope)).split("\0").filter(Boolean);
  if (tracked.length > 20_000) throw new Error("Advisory scope exceeds 20,000 tracked files.");
  const [tree, status, lastScopeCommit, document] = await Promise.all([
    tracked.length ? git(root, "ls-tree", "-r", "-z", "HEAD", "--", ...tracked.map(file => `:(literal)${file}`)) : "",
    git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...scope),
    git(root, "log", "-1", "--format=%H", "HEAD", "--", ...scope).then(value => value.trim()),
    readAuditInput(root, finding.anchor.doc),
  ]);
  if (!document?.trim()) throw new Error("Original advisory document is missing, empty or unreadable.");
  if (tree.length > 2 * 1024 * 1024 || tree.split("\0").length > 20_000) throw new Error("Advisory scope is too large for a complete review; narrow the documentation scope.");
  // Reject symlinks rather than trusting a blob that describes an external target.
  for (const entry of tree.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"), file = entry.slice(tab + 1);
    if (entry.startsWith("120000 ") || entry.startsWith("160000 ")) throw new Error("Symlink or submodule in advisory review scope: " + file);
    await storePath(root, file);
  }
  // Path checks observe presence even for explicitly documented ignored
  // outputs. Git alone cannot detect those appearing or disappearing.
  const paths = finding.evidence.kind === "missing-path" ? await Promise.all(
    (finding.evidence.scope?.candidates ?? [finding.evidence.resolvedPath ?? finding.evidence.claimed])
      .map(async file => ({ path: file, exists: await pathExists(root, file) }))) : [];
  let dirty = status.length > 0;
  if (finding.evidence.kind === "missing-script") {
    for (const file of [...finding.evidence.manifestsChecked, ...(finding.evidence.scope?.candidates ?? [])]) {
      if (!tracked.includes(file) && await pathExists(root, file)) dirty = true;
    }
  }
  const fingerprint = digest([scope, tree, lastScopeCommit, paths]);
  if ((await git(root, "rev-parse", "HEAD")).trim() !== head) throw new Error("HEAD changed while collecting review evidence.");
  return { ...evidenceSchema.parse({ head, scope, tree, lastScopeCommit, paths, fingerprint }), dirty,
    documentDigest: digest(document) };
}

async function decisionAssessment(root: string, finding: Finding, baselineHead: string): Promise<AdvisoryReviewSummary | null> {
  const evidence = finding.evidence;
  if (evidence.kind !== "decision-anchor") return null;
  const id = findingId(finding);
  const store = await loadDecisionStore(root);
  if (store.diagnostics.length) throw new Error("Decision records have unavailable or malformed evidence; review cannot be confirmed.");
  const record = store.records.find(record => record.id === evidence.decisionId);
  if (!record || record.version !== 2) return null;
  const events = record.history.filter(event => ["accepted", "reaffirmed", "retired"].includes(event.kind));
  const event = events.at(-1);
  if (!event?.evidence || !event.actor || !event.note || !event.evidence.historyAvailable || event.evidence.localChanges.length) return null;
  try { await git(root, "merge-base", "--is-ancestor", baselineHead, event.evidence.headHash); }
  catch { return null; }
  const drift = await computeDecisionDrift(root, [record]);
  if (!drift.historyAvailable) throw new Error("Decision review history is unavailable.");
  const retired = record.status === "retired" && event.kind === "retired";
  const current = retired || record.status === "active" && record.approval === "accepted"
    && drift.freshness?.[record.id] === "current" && !drift.pendingProposals?.[record.id];
  return { id, status: current ? "current" : "reopened", outcome: event.kind as "accepted" | "reaffirmed" | "retired",
    reviewer: event.actor, note: event.note, reviewedHead: event.evidence.headHash,
    recordPath: `.mason/decisions/${record.id}.json`, reason: current
      ? "The existing decision review records acceptance, reaffirmation or retirement covering the original finding."
      : "Decision content or anchor evidence changed after its review; review the decision again." };
}

export async function assessAdvisory(root: string, finding: Finding, baselineHead: string): Promise<AdvisoryReviewSummary | null> {
  if ("confidence" in finding) return null;
  const id = findingId(finding);
  try {
    if (finding.evidence.kind === "decision-anchor") return await decisionAssessment(root, finding, baselineHead);
    const record = await readRecord(root, id);
    if (!record) return null;
    const event = record.events.at(-1)!;
    // Use the reviewed scope, not a newly shortened finding's preview of that scope.
    const current = await reviewEvidence(root, event.finding as Finding);
    await git(root, "merge-base", "--is-ancestor", event.evidence.head, current.head);
    const base = { id, recordPath: recordPath(id), reviewer: event.reviewer, note: event.note,
      outcome: event.outcome, reviewedHead: event.evidence.head };
    if (current.dirty || current.fingerprint !== event.evidence.fingerprint || digest(scopes(finding)) !== digest(event.evidence.scope)) return { ...base, status: "reopened", reason: "Relevant document or repository evidence changed after the assessment; prepare a new review." };
    return { ...base, status: event.outcome === "deferred" ? "deferred" : "current", reason: event.outcome === "deferred"
      ? "The review was deferred and remains outstanding." : "An explicit assessment covers the current committed scope. This does not approve an engineering decision or certify correctness." };
  } catch (error) { return { id, status: "unverified", reason: error instanceof Error ? error.message : String(error) }; }
}

/** Fingerprint receipt content so concurrent automation cannot publish an older assessment. */
export async function advisoryReviewInventory(root: string) {
  let names: string[];
  try { names = await fs.readdir(await storePath(root, ".mason/reviews/advisories")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (names.length > 5000) throw new Error("Advisory review inventory exceeds 5,000 records.");
  return Promise.all(names.filter(name => name.endsWith(".json")).sort().map(async name => [name, await readAuditInput(root, ".mason/reviews/advisories/" + name)]));
}

export async function reviewAdvisory(rootDir: string, input: AdvisoryReviewInput) {
  const root = await fs.realpath(rootDir), request = advisoryReviewRequest.parse(input);
  const { loadRepairBaseline } = await import("./repair.js");
  const baseline = await loadRepairBaseline(root, request.baselinePath);
  const finding = [...baseline.original.advisories, ...(baseline.original.suppressedAdvisories ?? [])].find(f => findingId(f) === request.findingId);
  if (!finding) throw new Error("No advisory with this findingId in the original baseline. Provable issues must be repaired and rechecked.");
  if (finding.evidence.kind === "decision-anchor") return { status: "decision-review-required", decisionId: finding.evidence.decisionId,
    hint: "Use review_decision to prepare evidence and record authorized acceptance, reaffirmation or retirement, then verify this original repair baseline. An advisory assessment cannot approve a decision." };
  const prepare = async () => {
    const record = await readRecord(root, request.findingId);
    const evidence = await reviewEvidence(root, finding);
    await git(root, "merge-base", "--is-ancestor", baseline.original.headHash!, evidence.head);
    const token = digest({ baseline: baseline.original, finding, evidence, record });
    return { record, evidence, token };
  };
  if (request.action === "prepare") {
    const state = await prepare();
    let diff: string | null = null, diffNote: string | undefined;
    const from = finding.evidence.kind === "doc-behind-manifests" ? finding.evidence.docLastCommit.hash : baseline.original.headHash!;
    try {
      const full = await git(root, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "-U3", from, state.evidence.head, "--", ...state.evidence.scope);
      diff = full.slice(0, 16000); if (full.length > diff.length) diffNote = "Diff preview truncated; inspect the full scoped diff before reviewing.";
    } catch { diffNote = "Diff preview unavailable; inspect the original cited evidence directly before reviewing."; }
    if ((await prepare()).token !== state.token) throw new Error("Review evidence changed during preparation; retry.");
    return { status: "prepared", findingId: request.findingId, finding, evidence: state.evidence,
      history: state.record?.events ?? [], reviewToken: state.token, diff, diffNote,
      hint: "Inspect the original finding, scoped document and relevant code changes. Record addressed, inapplicable or deferred only when the user or cited project review authorizes that assessment. Supply the actual reviewer, reason in note and reviewToken. Relevant edits must be committed first. Deferral remains outstanding. Review identities are recorded assertions, not authenticated approvals." };
  }
  if (!request.reviewer || !request.note || !request.reviewToken) throw new Error("Prepare first; recording an assessment requires reviewToken, reviewer and note.");
  return withLock(root, ".mason/reports/advisory-review-locks/" + request.findingId, async () => {
    const state = await prepare();
    if (state.token !== request.reviewToken) throw new Error("Review conflict: evidence or review history changed since preparation. Prepare and inspect a new review.");
    if (state.evidence.dirty) throw new Error("Commit relevant document and repository edits before recording the assessment. Unrelated local work may remain.");
    if ((state.record?.events.length ?? 0) >= 200) throw new Error("Review history limit reached; existing events were retained.");
    const { dirty, documentDigest, ...evidence } = state.evidence;
    const event = eventSchema.parse({ at: new Date().toISOString(), reviewer: request.reviewer, note: request.note,
      outcome: request.action, finding, evidence });
    const payload = { version: 1 as const, id: request.findingId, events: [...(state.record?.events ?? []), event] };
    if ((await prepare()).token !== state.token) throw new Error("Review conflict: evidence changed while recording the assessment.");
    await writeStoreJson(root, recordPath(request.findingId), { ...payload, digest: digest(payload) });
    return { status: "recorded", recordPath: recordPath(request.findingId), event,
      hint: "Review and commit this assessment record through the normal project workflow, then verify the original repair baseline. Relevant changes reopen the assessment; deferral remains outstanding." };
  });
}
