import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readStoreJson, writeStoreJson, storePath, type StoreDiagnostic } from "../utils/storage.js";
import { sanitizeRepoPaths } from "../utils/paths.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { jaccard, tokenSet } from "../context/lexical.js";
import { attributionSchema, decisionSchema, decisionContent, decisionApproval, importLegacy, type DecisionSource, type DecisionRecord, type ReviewedDecisionRecord } from "./provenance.js";
export type { DecisionRecord } from "./provenance.js";

export type DecisionCategory =
  | "decision"
  | "gotcha"
  | "deprecation"
  | "convention";
export type DecisionStatus = "active" | "superseded" | "retired";

export const TITLE_MAX_CHARS = 80;
export const BODY_MAX_CHARS = 1500;
export const MAX_ACTIVE_DECISIONS = 150;

const DUPLICATE_JACCARD = 0.5;
const DUPLICATE_JACCARD_WITH_SHARED_FILE = 0.35;

export async function loadDecisionStore(rootDir: string): Promise<{ records: DecisionRecord[]; diagnostics: StoreDiagnostic[] }> {
  const records: DecisionRecord[] = [];
  const diagnostics: StoreDiagnostic[] = [];
  let entries: string[];
  try { entries = await fs.readdir(await storePath(rootDir, ".mason/decisions")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ path: ".mason/decisions", message: String(error) });
    return { records, diagnostics };
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const relative = `.mason/decisions/${entry}`;
    try {
      const record = decisionSchema.parse(await readStoreJson(rootDir, relative));
      if (entry !== `${record.id}.json`) throw new Error("Record id does not match its filename");
      records.push(record);
    } catch (error) { diagnostics.push({ path: relative, message: error instanceof Error ? error.message : String(error) }); }
  }
  return { records, diagnostics };
}

export async function loadDecisions(rootDir: string): Promise<DecisionRecord[]> {
  return (await loadDecisionStore(rootDir)).records;
}

export async function saveDecisionRecord(rootDir: string, record: DecisionRecord): Promise<void> {
  const validated = decisionSchema.parse(record);
  await writeStoreJson(rootDir, `.mason/decisions/${validated.id}.json`, validated);
}

/**
 * Deterministic, human-readable id: kebab slug of the title, ≤60 chars.
 * A slug collision with a DIFFERENT record appends a 6-hex content suffix.
 */
export function decisionIdFor(
  title: string,
  body: string,
  existingIds: Set<string>
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (!existingIds.has(slug)) return slug || "decision";
  const suffix = createHash("sha1")
    .update(title + body)
    .digest("hex")
    .slice(0, 6);
  return `${slug}-${suffix}`;
}

export function findNearDuplicate(
  candidate: { title: string; body: string; files: string[] },
  existing: DecisionRecord[]
): { record: DecisionRecord; similarity: number } | null {
  const candidateTokens = tokenSet(`${candidate.title} ${candidate.body}`);
  const candidateFiles = new Set(candidate.files);
  let best: { record: DecisionRecord; similarity: number } | null = null;

  for (const record of existing) {
    if (record.status !== "active") continue;
    const similarity = jaccard(
      candidateTokens,
      tokenSet(`${record.title} ${record.body}`)
    );
    const sharesFile = record.files.some((f) => candidateFiles.has(f));
    const threshold = sharesFile
      ? DUPLICATE_JACCARD_WITH_SHARED_FILE
      : DUPLICATE_JACCARD;
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { record, similarity };
    }
  }
  return best;
}

export interface UpsertDecisionInput {
  title: string;
  body: string;
  category: DecisionCategory;
  files?: string[];
  owner?: string | null;
  sources?: DecisionSource[];
  /** Only supply a known identity; never infer authorship from Git configuration. */
  actor?: string;
  /** Existing id to revise. Unchanged content is a no-op; use review_decision to reaffirm. */
  id?: string;
  /** Id of a decision this one replaces; the old record is kept, marked superseded. */
  supersedes?: string;
  /** Save even when a near-duplicate was detected. */
  force?: boolean;
}

export type UpsertDecisionResult =
  | {
      status: "created" | "updated" | "unchanged" | "superseded_and_created";
      id: string;
      totalActive: number;
      warnings: string[];
      approval?: "unreviewed" | "proposed" | "accepted";
      hint?: string;
      pruneCandidates?: string[];
    }
  | { status: "duplicate_suspected"; existing: DecisionRecord; hint: string }
  | { status: "error"; error: string };

/** Serialize tool writes so prepared reviews cannot overwrite another decision edit. */
export async function withDecisionWrite<T>(root: string, operation: () => Promise<T>): Promise<T | { status: "error"; error: string }> {
  const lockPath = await storePath(root, ".mason/decisions/.write-lock", true);
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "error", error: "Decision store is locked by another write. Retry after it finishes; an abandoned .mason/decisions/.write-lock must be removed only after confirming no writer is running." };
    throw error;
  }
  try { return await operation(); }
  finally { await lock.close(); await fs.unlink(lockPath); }
}

