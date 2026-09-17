import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readStoreJson, storePath, writeStoreJson } from "../utils/storage.js";

const leaseSchema = z.object({ pid: z.number().int().positive(), host: z.string() });

/** Called under the installation lock; uncertain ownership defers activation. */
export async function hasRunningMcp(home: string): Promise<boolean> {
  const directory = await storePath(home, "sessions");
  const files = await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  for (const name of files) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) return true;
    const relative = "sessions/" + name;
    try {
      const raw = await readStoreJson(home, relative);
      if (raw === null) continue;
      const lease = leaseSchema.parse(raw);
      if (lease.host !== os.hostname()) return true;
      try { process.kill(lease.pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true; }
      await fs.rm(await storePath(home, relative), { force: true });
    } catch { return true; }
  }
  return false;
}

export async function registerMcp(home: string): Promise<() => Promise<void>> {
  const name = `sessions/${randomUUID()}.json`;
  await writeStoreJson(home, name, { pid: process.pid, host: os.hostname() });
  return async () => { await fs.rm(await storePath(home, name), { force: true }).catch(() => {}); };
}
