import { z } from "zod";
import { readStoreJson } from "../utils/storage.js";
import { applyEdit, readText, type FileEdit } from "../setup/files.js";

export interface ProjectMarker {
  version: 1;
  initializedAt: string;
  features?: {
    confluence?: boolean;
  };
}

const markerSchema = z.object({
  version: z.literal(1), initializedAt: z.string(),
  features: z.object({ confluence: z.boolean().optional() }).passthrough().optional(),
}).passthrough();

export async function loadProjectMarker(rootDir: string): Promise<ProjectMarker | null> {
  const raw = await readStoreJson(rootDir, ".mason/local/project.json");
  if (raw === null) return null;
  const marker = markerSchema.parse(raw);
  return { ...marker, features: await loadProjectFeatures(rootDir) };
}

export async function loadProjectFeatures(rootDir: string) {
  const config = z.record(z.unknown()).parse(await readStoreJson(rootDir, ".mason/config.json") ?? {});
  return z.object({ confluence: z.boolean().optional() }).passthrough().parse(config.features ?? {});
}

export async function saveProjectMarker(rootDir: string, marker: ProjectMarker): Promise<void> {
  const { ancillaryEdits } = await import("../setup/config.js");
  for (const edit of [...await ancillaryEdits(rootDir), ...await projectMarkerEdits(rootDir, marker)]) await applyEdit(rootDir, edit);
}

