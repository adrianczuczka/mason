import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { jaccard, tokenSet } from "../context/lexical.js";

export type DecisionCategory =
  | "decision"
  | "gotcha"
  | "deprecation"
  | "convention";
export type DecisionStatus = "active" | "superseded";

/**
 * One unit of team knowledge the code alone can't express: a failed
 * approach, a deprecation, a workaround's reason, a review-settled
 * convention. Stored one file per record under .mason/decisions/ so
 * concurrent additions on different branches merge without conflict,
 * while concurrent edits to the SAME record conflict — contested
 * knowledge should reach a human.
 */
export interface DecisionRecord {
  version: 1;
  id: string;
  title: string;
  body: string;
  category: DecisionCategory;
  /** Repo-relative anchor files. Empty means pure prose — never goes stale. */
  files: string[];
  createdAt: string;
  updatedAt: string;
  /** Commit this record was last verified against. */
  refreshedHash: string;
  status: DecisionStatus;
  supersededBy?: string;
}

export const TITLE_MAX_CHARS = 80;
export const BODY_MAX_CHARS = 1500;
export const MAX_ACTIVE_DECISIONS = 150;

const DUPLICATE_JACCARD = 0.5;
const DUPLICATE_JACCARD_WITH_SHARED_FILE = 0.35;

function decisionsDir(rootDir: string): string {
  return path.join(rootDir, ".mason", "decisions");
}

