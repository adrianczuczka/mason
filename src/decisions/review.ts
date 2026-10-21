import { captureAnchors } from "./anchors.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { loadDecisionStore, saveDecisionRecord, withDecisionWrite } from "./decisions.js";
import {
  decisionInspectionDigest,
  latestDecisionInspection,
  decisionApproval,
  decisionAnchors,
  decisionContent,
  decisionProvenance,
  effectiveDecision,
  importLegacy,
  type InspectionScope,
  type DecisionRecord,
  type ReviewedDecisionRecord,
} from "./provenance.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { getChangesWithStatus, getWorkingTree, touchedPaths } from "../drift/drift.js";
import { anchorMatches, matchingPaths } from "../utils/paths.js";
import { createFileAccess } from "../utils/files.js";
import { branchAttribution } from "./attribution.js";

const exec = promisify(execFile);
const requestSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  action: z.enum(["prepare", "inspect", "accept", "reaffirm", "retire"]).default("prepare"),
  inspectionScope: z.enum(["all", "operative"]).default("all"),
  diffFrom: z.enum(["lastReview", "capture"]).default("lastReview"),
  inspector: z.string().trim().min(1).max(200).optional(),
  reviewer: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().min(1).max(1500).optional(),
  reviewToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ReviewDecisionInput = z.input<typeof requestSchema>;

async function reviewState(root: string, record: DecisionRecord, scope: InspectionScope = "all") {
  const target = scope === "operative" ? effectiveDecision(record) : record;
  const [headHash, workingTree, changes] = await Promise.all([
    getCurrentGitHash(root),
    getWorkingTree(root),
    getChangesWithStatus(root, target.refreshedHash),
  ]);
  const anchors = scope === "operative" ? target.files : decisionAnchors(record);
  const committed = (changes ?? []).filter((c) =>
    [c.path, ...(c.previousPath ? [c.previousPath] : [])].some((file) =>
      anchors.some((anchor) => anchorMatches(anchor, file)),
    ),
  );
  const evidence = {
    baseHash: target.refreshedHash,
    headHash,
    historyAvailable: changes !== null,
    changedFiles: touchedPaths(committed),
    localChanges: matchingPaths(anchors, workingTree.changedFiles),
  };
  const capture = await captureAnchors(root, anchors);
  const reviewToken = createHash("sha256")
    .update(
      JSON.stringify({
        record,
        evidence,
        capture,
        workingTreeAvailable: workingTree.available,
        ...(scope === "operative" ? { inspectionScope: scope } : {}),
      }),
    )
    .digest("hex");
  return { reviewToken, evidence, capture, committed, workingTreeAvailable: workingTree.available };
}

const RETURNED_INSPECTIONS = 2;
const MAX_PREVIEW_COMMITS = 20;

/** Earlier inspections already checked older changes, so preview from the latest inspection
 * still valid for this record and scope. Its commit may be gone after a rebase or prune. */
async function diffSince(
  root: string,
  record: DecisionRecord,
  scope: InspectionScope,
  diffFrom: "lastReview" | "capture",
) {
  const baseline = (scope === "operative" ? effectiveDecision(record) : record).refreshedHash;
  const inspection =
    diffFrom === "lastReview" ? latestDecisionInspection(record, scope) : undefined;
  if (inspection && /^[a-f0-9]{40,64}$/.test(inspection.headHash)) {
    try {
      await exec("git", ["cat-file", "-e", `${inspection.headHash}^{commit}`], { cwd: root });
      return { from: "inspection" as const, commit: inspection.headHash, at: inspection.at };
    } catch {
      return {
        from: "baseline" as const,
        commit: baseline,
        note: "The latest inspection's commit is not available locally; the diff starts at the evidence baseline.",
      };
    }
  }
  return { from: "baseline" as const, commit: baseline };
}

/** Keep the latest inspections in responses; every inspection's capture repeats all anchor
 * hashes, and the complete list remains in the record file. */
function trimInspections(record: DecisionRecord): DecisionRecord {
  return record.version === 2 && (record.inspections?.length ?? 0) > RETURNED_INSPECTIONS
    ? { ...record, inspections: record.inspections!.slice(-RETURNED_INSPECTIONS) }
    : record;
}

