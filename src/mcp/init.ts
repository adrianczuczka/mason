import { z } from "zod";
import { readStoreJson } from "../utils/storage.js";
import { applyEdit, readText, type FileEdit } from "../setup/files.js";

export interface ProjectMarker {
  version: 1;
  initializedAt: string;
  features?: Record<string, unknown>;
}

const markerSchema = z
  .object({
    version: z.literal(1),
    initializedAt: z.string(),
    features: z.record(z.unknown()).optional(),
  })
  .passthrough();

export async function loadProjectMarker(rootDir: string): Promise<ProjectMarker | null> {
  const raw = await readStoreJson(rootDir, ".mason/local/project.json");
  if (raw === null) return null;
  const marker = markerSchema.parse(raw);
  return { ...marker, features: await loadProjectFeatures(rootDir) };
}

export async function loadProjectFeatures(rootDir: string) {
  const config = z
    .record(z.unknown())
    .parse((await readStoreJson(rootDir, ".mason/config.json")) ?? {});
  return z.record(z.unknown()).parse(config.features ?? {});
}

export async function saveProjectMarker(rootDir: string, marker: ProjectMarker): Promise<void> {
  const { ancillaryEdits } = await import("../setup/config.js");
  for (const edit of [
    ...(await ancillaryEdits(rootDir)),
    ...(await projectMarkerEdits(rootDir, marker)),
  ])
    await applyEdit(rootDir, edit);
}

async function projectMarkerEdits(rootDir: string, marker: ProjectMarker): Promise<FileEdit[]> {
  const { features, ...local } = markerSchema.parse(marker);
  const file = ".mason/local/project.json";
  const edits = [
    {
      path: file,
      before: await readText(rootDir, file),
      after: JSON.stringify(local, null, 2) + "\n",
    },
  ];
  if (features && Object.keys(features).length) {
    const configPath = ".mason/config.json",
      before = await readText(rootDir, configPath);
    const config = z.record(z.unknown()).parse(JSON.parse(before ?? "{}"));
    config.features = { ...z.record(z.unknown()).parse(config.features ?? {}), ...features };
    edits.push({ path: configPath, before, after: JSON.stringify(config, null, 2) + "\n" });
  }
  return edits;
}

/** Marker-delimited project instructions make the tools useful in later sessions. */
export const CLAUDE_MD_SECTION = `<!-- mason:start -->
## Mason project knowledge

Mason provides recorded decisions and file impact over MCP. A concept map is optional.

- Task, bug, change request, or investigation of why the project works this way → \`get_context\` with the task text and known files: matching decisions, related tests, impact, and any available map entries.
- Before editing a file → \`get_impact\` to check references, tests, and historical change partners.
- Investigation or correction reveals a reusable project lesson → \`save_decision\` as soon as the lesson is supported by evidence; do not wait for implementation, task completion, or merge. Record the established observation now and identify unimplemented remedies as tentative. Capture only the lasting constraint and reason, with anchors and known sources, owner, and recorder. This creates a proposal; never infer approval. Preserve uncertain causes and unknown attribution. Route project lessons here; keep personal preferences in agent memory. Skip code summaries, current checkout status, temporary task permissions, session trivia, and secrets. No qualifying lesson means no record.
- Before saving, compare the lesson with matching \`get_context\` records and any pending proposal. If new evidence changes the same lesson's assumptions, scope, or recommended action, revise it with \`save_decision(id: existingId)\`, including when it is accepted. Preserve supported rationale and sources, replace obsolete instructions, and add the new evidence. Create a separate record for a genuinely distinct lesson; skip unchanged restatements. Revision preserves history and leaves the accepted version operative until authorized review.
- Consult trust metadata before relying on entries: unknown or changed freshness requires inspection, stale or unknown map verification requires a fresh evidence review, and a recorded failed verdict means the description must be corrected. Check approval too: proposals are suggestions, legacy records are unreviewed, and accepted decisions are recorded constraints subject to freshness checks. An accepted revision remains operative while a pending proposal is reviewed; keep both versions and their freshness distinct.
- Asked to review pending project knowledge → \`mason_automation(action: "status")\` lists pending proposals and uncommitted records. For ordinary tasks, inspect matching proposals through \`get_context\`; do not request acceptance merely because a proposal exists.
- Asked to review or re-verify a decision → \`review_decision\` first to inspect content, sources, history, and code changes. To inspect accepted guidance separately, use inspectionScope \`operative\` on both preparation and inspection; a pending draft remains visible and unassessed. Default all scope covers both revisions. After source inspection finds no contradiction in the selected scope, record action \`inspect\` with the actual inspector, note, and prepared token; this does not claim human approval. Record acceptance, reaffirmation, or retirement only when authorized by the user or a cited team review, with the actual reviewer and reason. Never infer approval from unchanged code. Review and commit the local record through the normal project workflow.
- For an architectural overview, use \`get_snapshot\` if a map is available. If \`map.status\` is missing or invalid, use available decisions and source evidence; managed map creation has been removed.
- \`mason_init\` returns documentation audit and committed-diff review results, plus a short setup guide. Pass \`evidence\` with local CI manifest paths to include test and analysis results; the CLI equivalent is \`mason-review --evidence <manifest>\`. State skipped, unavailable, stale, or unknown checks explicitly. Related accepted decisions identify review context, not proven violations.

- Documentation repair and advisory assessment use the CLI. When repair is authorized, run \`mason audit --prepare-repair --json\` before edits, retain its baselinePath, and run \`mason audit --verify-repair <baselinePath> --json\` after edits and the final documentation commit. Keep original evidence and report unresolved, suppressed and unavailable checks.
- For an authorized advisory assessment, run \`mason audit review --baseline <path> --finding <id> --json\` to inspect evidence and obtain a reviewToken. Record the authorized outcome with the actual reviewer, note and token through that same CLI; use \`mason audit review --help\` for flags and dependency dismissals. Commit the assessment and verify the original baseline again. Deferred findings remain outstanding; changed evidence reopens reviews. Decision findings still use \`review_decision\`. Advisory closure never approves decisions.

- When Mason automation is installed, use \`mason_automation(action: "status")\` to inspect configured hooks and observed events, and \`mason_automation(action: "check")\` to resume its retained repair evidence. CLI fallback: \`mason status\` / \`mason check\`. Preserve existing baselines across sessions. Lifecycle hooks check decision anchors only; they do not verify documentation repairs. Explicit checks do not authorize unrelated repairs or approve advisories.

Inspect source for what the retrieved context does not answer.
<!-- mason:end -->`;