export async function upsertDecision(rootDir: string, input: UpsertDecisionInput): Promise<UpsertDecisionResult> {
  const title = input.title.trim(), body = input.body.trim();
  if (!title || !body) return { status: "error", error: "title and body must be non-empty" };
  if (title.length > TITLE_MAX_CHARS) return { status: "error", error: `title exceeds ${TITLE_MAX_CHARS} chars — tighten it to a specific headline` };
  if (body.length > BODY_MAX_CHARS) return { status: "error", error: `body exceeds ${BODY_MAX_CHARS} chars — record the decision, not the transcript` };
  const attribution = attributionSchema.safeParse(input);
  if (!attribution.success) return { status: "error", error: attribution.error.message };
  if (input.id && input.supersedes) return { status: "error", error: "Use either id to revise or supersedes to replace a record, not both." };
  return withDecisionWrite(rootDir, async () => {
    const store = await loadDecisionStore(rootDir);
    if (store.diagnostics.length) return { status: "error", error: "Repair malformed decision records before saving: " + store.diagnostics.map(d => d.path).join(", ") };
    const existing = store.records, byId = new Map(existing.map(r => [r.id, r]));
    const now = new Date().toISOString(), head = await getCurrentGitHash(rootDir);
    const warnings: string[] = [];
    const files = sanitizeRepoPaths(input.files ?? []);
    if (input.files && files.length < input.files.length) warnings.push("some anchor paths were outside the repo or duplicated and were dropped");
    for (const file of files) {
      try { await fs.access(path.join(rootDir, file)); }
      catch { warnings.push(`anchor file does not exist on disk: ${file}`); }
    }
    const hint = "Saved locally for review and commit. Proposals are not accepted constraints. Use review_decision to inspect evidence and record an authorized acceptance or reaffirmation.";
    if (input.id) {
      const original = byId.get(input.id);
      if (!original) return { status: "error", error: `no decision with id "${input.id}"` };
      if (original.status !== "active") return { status: "error", error: "Archived records cannot be revised; create a new proposal." };
      const record = importLegacy(original, now);
      const content = decisionContent({ ...record, title, body, category: input.category,
        files: input.files !== undefined ? files : record.files,
        owner: attribution.data.owner === undefined ? record.owner : attribution.data.owner ?? undefined,
        sources: attribution.data.sources ?? record.sources,
      });
      if (JSON.stringify(content) === JSON.stringify(decisionContent(record))) {
        return { status: "unchanged", id: record.id, totalActive: existing.filter(r => r.status === "active").length, approval: decisionApproval(original), warnings,
          hint: "Unchanged content; no review or freshness stamp was written. Use review_decision for explicit re-verification." };
      }
      const revision = record.revision + 1;
      const updated: ReviewedDecisionRecord = { ...record, ...content, owner: content.owner, updatedAt: now, revision, approval: "proposed",
        history: [...record.history, { kind: "revised", at: now, actor: attribution.data.actor, revision, content, approval: "proposed", status: "active", refreshedHash: record.refreshedHash }],
      };
      await saveDecisionRecord(rootDir, updated);
      return { status: "updated", id: record.id, totalActive: existing.filter(r => r.status === "active").length, approval: "proposed", warnings, hint };
    }
    const old = input.supersedes ? byId.get(input.supersedes) : undefined;
    if (input.supersedes && !old) return { status: "error", error: `no decision with id "${input.supersedes}" to supersede` };
    if (old && (old.status !== "active" || decisionApproval(old) === "accepted")) {
      return { status: "error", error: "A proposal cannot supersede an accepted or archived record. Create and review the replacement separately, then explicitly retire the old decision with review_decision." };
    }
    if (!input.force) {
      const duplicate = findNearDuplicate({ title, body, files }, existing);
      if (duplicate) return { status: "duplicate_suspected", existing: duplicate.record, hint: `A similar decision exists ("${duplicate.record.title}"). Call save_decision with id="${duplicate.record.id}" to revise it, or force:true if distinct.` };
    }
    const id = decisionIdFor(title, body, new Set(byId.keys()));
    if (byId.has(id)) return { status: "error", error: `Decision id collision: ${id}. Choose a distinct title or revise the existing record.` };
    const content = decisionContent({ title, body, category: input.category, files, owner: attribution.data.owner ?? undefined, sources: attribution.data.sources ?? [] });
    const record: ReviewedDecisionRecord = { ...content, version: 2, id, createdAt: now, updatedAt: now, refreshedHash: head,
      status: "active", approval: "proposed", revision: 1,
      history: [{ kind: "created", at: now, actor: attribution.data.actor, revision: 1, content, approval: "proposed", status: "active", refreshedHash: head }],
    };
    // Write the replacement first: a failed second write leaves both records
    // available instead of removing the original before its replacement exists.
    await saveDecisionRecord(rootDir, record);
    if (old) {
      const imported = importLegacy(old, now);
      await saveDecisionRecord(rootDir, { ...imported, status: "superseded", supersededBy: id, updatedAt: now,
        history: [...imported.history, { kind: "superseded", at: now, actor: attribution.data.actor, note: `Replaced by proposal ${id}`,
          revision: imported.revision, content: decisionContent(imported), approval: imported.approval, status: "superseded", refreshedHash: imported.refreshedHash }],
      });
    }
    const totalActive = existing.filter(r => r.status === "active").length + (old ? 0 : 1);
    const result: UpsertDecisionResult = { status: old ? "superseded_and_created" : "created", id, totalActive, approval: "proposed", warnings, hint };
    if (totalActive > MAX_ACTIVE_DECISIONS) {
      result.pruneCandidates = existing.filter(r => r.status !== "active").map(r => r.id).slice(0, 10);
      warnings.push(`${totalActive} active decisions exceeds the soft cap of ${MAX_ACTIVE_DECISIONS} — consider a cleanup PR (archived records first)`);
    }
    return result;
  });
}
