import fs from "node:fs/promises";
import path from "node:path";

export interface ProjectMarker {
  version: 1;
  initializedAt: string;
}

function masonDir(rootDir: string): string {
  return path.join(rootDir, ".mason");
}

function markerPath(rootDir: string): string {
  return path.join(masonDir(rootDir), "project.json");
}

export async function loadProjectMarker(
  rootDir: string
): Promise<ProjectMarker | null> {
  try {
    const raw = await fs.readFile(markerPath(rootDir), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveProjectMarker(
  rootDir: string,
  marker: ProjectMarker
): Promise<void> {
  await fs.mkdir(masonDir(rootDir), { recursive: true });
  await fs.writeFile(
    markerPath(rootDir),
    JSON.stringify(marker, null, 2),
    "utf-8"
  );
}

export async function isInitialized(rootDir: string): Promise<boolean> {
  const marker = await loadProjectMarker(rootDir);
  return marker !== null;
}

export function uninitializedResponse(action: string): string {
  return JSON.stringify(
    {
      initialized: false,
      hint: `This project hasn't been set up for Mason yet. Call \`mason_init\` first; it will walk the user through ${action}.`,
    },
    null,
    2
  );
}

const SETUP_PLAYBOOK = `You are walking the user through one-time Mason setup for this project. \
Mason persists a concept map of this codebase so future questions don't re-explore from scratch. \
The map is built via a Map-Reduce pattern so it covers the WHOLE codebase, not just a sample. \
Surface each question to the user in plain language and wait for their answer before proceeding.

CONSENT
Tell the user: "Mason will read your codebase in batches and build a concept map at .mason/snapshot.json. This can take a while — Mason makes several tool calls in sequence. Proceed?"
On no: stop. Mason setup is opt-in.
On yes: continue with the phases below.

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

PHASE 3 — Finalize
  1. Call \`mason_complete_init(dir)\` to mark the project as initialized.
  2. Confirm to the user that setup is complete and they can now ask architectural questions, request impact analysis, etc.

Notes:
- Read tools (\`get_snapshot\`, \`get_impact\`) refuse to run until \`mason_complete_init\` has been called. Do not skip Phase 3.
- If the user aborts mid-flow, the partials persist in \`.mason/partial-snapshots/\`; the next \`mason_init\` run can pick up where it left off.
- \`mason_init\` is idempotent — already-initialized projects return \`{ initialized: true }\`.`;

export function setupPlaybook(): string {
  return SETUP_PLAYBOOK;
}
