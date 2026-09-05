import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { loadDecisionStore, saveDecisionRecord, withDecisionWrite } from "./decisions.js";
import { decisionApproval, decisionContent, decisionProvenance, importLegacy, type DecisionRecord, type ReviewedDecisionRecord } from "./provenance.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { getChangesWithStatus, getWorkingTree, touchedPaths } from "../drift/drift.js";
import { anchorMatches, matchingPaths } from "../utils/paths.js";
import { createFileAccess } from "../utils/files.js";

const exec = promisify(execFile);
const requestSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  action: z.enum(["prepare", "accept", "reaffirm", "retire"]).default("prepare"),
  reviewer: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().min(1).max(1500).optional(),
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type ReviewDecisionInput = z.input<typeof requestSchema>;

async function reviewState(root: string, record: DecisionRecord) {
  const [headHash, workingTree, changes] = await Promise.all([
    getCurrentGitHash(root), getWorkingTree(root), getChangesWithStatus(root, record.refreshedHash),
  ]);
  const committed = (changes ?? []).filter(c => [c.path, ...(c.previousPath ? [c.previousPath] : [])].some(file => record.files.some(anchor => anchorMatches(anchor, file))));
  const evidence = {
    baseHash: record.refreshedHash, headHash, historyAvailable: changes !== null,
    changedFiles: touchedPaths(committed), localChanges: matchingPaths(record.files, workingTree.changedFiles),
  };
  const reviewToken = createHash("sha256").update(JSON.stringify({ record, evidence, workingTreeAvailable: workingTree.available })).digest("hex");
  return { reviewToken, evidence, committed, workingTreeAvailable: workingTree.available };
}

async function previews(root: string, record: DecisionRecord, state: Awaited<ReturnType<typeof reviewState>>) {
  const access = await createFileAccess(root);
  const candidates = [...new Set([...state.evidence.changedFiles, ...state.evidence.localChanges, ...record.files,
    ...(await access.list()).filter(file => record.files.some(anchor => anchorMatches(anchor, file))),
  ])];
  const files: Array<{ path: string; preview: string; totalLines: number }> = [];
  const omittedFiles: string[] = [];
  const diffPaths: string[] = [];
  for (const file of candidates) {
    if (files.length >= 6) { omittedFiles.push(file); continue; }
    const source = await access.read(file);
    if (!source) { omittedFiles.push(file); continue; }
    files.push({ path: source.path, preview: source.content.slice(0, 2000), totalLines: source.totalLines });
    if (state.evidence.changedFiles.includes(file)) diffPaths.push(file);
  }
  let diff: string | null = null;
  let diffUnavailable: string | undefined;
  if (state.evidence.historyAvailable && diffPaths.length) {
    try {
      const { stdout } = await exec("git", ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "-U3", record.refreshedHash, state.evidence.headHash, "--", ...diffPaths], { cwd: root, maxBuffer: 1024 * 1024 });
      diff = stdout.slice(0, 16000);
      if (stdout.length > diff.length) diffUnavailable = "Diff preview was truncated; inspect the full diff before reviewing.";
    } catch { diffUnavailable = "Diff preview could not be read within its size bound; inspect the diff separately."; }
  }
  return { files, diff, diffUnavailable, omittedFiles, hint: "Bounded source and diff previews only. Deleted, excluded, sensitive, oversized, or additional files may be omitted. Inspect relevant evidence beyond these previews before recording a verdict." };
}

/** Prepare first, then attest to that exact record and committed code revision. */
export async function reviewDecision(root: string, input: ReviewDecisionInput) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: parsed.error.message };
  const request = parsed.data;
  const read = async () => {
    const store = await loadDecisionStore(root);
    return { ...store, record: store.records.find(record => record.id === request.id) };
  };
  if (request.action === "prepare") {
    const { record, diagnostics } = await read();
    if (!record) return { status: "error", error: `No readable decision with id "${request.id}"`, diagnostics };
    const state = await reviewState(root, record);
    return {
      status: "prepared", record, provenance: decisionProvenance(record), ...state, diagnostics,
      previews: await previews(root, record, state),
      hint: "Inspect the content, sources, history, and code changes. Only record acceptance or reaffirmation when the user or cited team review has authorized it. Supply that reviewer's identity, a reason, and this reviewToken. Do not invent identities or infer agreement from unchanged code. Acceptance and reaffirmation require committed anchor changes; retirement is available independently. Missing old history remains visible in the event even if a reviewer establishes a new baseline at HEAD. Saved reviews are local assertions for normal PR review, not authenticated approvals.",
    };
  }
  if (!request.reviewer || !request.note || !request.reviewToken) return { status: "error", error: "Prepare the review first, then provide reviewToken, reviewer, and note." };
  return withDecisionWrite(root, async () => {
    const { record: original, diagnostics } = await read();
    if (diagnostics.length) return { status: "error", error: "Repair malformed decision records before recording a review.", diagnostics };
    if (!original) return { status: "error", error: `No decision with id "${request.id}"` };
    const state = await reviewState(root, original);
    if (state.reviewToken !== request.reviewToken) return { status: "conflict", error: "The decision or code revision changed after preparation. Prepare and inspect a new review." };
    if (original.status !== "active") return { status: "error", error: "Archived decisions cannot be reviewed again; create a new proposal." };
    const approval = decisionApproval(original);
    if (request.action === "accept" && approval === "accepted") return { status: "error", error: "This decision is already accepted. Use reaffirm to record a new review." };
    if (request.action === "reaffirm" && approval !== "accepted") return { status: "error", error: "Only accepted decisions can be reaffirmed. Review and accept this proposal or legacy record first." };
    const now = new Date().toISOString();
    const record = importLegacy(original, now);
    if (request.action !== "retire") {
      if (!record.owner || !record.sources.length) return { status: "error", error: "Acceptance requires an owner and at least one source. Add them with save_decision, then prepare a new review." };
      if (state.evidence.headHash === "unknown" || !state.workingTreeAvailable || state.evidence.localChanges.length) return { status: "error", error: "Acceptance requires readable Git HEAD and working-tree evidence with no uncommitted anchor changes. Commit the anchor changes and prepare a new review.", evidence: state.evidence };
    }
    const status = request.action === "retire" ? "retired" : "active";
    const nextApproval = request.action === "retire" ? record.approval : "accepted";
    const refreshedHash = request.action === "retire" ? record.refreshedHash : state.evidence.headHash;
    const event = { kind: request.action === "accept" ? "accepted" : request.action === "reaffirm" ? "reaffirmed" : "retired",
      at: now, actor: request.reviewer, note: request.note, revision: record.revision, content: decisionContent(record),
      approval: nextApproval, status, refreshedHash, evidence: state.evidence,
    } as const;
    const updated: ReviewedDecisionRecord = { ...record, status, approval: nextApproval, refreshedHash, updatedAt: now, history: [...record.history, event] };
    // Detect an external Git operation during review preparation, too.
    if ((await reviewState(root, original)).reviewToken !== state.reviewToken) return { status: "conflict", error: "Code changed while the review was being recorded. Prepare a new review." };
    await saveDecisionRecord(root, updated);
    return { status: event.kind, id: record.id, event, hint: "Review recorded locally. Review and commit the decision file through the normal project workflow." };
  });
}
