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
type FileAccess = Awaited<ReturnType<typeof createFileAccess>>;

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

type SourceEvidence = Array<{ path: string; hash: string | null }>;
const sourceHash = (content: string) => createHash("sha256").update(content).digest("hex");

function reviewToken(kind: SnapshotEntryKind, name: string, entry: FeatureEntry | FlowEntry, evidence: SourceEvidence) {
  return createHash("sha256").update(JSON.stringify({
    version: 1, kind, name, entry: snapshotEntryContent(entry), evidence,
  })).digest("hex");
}

/** Bind the token to the exact bounded source reads used to produce the previews. */
export async function prepareSnapshotReview(
  access: FileAccess,
  kind: SnapshotEntryKind,
  name: string,
  entry: FeatureEntry | FlowEntry,
) {
  const files = "files" in entry ? entry.files : entry.chain;
  const evidence: SourceEvidence = [];
  const skeletons: Array<{ path: string; content: string } | { path: string; missing: true }> = [];
  for (const file of files.slice(0, VERIFY_MAX_FILES_PER_ENTRY)) {
    const full = await access.read(file);
    evidence.push({ path: file, hash: full ? sourceHash(full.content) : null });
    skeletons.push(full ? { path: full.path, content: full.content.slice(0, VERIFY_SKELETON_CHARS) } : { path: file, missing: true });
  }
  return { reviewToken: reviewToken(kind, name, entry, evidence), skeletons, truncated: files.length > VERIFY_MAX_FILES_PER_ENTRY };
}

/** Cache only hashes/availability for one trust response, never source strings or previews. */
export function createSnapshotEvidenceReader(access: FileAccess) {
  const hashes = new Map<string, Promise<string | null>>();
  return async (kind: SnapshotEntryKind, name: string, entry: FeatureEntry | FlowEntry) => {
    const files = "files" in entry ? entry.files : entry.chain;
    const evidence: SourceEvidence = [];
    for (const file of files.slice(0, VERIFY_MAX_FILES_PER_ENTRY)) {
      let hash = hashes.get(file);
      if (!hash) {
        hash = access.read(file).then(full => full ? sourceHash(full.content) : null);
        hashes.set(file, hash);
      }
      evidence.push({ path: file, hash: await hash });
    }
    return {
      reviewToken: reviewToken(kind, name, entry, evidence),
      evidenceAvailable: evidence.length > 0 && evidence.every(file => file.hash !== null),
    };
  };
}
