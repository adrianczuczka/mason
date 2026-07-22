import fs from "node:fs/promises";
import path from "node:path";

export interface ProjectMarker {
  version: 1;
  initializedAt: string;
  features?: {
    confluence?: boolean;
  };
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

/**
 * The section the setup playbook offers to add to the project's CLAUDE.md.
 * This is Mason's salience channel: benchmark runs showed assistants ignore
 * MCP tool descriptions in favor of grep muscle memory, but reliably follow
 * project instructions. Marker-delimited so a future init can update it.
 */
export const CLAUDE_MD_SECTION = `<!-- mason:start -->
## Mason concept map

This project has a Mason concept map (\`.mason/snapshot.json\`) served over MCP. Use it BEFORE exploring the codebase with grep, glob, or file reads:

- Given a task, bug, or change request → call \`get_context\` with the task text first. One call returns the relevant features, files, tests, blast radius, freshness, and recorded decisions.
- Asked how something works or where it lives → call \`get_snapshot\` first.
- Before editing any file → call \`get_impact\` for co-change history, references, and related tests.
- Learned something the code alone can't tell you — a failed approach ("we tried X, it broke Y"), a deprecation ("don't extend Z"), a workaround and its reason, a convention settled in review → call \`save_decision\` to record it for the team. Best moments: the end of a debugging session, right after a design choice. Records are git-committed and PR-reviewed like code. Do NOT record anything derivable by reading the code, session trivia, or secrets.
- Decisions returned by \`get_context\` are constraints — follow them. If one is marked stale, verify it still holds before relying on it.

Fall back to manual exploration only for details the map doesn't answer.
<!-- mason:end -->`;

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

PHASE 3 — Confluence sync (optional)
Goal: optionally configure Confluence so the concept map can be exported as a product-readable wiki later.

Tell the user: "Mason can keep a Confluence wiki in sync with the concept map, rewriting it into product-readable language for PMs and designers. Want to set that up now? You can also skip and configure it later by asking your assistant to 'set up Confluence for this project'."
On no: skip to Phase 4.
On yes:
  1. Ask the user for the Atlassian site URL (e.g. \`acme.atlassian.net\` or \`https://acme.atlassian.net\`).
  2. Ask for the user's Atlassian account email.
  3. Tell the user: "Generate an API token at https://id.atlassian.com/manage-profile/security/api-tokens (label it 'Mason') and paste it here. WARNING: the token will be visible in this chat history; if that's not acceptable, skip Confluence and configure it elsewhere."
  4. Call \`mason_set_confluence({ baseUrl, email, apiToken })\` — no spaceKey on the first call. The tool validates credentials and returns a list of spaces.
  5. Show the spaces to the user (key + name) and ask which one to use.
  6. Call \`mason_set_confluence({ baseUrl, email, apiToken, spaceKey })\` with the chosen spaceKey to persist.
  7. Confirm Confluence is configured. Mention they can run \`export_to_confluence\` whenever they want to sync.

If the credentials are rejected with a 401/403 the tool returns a friendly error — re-ask the user for a fresh token or correct email.

PHASE 4 — Assistant instructions (recommended)
Goal: make sure future assistant sessions actually use the map instead of re-exploring.

Tell the user: "Assistants reliably follow project instructions (CLAUDE.md) but often ignore available tools. Mason works best if I add a short section to this project's CLAUDE.md telling assistants to consult the concept map first. Add it?"
On no: skip to Phase 5.
On yes: append the following section verbatim to the project's CLAUDE.md (create the file with just this section if it doesn't exist; if the \`<!-- mason:start -->\` marker is already present, replace the marked block instead of appending):

${CLAUDE_MD_SECTION}

PHASE 5 — Finalize
  1. Call \`mason_complete_init(dir, { confluenceConfigured: true | false })\` — true if Phase 3 ended with status "saved", false otherwise.
  2. Confirm to the user that setup is complete and they can now ask architectural questions, request impact analysis, or sync to Confluence (if configured).

Notes:
- Read tools (\`get_snapshot\`, \`get_impact\`) refuse to run until \`mason_complete_init\` has been called. Do not skip Phase 5.
- If the user aborts mid-flow, the partials persist in \`.mason/partial-snapshots/\`; the next \`mason_init\` run can pick up where it left off.
- \`mason_init\` is idempotent — already-initialized projects return \`{ initialized: true, confluenceConfigured: ... }\`.
- The user can reconfigure Confluence later by asking their assistant to call \`mason_set_confluence\` directly.`;

export function setupPlaybook(): string {
  return SETUP_PLAYBOOK;
}