export type InitMode = "quickstart" | "setup";

const ASSISTANT_SETUP = `UNIFIED SETUP
When the user requests Mason setup, call mason_init again with mode: "setup" and host: "codex" or "claude" for the assistant being configured. This uses the same engine as mason setup: retain the initial audit before instruction edits, use the installed mason command on PATH, merge project MCP configuration and hooks, update marker-delimited instructions and Git ignore rules, and record setup. A concept map is optional.
If the user only requested inspection or review, report findings without running setup. The setup result distinguishes configured from observed activation. Explain the host's native trust step and request a new session; never trust hooks on the user's behalf or claim activation from generated configuration alone. After a normal task finishes, mason_automation(action: "status") or mason status reports observed context use and hook events. Existing findings remain reviewable; setup does not approve advisories or manufacture decisions.

The managed project guidance is:
${CLAUDE_MD_SECTION}`;

const QUICKSTART_PLAYBOOK = `Start with the audit and review results included in this response. No concept map is required.

1. Explain the actionable findings with their source evidence. Separate audit issues, advisories, and skipped checks. The review covers committed changes from the merge base to HEAD; workingTree paths are not included in that review. An unavailable or empty check is not proof that the project is correct. Use the CLI for full output if a summary is truncated.
2. Address findings within the user's requested scope. Setup alone authorizes Mason host configuration, hooks, instructions, and ignore rules; rewriting existing project claims requires repair scope. If repair is authorized, run \`mason audit --prepare-repair --json\` before editing; it saves the full original findings even when this summary is truncated. Inspect relevant source, make grounded edits, then run \`mason audit --verify-repair <baselinePath> --json\` with that same baseline, including after any final doc commit. Report resolved, unresolved, review-required, unverified, and new findings. Keep suppressed advisories visible even when setup has already dirtied a doc. Do not invent a decision just to populate the store.
3. Capture a supported lesson as soon as it is established; do not wait for implementation, task completion, or merge. Keep unimplemented remedies tentative. When the task reveals a real lesson or constraint, compare matching \`get_context\` records first. If its assumptions, scope, or recommended action changed, revise that record using \`save_decision(id: existingId)\`; create a separate record for a genuinely distinct lesson and skip unchanged restatements. Include title, body, category, anchors, and known owner/source/actor information. Preserve supported rationale and sources, replace obsolete instructions, and add new evidence. Missing attribution can be added later. The tool writes a local proposal; editing it preserves revision history and requires a new acceptance, while any earlier accepted revision remains operative. An unchanged save never refreshes its evidence. When decision review is requested, \`review_decision\` prepares the record and code evidence before any authorized verdict. Review and commit records through the normal workflow. Retrieve it on the next relevant task with \`get_context(dir, task, files)\`.

${ASSISTANT_SETUP}

OPTIONAL ARCHITECTURE MAP
Existing maps remain readable for legacy projects. Managed map creation has been removed; use the agent's own source tools for architecture investigations.`;

export function setupPlaybook(): string {
  return QUICKSTART_PLAYBOOK;
}
