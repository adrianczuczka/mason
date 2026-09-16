import fs from "node:fs/promises";
import os from "node:os";
import { storePath } from "./storage.js";

/** Cross-process lock: a killed writer's lock is reclaimed only after its local PID is gone. */
export async function withStoreLock<T>(root: string, directory: string, run: () => Promise<T>, waitMs = 5000, label = "Mason store"): Promise<T> {
  const file = await storePath(root, directory + "/lock", true);
  const deadline = Date.now() + waitMs;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname() })); }
      catch (error) {
        await handle.close().catch(() => {});
        handle = undefined;
        await fs.rm(file, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Do not steal malformed, remote, or live locks on a time-based guess.
      try {
        const owner = JSON.parse(await fs.readFile(file, "utf8"));
        if (owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
              // A separate guard arbitrates reclamation; recheck the owner before unlinking.
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
      if (Date.now() >= deadline) throw new Error(label + " is busy or its lock needs inspection: " + file);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  try { return await run(); }
  finally { await handle.close(); await fs.unlink(file); }
}
