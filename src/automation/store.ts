import { z } from "zod";
import { withStoreLock } from "../utils/store-lock.js";

export const hostSchema = z.enum(["claude", "codex"]);
export type Host = z.infer<typeof hostSchema>;
export const events = ["session_start", "turn_start", "before_tool", "after_tool", "task_end"] as const;
export type Event = typeof events[number];
export const stateSchema = z.object({
  version: z.literal(1), root: z.string(), gitDir: z.string(), branch: z.string(),
  baselines: z.array(z.object({ path: z.string(), at: z.string(), event: z.string(), fingerprint: z.string() })).max(128),
  sessions: z.record(z.object({
    host: hostSchema, seen: z.string().nullable(), continued: z.boolean(),
    initialIssues: z.array(z.string()), initialDocs: z.record(z.string().nullable()),
    lastUsed: z.string(), mutationObserved: z.boolean(),
    pending: z.record(z.string()), coverageGaps: z.array(z.string()),
    events: z.record(z.object({ at: z.string(), count: z.number().int().positive() })),
  })),
  updatedAt: z.string(), fingerprint: z.string().nullable(),
  latest: z.string().nullable(),
  analysis: z.object({ id: z.string(), fingerprint: z.string(), completedAt: z.number(), path: z.string() }).optional(),
});
export type State = z.infer<typeof stateSchema>;
export function parseState(raw: unknown): State {
  try { return stateSchema.parse(raw); }
  catch (error) { throw new Error("Invalid automation state; original evidence was retained.", { cause: error }); }
}

/** Preserve the automation lock location and diagnostics for existing callers. */
export function withLock<T>(root: string, directory: string, run: () => Promise<T>, waitMs = 5000): Promise<T> {
  return withStoreLock(root, directory, run, waitMs, "Automation");
}