export async function loadDecisions(
  rootDir: string
): Promise<DecisionRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(decisionsDir(rootDir));
  } catch {
    return [];
  }
  const records: DecisionRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(
        path.join(decisionsDir(rootDir), entry),
        "utf-8"
      );
      const parsed = JSON.parse(raw);
      // Skip unknown versions and malformed records individually — one bad
      // merge artifact must not take down the store.
      if (parsed.version !== 1 || !parsed.id || !parsed.title || !parsed.body) {
        continue;
      }
      records.push(parsed);
    } catch {
      continue;
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

export async function saveDecisionRecord(
  rootDir: string,
  record: DecisionRecord
): Promise<void> {
  await fs.mkdir(decisionsDir(rootDir), { recursive: true });
  await fs.writeFile(
    path.join(decisionsDir(rootDir), `${record.id}.json`),
    JSON.stringify(record, null, 2) + "\n",
    "utf-8"
  );
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

function sanitizeAnchorFiles(rootDir: string, files: string[]): string[] {
  const resolvedRoot = path.resolve(rootDir);
  return files.filter((f) => {
    const resolved = path.resolve(resolvedRoot, f);
    return (
      resolved.startsWith(resolvedRoot) &&
      !f.startsWith("/") &&
      !f.includes("..")
    );
  });
}

export interface UpsertDecisionInput {
  title: string;
  body: string;
  category: DecisionCategory;
  files?: string[];
  /** Existing id to update. Same id + unchanged content = re-verify (re-pin to HEAD). */
  id?: string;
  /** Id of a decision this one replaces; the old record is kept, marked superseded. */
  supersedes?: string;
  /** Save even when a near-duplicate was detected. */
  force?: boolean;
}

export type UpsertDecisionResult =
  | {
      status: "created" | "updated" | "reverified" | "superseded_and_created";
      id: string;
      totalActive: number;
      warnings: string[];
      pruneCandidates?: string[];
    }
  | { status: "duplicate_suspected"; existing: DecisionRecord; hint: string }
  | { status: "error"; error: string };

export async function upsertDecision(
  rootDir: string,
  input: UpsertDecisionInput
): Promise<UpsertDecisionResult> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length === 0 || body.length === 0) {
    return { status: "error", error: "title and body must be non-empty" };
  }
  if (title.length > TITLE_MAX_CHARS) {
    return {
      status: "error",
      error: `title exceeds ${TITLE_MAX_CHARS} chars — tighten it to a specific headline`,
    };
  }
  if (body.length > BODY_MAX_CHARS) {
    return {
      status: "error",
      error: `body exceeds ${BODY_MAX_CHARS} chars — record the decision, not the transcript`,
    };
  }

  const existing = await loadDecisions(rootDir);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const now = new Date().toISOString();
  const head = await getCurrentGitHash(rootDir);
  const warnings: string[] = [];

  const files = sanitizeAnchorFiles(rootDir, input.files ?? []);
  if (input.files && files.length < input.files.length) {
    warnings.push("some anchor paths were outside the repo and were dropped");
  }
  // Nonexistent anchors warn but save — a deprecation note may outlive its file.
  for (const f of files) {
    try {
      await fs.access(path.join(rootDir, f));
    } catch {
      warnings.push(`anchor file does not exist on disk: ${f}`);
    }
  }

  // Update / re-verify path
  if (input.id) {
    const record = byId.get(input.id);
    if (!record) {
      return { status: "error", error: `no decision with id "${input.id}"` };
    }
    const unchanged =
      record.title === title &&
      record.body === body &&
      record.category === input.category &&
      JSON.stringify(record.files) === JSON.stringify(files.length > 0 ? files : record.files);
    const updated: DecisionRecord = {
      ...record,
      title,
      body,
      category: input.category,
      files: input.files !== undefined ? files : record.files,
      updatedAt: now,
      refreshedHash: head,
    };
    await saveDecisionRecord(rootDir, updated);
    return {
      status: unchanged ? "reverified" : "updated",
      id: record.id,
      totalActive: existing.filter((r) => r.status === "active").length,
      warnings,
    };
  }

  // Create path — dedupe first
  if (!input.force) {
    const duplicate = findNearDuplicate({ title, body, files }, existing);
    if (duplicate) {
      return {
        status: "duplicate_suspected",
        existing: duplicate.record,
        hint: `A similar decision exists ("${duplicate.record.title}"). Call save_decision with id="${duplicate.record.id}" to update/merge into it, or force:true if genuinely distinct.`,
      };
    }
  }

  // Supersede
  if (input.supersedes) {
    const old = byId.get(input.supersedes);
    if (!old) {
      return {
        status: "error",
        error: `no decision with id "${input.supersedes}" to supersede`,
      };
    }
    const id = decisionIdFor(title, body, new Set(byId.keys()));
    await saveDecisionRecord(rootDir, {
      ...old,
      status: "superseded",
      supersededBy: id,
      updatedAt: now,
    });
    const record: DecisionRecord = {
      version: 1,
      id,
      title,
      body,
      category: input.category,
      files,
      createdAt: now,
      updatedAt: now,
      refreshedHash: head,
      status: "active",
    };
    await saveDecisionRecord(rootDir, record);
    return {
      status: "superseded_and_created",
      id,
      totalActive: existing.filter((r) => r.status === "active").length,
      warnings,
    };
  }

  const id = decisionIdFor(title, body, new Set(byId.keys()));
  const record: DecisionRecord = {
    version: 1,
    id,
    title,
    body,
    category: input.category,
    files,
    createdAt: now,
    updatedAt: now,
    refreshedHash: head,
    status: "active",
  };
  await saveDecisionRecord(rootDir, record);

  const totalActive =
    existing.filter((r) => r.status === "active").length + 1;
  const result: UpsertDecisionResult = {
    status: "created",
    id,
    totalActive,
    warnings,
  };
  if (totalActive > MAX_ACTIVE_DECISIONS) {
    // Never auto-evict git-committed team knowledge — surface candidates
    // for a human cleanup PR instead.
    result.pruneCandidates = existing
      .filter((r) => r.status === "superseded")
      .map((r) => r.id)
      .slice(0, 10);
    warnings.push(
      `${totalActive} active decisions exceeds the soft cap of ${MAX_ACTIVE_DECISIONS} — consider a cleanup PR (superseded records first)`
    );
  }
  return result;
}
