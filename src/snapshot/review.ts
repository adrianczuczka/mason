import { createHash } from "node:crypto";
import { createFileAccess } from "../utils/files.js";
import { normalizeFeatureType, type FeatureEntry, type FlowEntry } from "./snapshot.js";

export type SnapshotEntryKind = "feature" | "flow";
export interface SnapshotVerdict {
  ok: boolean;
  note?: string;
  // Optional at the input boundary so older clients receive actionable feedback.
  kind?: SnapshotEntryKind;
  reviewToken?: string;
}

export const VERIFY_MAX_FILES_PER_ENTRY = 8;
const VERIFY_SKELETON_CHARS = 500;

/** Verification metadata and refresh timestamps do not change an entry's meaning. */
export function snapshotEntryContent(entry: FeatureEntry | FlowEntry) {
  return {
    description: entry.description,
    files: "files" in entry ? entry.files : undefined,
    chain: "chain" in entry ? entry.chain : undefined,
    tests: "files" in entry ? entry.tests : undefined,
    type: "files" in entry ? normalizeFeatureType(entry.type) : undefined,
  };
}

/** Bind the token to the exact bounded source reads used to produce the previews. */
export async function prepareSnapshotReview(
  access: Awaited<ReturnType<typeof createFileAccess>>,
  kind: SnapshotEntryKind,
  name: string,
  entry: FeatureEntry | FlowEntry,
) {
  const files = "files" in entry ? entry.files : entry.chain;
  const evidence: Array<{ path: string; hash: string | null }> = [];
  const skeletons: Array<{ path: string; content: string } | { path: string; missing: true }> = [];
  for (const file of files.slice(0, VERIFY_MAX_FILES_PER_ENTRY)) {
    const full = await access.read(file);
    evidence.push({ path: file, hash: full ? createHash("sha256").update(full.content).digest("hex") : null });
    skeletons.push(full ? { path: full.path, content: full.content.slice(0, VERIFY_SKELETON_CHARS) } : { path: file, missing: true });
  }
  const reviewToken = createHash("sha256").update(JSON.stringify({
    version: 1, kind, name, entry: snapshotEntryContent(entry), evidence,
  })).digest("hex");
  return { reviewToken, skeletons, truncated: files.length > VERIFY_MAX_FILES_PER_ENTRY };
}