async function previews(
  root: string,
  state: Awaited<ReturnType<typeof reviewState>>,
  since: Awaited<ReturnType<typeof diffSince>>,
) {
  const access = await createFileAccess(root);
  const anchors = state.capture.anchors;
  const git = (args: string[]) =>
    exec("git", ["--literal-pathspecs", ...args, "--", ...anchors], {
      cwd: root,
      maxBuffer: 1024 * 1024,
    }).then(({ stdout }) => stdout);
  const range =
    state.evidence.headHash === "unknown" ? null : [since.commit, state.evidence.headHash];
  let changedSince: string[] = [];
  let commits: string[] = [];
  if (range && anchors.length)
    try {
      changedSince = (await git(["diff", "--name-only", "--no-renames", ...range]))
        .split("\n")
        .filter(Boolean);
      commits = (
        await git([
          "log",
          "--oneline",
          "--no-decorate",
          "-n",
          String(MAX_PREVIEW_COMMITS + 1),
          `${range[0]}..${range[1]}`,
        ])
      )
        .split("\n")
        .filter(Boolean);
    } catch {
      /* Reported below as an unavailable diff. */
    }
  const candidates = [
    ...new Set([
      ...changedSince,
      ...state.evidence.changedFiles,
      ...state.evidence.localChanges,
      ...anchors,
      ...(await access.list()).filter((file) =>
        anchors.some((anchor) => anchorMatches(anchor, file)),
      ),
    ]),
  ];
  const files: Array<{ path: string; preview: string; totalLines: number }> = [];
  const omittedFiles: string[] = [];
  for (const file of candidates) {
    if (files.length >= 6) {
      omittedFiles.push(file);
      continue;
    }
    const source = await access.read(file);
    if (!source) {
      omittedFiles.push(file);
      continue;
    }
    files.push({
      path: source.path,
      preview: source.content.slice(0, 2000),
      totalLines: source.totalLines,
    });
  }
  let diff: string | null = null;
  let diffUnavailable: string | undefined;
  if (range && changedSince.length) {
    try {
      const stdout = await git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "-U3",
        ...range,
      ]);
      diff = stdout.slice(0, 16000);
      if (stdout.length > diff.length)
        diffUnavailable = "Diff preview was truncated; inspect the full diff before reviewing.";
    } catch {
      diffUnavailable =
        "Diff preview could not be read within its size bound; inspect the diff separately.";
    }
  } else if (range && !changedSince.length && since.commit !== state.evidence.headHash) {
    // An unreadable range must not look like an unchanged one.
    try {
      await exec("git", ["cat-file", "-e", `${since.commit}^{commit}`], { cwd: root });
    } catch {
      diffUnavailable = "The diff base is not available locally; inspect the history separately.";
    }
  }
  // Changes this branch never touched came from the default branch it builds on.
  const branch = changedSince.length ? await branchAttribution(root).catch(() => null) : null;
  return {
    diffSince: since,
    ...(branch
      ? {
          attribution: {
            target: branch.target,
            mergeBase: branch.mergeBase,
            branchFiles: changedSince.filter((file) => branch.branchFiles.has(file)),
            targetFiles: changedSince.filter((file) => !branch.branchFiles.has(file)),
          },
        }
      : {}),
    commits: commits.slice(0, MAX_PREVIEW_COMMITS),
    ...(commits.length > MAX_PREVIEW_COMMITS ? { commitsTruncated: true } : {}),
    files,
    diff,
    diffUnavailable,
    omittedFiles,
    hint: "Bounded source and diff previews only. Deleted, excluded, sensitive, oversized, or additional files may be omitted. Inspect relevant evidence beyond these previews before recording a verdict.",
  };
}

