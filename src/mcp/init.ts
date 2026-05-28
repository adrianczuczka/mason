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
Run the sections below in order. Surface each question to the user in plain language and wait for their answer before proceeding.

SECTION 1 — concept map (required)
Tell the user: "Mason will build a concept map of this codebase — a feature-to-file index that lives in .mason/snapshot.json and survives across sessions. This takes ~30 seconds and uses your assistant's existing context (no API key needed). Proceed?"
On yes: call \`generate_snapshot\` to receive sampled files + the system prompt, derive features and flows yourself, then call \`save_snapshot\` to persist them.
On no: skip — but mention that other Mason tools won't work until a snapshot exists.

SECTION 2 — finish
Call \`mason_complete_init\` with \`{ dir }\` to mark the project as initialized.
Confirm to the user that setup is complete and they can now ask architectural questions, request impact analysis, etc.

Notes:
- All Mason write tools refuse to run until \`mason_complete_init\` has been called. Do not skip section 2.
- The user can re-run \`mason_init\` later if they want to reconfigure (it's idempotent — already-initialized projects return \`{ initialized: true }\`).`;

export function setupPlaybook(): string {
  return SETUP_PLAYBOOK;
}
