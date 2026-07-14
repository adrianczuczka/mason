import fs from "node:fs/promises";
import path from "node:path";
import type { FeatureEntry, FlowEntry } from "./snapshot.js";

export interface Partial {
  batchId: string;
  offset: number;
  features: Record<string, FeatureEntry>;
  flows: Record<string, FlowEntry>;
  savedAt: string;
}

function partialsDir(rootDir: string): string {
  return path.join(rootDir, ".mason", "partial-snapshots");
}

function partialPath(rootDir: string, batchId: string): string {
  return path.join(partialsDir(rootDir), `${batchId}.json`);
}

function isSafeBatchId(batchId: string): boolean {
  // batchIds are server-issued; defensively reject anything that could escape
  return /^[a-zA-Z0-9_-]+$/.test(batchId);
}

export async function savePartial(
  rootDir: string,
  partial: Partial
): Promise<void> {
  if (!isSafeBatchId(partial.batchId)) {
    throw new Error(`Invalid batchId: ${partial.batchId}`);
  }
  await fs.mkdir(partialsDir(rootDir), { recursive: true });
  await fs.writeFile(
    partialPath(rootDir, partial.batchId),
    JSON.stringify(partial, null, 2),
    "utf-8"
  );
}

export async function loadAllPartials(rootDir: string): Promise<Partial[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(partialsDir(rootDir));
  } catch {
    return [];
  }

  const partials: Partial[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(
        path.join(partialsDir(rootDir), entry),
        "utf-8"
      );
      const parsed = JSON.parse(raw) as Partial;
      if (parsed && parsed.batchId && parsed.features && parsed.flows) {
        partials.push(parsed);
      }
    } catch {
      // Skip unreadable / malformed partials
    }
  }

  partials.sort((a, b) => a.offset - b.offset);
  return partials;
}

// A scope marker records that the current partials come from a scoped
// refresh (drift repair) rather than a full Map-Reduce build. It lives in the
// partials directory so clearAllPartials removes it with the partials;
// loadAllPartials skips it because it has no batchId/features/flows.
function scopePath(rootDir: string): string {
  return path.join(partialsDir(rootDir), "scope.json");
}

export async function saveScope(
  rootDir: string,
  files: string[]
): Promise<void> {
  await fs.mkdir(partialsDir(rootDir), { recursive: true });
  await fs.writeFile(
    scopePath(rootDir),
    JSON.stringify({ files, savedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
}

export async function loadScope(rootDir: string): Promise<string[] | null> {
  try {
    const raw = await fs.readFile(scopePath(rootDir), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.files)) return parsed.files;
    return null;
  } catch {
    return null;
  }
}

export async function clearScope(rootDir: string): Promise<void> {
  await fs.rm(scopePath(rootDir), { force: true });
}

export async function clearAllPartials(rootDir: string): Promise<void> {
  try {
    await fs.rm(partialsDir(rootDir), { recursive: true, force: true });
  } catch {
    // No partials to clear — fine
  }
}

export function batchIdFor(offset: number): string {
  return `batch-${String(offset).padStart(6, "0")}`;
}
