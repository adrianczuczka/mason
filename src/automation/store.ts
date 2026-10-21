import { z } from "zod";
import { withStoreLock } from "../utils/store-lock.js";
import { stopReviewSchema } from "./stop-review.js";
import { notificationStateSchema } from "./notifications.js";
import { STORE_MAX_BYTES } from "../utils/storage.js";

export const hostSchema = z.enum(["claude", "codex"]);
export type Host = z.infer<typeof hostSchema>;
export const events = [
  "session_start",
  "turn_start",
  "before_tool",
  "after_tool",
  "task_end",
] as const;
export type Event = (typeof events)[number];
export const stateSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  gitDir: z.string(),
  branch: z.string(),
  baselines: z
    .array(
      z.object({ path: z.string(), at: z.string(), event: z.string(), fingerprint: z.string() }),
    )
    .max(128),
  sessions: z.record(
    z.object({
      host: hostSchema,
      lastUsed: z.string(),
      notifiedDiagnostics: z.array(z.string()).default([]),
      /** Digest of the upstream drift notice already shown to this session. */
      upstreamNotice: z.string().optional(),
      pending: z.record(z.string()),
      stopReview: stopReviewSchema.optional(),
      coverageGaps: z.array(z.string()),
      events: z.record(z.object({ at: z.string(), count: z.number().int().positive() })),
    }),
  ),
  updatedAt: z.string(),
  fingerprint: z.string().nullable(),
  latest: z.string().nullable(),
  guidance: z.object({ fingerprint: z.string(), path: z.string() }).optional(),
  notifications: notificationStateSchema.optional(),
  agentNotifications: notificationStateSchema.optional(),
  analysis: z
    .object({ id: z.string(), fingerprint: z.string(), completedAt: z.number(), path: z.string() })
    .optional(),
});
export type State = z.infer<typeof stateSchema>;
export function parseState(raw: unknown): State {
  try {
    return stateSchema.parse(raw);
  } catch (error) {
    throw new Error("Invalid automation state; original evidence was retained.", { cause: error });
  }
}

/** Sessions kept when a new one arrives; the least recently used beyond this are evicted. */
export const SESSION_LIMIT = 32;
const IDLE_PENDING_MS = 24 * 60 * 60 * 1000;
/** Oversized stores are read so they can be shrunk instead of failing every hook. */
export const STATE_READ_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Unfinished tool calls never outlive their turn: a denied or interrupted call (and a failed
 * one on hosts without a failure hook) never reports completion. Dropping the entry loses no
 * evidence; a later post-tool event without it records a coverage gap.
 */
export function clearPendingTools(session: State["sessions"][string]) {
  session.pending = {};
  if (session.stopReview) session.stopReview.pending = {};
}

/** Expire leaked tool calls from idle sessions and evict least recently used sessions, never
 * the active one. Unfinished calls do not protect a session: a stale capture is worth less than
 * automation for every new session. */
export function pruneSessions(
  state: State,
  now: Date,
  active: string | null,
  limit = SESSION_LIMIT,
) {
  for (const session of Object.values(state.sessions))
    if (now.getTime() - Date.parse(session.lastUsed) > IDLE_PENDING_MS) clearPendingTools(session);
  const evictable = Object.keys(state.sessions)
    .filter((key) => key !== active)
    .sort((a, b) => state.sessions[a].lastUsed.localeCompare(state.sessions[b].lastUsed));
  const excess = Object.keys(state.sessions).length - limit;
  for (const key of evictable.slice(0, Math.max(0, excess))) delete state.sessions[key];
}

/** Compact JSON within the store limit, evicting idle sessions rather than failing every hook. */
export function serializeState(state: State, active: string | null) {
  let payload = JSON.stringify(state) + "\n";
  while (Buffer.byteLength(payload) > STORE_MAX_BYTES) {
    const before = Object.keys(state.sessions).length;
    pruneSessions(state, new Date(), active, before - 1);
    if (Object.keys(state.sessions).length === before)
      throw new Error(
        "Mason automation state exceeds 10 MiB after evicting every other session; inspect the active session in .mason/reports/automation/<id>/state.json. Original evidence was retained.",
      );
    payload = JSON.stringify(state) + "\n";
  }
  return state;
}

/** Preserve the automation lock location and diagnostics for existing callers. */
export function withLock<T>(
  root: string,
  directory: string,
  run: () => Promise<T>,
  waitMs = 5000,
): Promise<T> {
  return withStoreLock(root, directory, run, waitMs, "Automation");
}
