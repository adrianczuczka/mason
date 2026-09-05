import fs from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { storePath } from "../utils/storage.js";

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
});
export type State = z.infer<typeof stateSchema>;

/** Cross-process lock: a killed writer's lock is reclaimed only after its local PID is gone. */
export async function withLock<T>(root: string, directory: string, run: () => Promise<T>): Promise<T> {
  const file = await storePath(root, directory + "/lock", true);
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname() }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Do not steal malformed, remote, or live locks on a time-based guess.
      try {
        const owner = JSON.parse(await fs.readFile(file, "utf8"));
        if (owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
              // Renaming a stale lock arbitrates reclamation without unlinking a new writer's lock.
              const reclaim = file + ".reclaim";
              let guard;
              try {
                guard = await fs.open(reclaim, "wx", 0o600);
                const current = JSON.parse(await fs.readFile(file, "utf8"));
                if (current.pid === owner.pid && current.host === owner.host) await fs.unlink(file);
              } finally { if (guard) { await guard.close(); await fs.rm(reclaim, { force: true }); } }
            }
          }
        }
      } catch { /* Another writer may be creating/releasing/reclaiming it. */ }
      if (Date.now() >= deadline) throw new Error("Automation is busy or its lock needs inspection: " + file);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  try { return await run(); }
  finally { await handle.close(); await fs.unlink(file); }
}