async function projectMarkerEdits(rootDir: string, marker: ProjectMarker): Promise<FileEdit[]> {
  const { features, ...local } = markerSchema.parse(marker);
  const file = ".mason/local/project.json";
  const edits = [{ path: file, before: await readText(rootDir, file), after: JSON.stringify(local, null, 2) + "\n" }];
  if (features && Object.keys(features).length) {
    const configPath = ".mason/config.json", before = await readText(rootDir, configPath);
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

- Task, bug, or change request → \`get_context\` with the task text and known files: matching decisions, related tests, impact, and any available map entries.
- Before editing a file → \`get_impact\` to check references, tests, and historical change partners.
- Learned something the code cannot explain (a failed approach, an incident's cause, a workaround's reason, a review-settled convention) → \`save_decision\` with rationale, anchors, and any known owner, sources, and recorder. It creates a proposal immediately without setup or a map. Never invent attribution or record code-derivable facts, session trivia, or secrets.
- Consult trust metadata before relying on entries: unknown or changed freshness requires inspection, and failed verification means the description must be corrected. Check approval too: proposals are suggestions, legacy records are unreviewed, and accepted decisions are recorded constraints subject to freshness checks. An accepted revision remains operative while a pending proposal is reviewed; keep both versions and their freshness distinct.
- Asked to review or re-verify a decision → \`review_decision\` first to inspect content, sources, history, and code changes. Record acceptance, reaffirmation, or retirement only when authorized by the user or a cited team review, with the actual reviewer and reason. Never infer approval from unchanged code. Review and commit the local record through the normal project workflow.
- For an architectural overview, use \`get_snapshot\` if a map is available. If \`map.status\` is missing or invalid, use available decisions and source evidence; do not start building a map unless requested.
- \`mason_init\` returns documentation audit and committed-diff review results, plus a short setup guide. Pass \`evidence\` with local CI manifest paths to include test and analysis results; the CLI equivalent is \`mason-review --evidence <manifest>\`. State skipped, unavailable, stale, or unknown checks explicitly. Related accepted decisions identify review context, not proven violations.

- When documentation repair is authorized, use \`mason_repair(action: "prepare")\` before edits, keep its baselinePath, and use \`mason_repair(action: "verify", baselinePath)\` after edits and any final doc commit. Report every original finding's outcome and any new findings. Suppressed advisories remain unresolved; editing a doc does not approve it.

- When Mason automation is installed, use \`mason_automation(action: "status")\` to inspect configured hooks and observed events, and \`mason_automation(action: "check")\` to resume its retained repair evidence. CLI fallback: \`mason-auto status\` / \`mason-auto check\`. Preserve existing baselines across sessions. Automatic checks do not authorize unrelated repairs or approve advisories.

Inspect source for what the retrieved context does not answer.
<!-- mason:end -->`;

export type InitMode = "quickstart" | "map" | "setup";

const ASSISTANT_SETUP = `UNIFIED SETUP
When the user requests Mason setup, call mason_init again with mode: "setup" and host: "codex" or "claude" for the assistant being configured. This uses the same engine as mason-auto setup: retain the initial audit before instruction edits, use the installed mason command on PATH, merge project MCP configuration and hooks, update marker-delimited instructions and Git ignore rules, and record setup. A concept map is optional.
If the user only requested inspection or review, report findings without running setup. The setup result distinguishes configured from observed activation. Explain the host's native trust step and request a new session; never trust hooks on the user's behalf or claim activation from generated configuration alone. After a normal task finishes, mason_automation(action: "status") or mason-auto status reports observed context use and hook events. Existing findings remain reviewable; setup does not approve advisories or manufacture decisions.

The managed project guidance is:
${CLAUDE_MD_SECTION}`;

const QUICKSTART_PLAYBOOK = `Start with the audit and review results included in this response. No concept map is required.

1. Explain the actionable findings with their source evidence. Separate audit issues, advisories, and skipped checks. The review covers committed changes from the merge base to HEAD; workingTree paths are not included in that review. An unavailable or empty check is not proof that the project is correct. Use the CLI for full output if a summary is truncated.
2. Address findings within the user's requested scope. Setup alone authorizes Mason host configuration, hooks, instructions, and ignore rules; rewriting existing project claims requires repair scope. If repair is authorized, call \`mason_repair(dir, action: "prepare")\` before editing; it saves the full original findings even when this summary is truncated. Inspect relevant source, make grounded edits, then call \`mason_repair(dir, action: "verify", baselinePath)\` with that same baseline, including after any final doc commit. Report resolved, unresolved, review-required, unverified, and new findings. Keep suppressed advisories visible even when setup has already dirtied a doc. Do not invent a decision just to populate the store.
3. When the task reveals a real lesson or constraint, call \`save_decision\` with title, body, category, anchors, and known owner/source/actor information. Missing attribution can be added later. The tool writes a local proposal; editing it preserves revision history and requires a new acceptance, while any earlier accepted revision remains operative. An unchanged save never refreshes its evidence. When decision review is requested, \`review_decision\` prepares the record and code evidence before any authorized verdict. Review and commit records through the normal workflow. Retrieve it on the next relevant task with \`get_context(dir, task, files)\`.

${ASSISTANT_SETUP}

OPTIONAL ARCHITECTURE MAP
A full map adds feature and flow navigation. Build it only if the user requests it, by calling \`mason_init(dir, mode: "map")\`. Decision capture and task context do not depend on that build.`;

const MAP_PLAYBOOK = `The user has requested a full architecture map. Follow this Map-Reduce workflow to cover the codebase. Report the audit and review findings included in this response before beginning.

PHASE 1 — Map (loop until done)
Goal: process every file in the codebase, batch by batch, producing a partial concept map per batch.

  1. Call \`generate_snapshot_batch(dir)\` (omit offset on the first call).
     The response includes:
     - \`batchId\`: identifier for this batch
     - \`offset\`, \`nextOffset\`, \`totalFiles\`: progress markers
     - \`instructions\`: the system prompt for the batch step
     - \`prompt\`: the files in this batch (skeletons + a few deeper bodies)
  2. Following the \`instructions\`, derive features and flows that involve ONLY the files in this batch. Use product-natural feature names ("home screen", not "HomeScreenAndroid") so the reduce step can merge platform variants.
  3. Call \`save_partial_snapshot(dir, batchId, offset, features, flows)\` to persist the partial.
  4. If \`nextOffset\` is null, the Map phase is done. Otherwise call \`generate_snapshot_batch(dir, offset=nextOffset)\` and repeat from step 2.

  Briefly tell the user "Batch N of M done" each iteration so they see progress.

  CRITICAL RULES FOR PHASE 1:
  - Derive features and file paths ONLY from what appears verbatim in the \`prompt\` field of each batch response. NEVER invent paths from memory, prior projects, or what you assume a project of this kind would contain. If you have not seen a path in a batch \`prompt\`, do not put it in \`features.files\` or \`flows.chain\`.
  - Process batches SEQUENTIALLY: one \`generate_snapshot_batch\` → derive → one \`save_partial_snapshot\` → next \`generate_snapshot_batch\`. Do not parallelise. Do not call \`save_snapshot\` during this phase — that is a Phase 2 step.
  - You must walk every batch until \`nextOffset\` is null. Do not stop early. Do not skip ahead to reduce until every batch has been saved as a partial.

PHASE 2 — Reduce (once)
Goal: merge all partial maps into one coherent product-shaped catalog.

  1. Call \`reduce_snapshot(dir)\`. It returns every partial map plus reconciliation instructions.
  2. Follow the instructions to produce a unified \`features\` and \`flows\` map. Specifically: merge platform variants ("home Android" + "home iOS" → "home screen"), dedupe near-duplicates, reconcile descriptions, and ensure every file from every partial appears somewhere in the final map.
  3. Call \`save_snapshot(dir, features, flows)\` ONCE with the unified map. Mason detects that partials exist and replaces the snapshot wholesale (rather than merging with any earlier state) and then clears the partials. Do not call \`save_snapshot\` more than once per Map-Reduce run.

${ASSISTANT_SETUP}

If a build is interrupted, its partials remain in \`.mason/partial-snapshots/\`. Re-run \`mason_init(dir, mode: "map")\` to obtain this workflow again.`;

export function setupPlaybook(mode: InitMode = "quickstart"): string {
  return mode === "map" ? MAP_PLAYBOOK : QUICKSTART_PLAYBOOK;
}