/** Prepare first, then attest to that exact record and committed code revision. */
export async function reviewDecision(root: string, input: ReviewDecisionInput) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: parsed.error.message };
  const request = parsed.data;
  if (request.inspectionScope === "operative" && !["prepare", "inspect"].includes(request.action))
    return {
      status: "error",
      error:
        "Operative scope is only for preparation and source inspection, not human verdicts. Prepare with all scope for acceptance, reaffirmation or retirement.",
    };
  const read = async () => {
    const store = await loadDecisionStore(root);
    return { ...store, record: store.records.find((record) => record.id === request.id) };
  };
  if (request.action === "prepare") {
    const { record, diagnostics } = await read();
    if (!record)
      return {
        status: "error",
        error: `No readable decision with id "${request.id}"`,
        diagnostics,
      };
    if (
      request.inspectionScope === "operative" &&
      (record.status !== "active" || decisionApproval(effectiveDecision(record)) !== "accepted")
    )
      return {
        status: "error",
        error:
          "Operative inspection requires an active accepted revision; inspect proposals or legacy records with all scope.",
      };
    const state = await reviewState(root, record, request.inspectionScope);
    const operativeDecision = effectiveDecision(record);
    const inspections = record.version === 2 ? (record.inspections?.length ?? 0) : 0;
    return {
      status: "prepared",
      record: trimInspections(record),
      ...(inspections > RETURNED_INSPECTIONS
        ? { omittedInspections: inspections - RETURNED_INSPECTIONS }
        : {}),
      ...(operativeDecision !== record && request.inspectionScope === "all"
        ? { operativeDecision: trimInspections(operativeDecision) }
        : {}),
      inspectionScope: request.inspectionScope,
      ...(request.inspectionScope === "operative"
        ? {
            inspectionTarget: {
              ...decisionContent(operativeDecision),
              approval: decisionApproval(operativeDecision),
              revision: operativeDecision.version === 2 ? operativeDecision.revision : 0,
              refreshedHash: operativeDecision.refreshedHash,
            },
            ...(operativeDecision !== record
              ? {
                  pendingProposal: {
                    revision: record.version === 2 ? record.revision : 0,
                    assessment: "not_assessed",
                  },
                }
              : {}),
          }
        : {}),
      provenance: decisionProvenance(record),
      ...state,
      diagnostics,
      previews: await previews(
        root,
        state,
        await diffSince(root, record, request.inspectionScope, request.diffFrom),
      ),
      hint:
        request.inspectionScope === "operative"
          ? "Inspect only the accepted inspectionTarget against its source and diff. Use the same inspectionScope: operative and token with action inspect. This reports no contradiction for that revision only; pending content remains unassessed and visible. Do not attest to the draft or infer human approval. If the accepted guidance is contradicted or uncertain, explain that instead of recording no contradiction."
          : "Inspect the proposed content, operativeDecision, sources, history, and code changes. A pending proposal leaves the prior accepted revision operative; accepting it replaces that revision, and retirement withdraws the entire decision including its proposal. Evidence covers both revisions' anchors. After inspecting the relevant code, action inspect with inspector, note and reviewToken records no_contradiction_found without human approval; it does not accept or reaffirm the decision. Only record acceptance or reaffirmation when the user or cited team review has authorized it. Supply that reviewer's identity, a reason, and this reviewToken. Do not invent identities or infer agreement from unchanged code. Acceptance and reaffirmation require committed anchor changes; retirement is available independently. Missing old history remains visible in the event even if a reviewer establishes a new baseline at HEAD. Saved reviews are local assertions for normal PR review, not authenticated approvals.",
    };
  }
  if (
    !(request.action === "inspect" ? request.inspector : request.reviewer) ||
    !request.note ||
    !request.reviewToken
  )
    return {
      status: "error",
      error:
        "Prepare the review first, then provide reviewToken, note, and inspector for inspect or reviewer for a human verdict.",
    };
  return withDecisionWrite(root, async () => {
    const { record: original, diagnostics } = await read();
    if (diagnostics.length)
      return {
        status: "error",
        error: "Repair malformed decision records before recording a review.",
        diagnostics,
      };
    if (!original) return { status: "error", error: `No decision with id "${request.id}"` };
    const state = await reviewState(root, original, request.inspectionScope);
    if (state.reviewToken !== request.reviewToken)
      return {
        status: "conflict",
        error:
          "The decision or code revision changed after preparation. Prepare and inspect a new review.",
      };
    if (original.status !== "active")
      return {
        status: "error",
        error: "Archived decisions cannot be reviewed again; create a new proposal.",
      };
    if (request.action === "inspect") {
      if (
        request.inspectionScope === "operative" &&
        decisionApproval(effectiveDecision(original)) !== "accepted"
      )
        return { status: "error", error: "Operative inspection requires an accepted revision." };
      if (
        !state.capture.complete ||
        !state.capture.anchors.length ||
        state.evidence.headHash === "unknown" ||
        !state.workingTreeAvailable
      ) {
        return {
          status: "error",
          error:
            "Inspection requires complete readable anchor content and Git evidence; narrow or repair the scope and prepare again.",
        };
      }
      const record = importLegacy(original, new Date().toISOString());
      if ((record.inspections?.length ?? 0) >= 200)
        return {
          status: "error",
          error: "Inspection history limit reached; existing evidence was retained.",
        };
      const inspection = {
        at: new Date().toISOString(),
        inspector: request.inspector!,
        note: request.note!,
        outcome: "no_contradiction_found" as const,
        decisionDigest: decisionInspectionDigest(record, request.inspectionScope),
        ...(request.inspectionScope === "operative" ? { scope: "operative" as const } : {}),
        headHash: state.evidence.headHash,
        capture: state.capture,
      };
      if (
        (await reviewState(root, original, request.inspectionScope)).reviewToken !==
        state.reviewToken
      )
        return {
          status: "conflict",
          error: "Anchor content changed during inspection; prepare again.",
        };
      await saveDecisionRecord(root, {
        ...record,
        inspections: [...(record.inspections ?? []), inspection],
      });
      return {
        status: "inspected",
        id: record.id,
        inspection,
        approval: record.approval,
        ...(request.inspectionScope === "operative" && effectiveDecision(record) !== record
          ? { pendingProposal: { revision: record.revision, assessment: "not_assessed" } }
          : {}),
        hint: "Inspection recorded locally; no human acceptance or reaffirmation was claimed. Relevant content changes reopen the advisory. Review and commit this record through the project workflow.",
      };
    }
    const approval = decisionApproval(original);
    if (request.action === "accept" && approval === "accepted")
      return {
        status: "error",
        error: "This decision is already accepted. Use reaffirm to record a new review.",
      };
    if (request.action === "reaffirm" && approval !== "accepted")
      return {
        status: "error",
        error:
          "Only accepted decisions can be reaffirmed. Review and accept this proposal or legacy record first.",
      };
    const now = new Date().toISOString();
    const record = importLegacy(original, now);
    if (request.action !== "retire") {
      if (!record.owner || !record.sources.length)
        return {
          status: "error",
          error:
            "Acceptance requires an owner and at least one source. Add them with save_decision, then prepare a new review.",
        };
      if (
        state.evidence.headHash === "unknown" ||
        !state.workingTreeAvailable ||
        state.evidence.localChanges.length
      )
        return {
          status: "error",
          error:
            "Acceptance requires readable Git HEAD and working-tree evidence with no uncommitted anchor changes. Commit the anchor changes and prepare a new review.",
          evidence: state.evidence,
        };
    }
    const status = request.action === "retire" ? "retired" : "active";
    const nextApproval = request.action === "retire" ? record.approval : "accepted";
    const refreshedHash =
      request.action === "retire" ? record.refreshedHash : state.evidence.headHash;
    const event = {
      kind:
        request.action === "accept"
          ? "accepted"
          : request.action === "reaffirm"
            ? "reaffirmed"
            : "retired",
      at: now,
      actor: request.reviewer,
      note: request.note,
      revision: record.revision,
      content: decisionContent(record),
      approval: nextApproval,
      status,
      refreshedHash,
      evidence: state.evidence,
      capture: request.action === "retire" ? record.capture : undefined,
    } as const;
    const updated: ReviewedDecisionRecord = {
      ...record,
      status,
      approval: nextApproval,
      refreshedHash,
      capture: event.capture,
      updatedAt: now,
      history: [...record.history, event],
    };
    // Detect an external Git operation during review preparation, too.
    if ((await reviewState(root, original)).reviewToken !== state.reviewToken)
      return {
        status: "conflict",
        error: "Code changed while the review was being recorded. Prepare a new review.",
      };
    await saveDecisionRecord(root, updated);
    return {
      status: event.kind,
      id: record.id,
      event,
      hint: "Review recorded locally. Review and commit the decision file through the normal project workflow.",
    };
  });
}
