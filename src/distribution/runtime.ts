import fs from "node:fs/promises";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withLock } from "../automation/store.js";
import { readStoreJson, storePath, writeStoreJson } from "../utils/storage.js";
import { readInstallation, standaloneLocation } from "./state.js";
import { verifyBundle } from "./bundle.js";

const leaseSchema = z.object({ pid: z.number().int().positive(), host: z.string(), bundle: z.string().regex(/^[a-f0-9]{24}$/) });

/** Every standalone entry point registers before executing application code. */
export async function registerRuntime() {
  const location = standaloneLocation();
  if (!location) return;
  const { home, bundle } = location;
  const name = `runtimes/${randomUUID()}.json`;
  await withLock(home, ".install-lock", async () => {
    await readInstallation(home);
    await fs.access(bundle);
    await writeStoreJson(home, name, { pid: process.pid, host: os.hostname(), bundle: path.basename(bundle) });
  });
  const file = await storePath(home, name);
  process.once("exit", () => { try { unlinkSync(file); } catch { /* Stale leases are recovered by the next worker. */ } });
}

/** Caller holds the update lock, before staging starts; startup shares the install lock. */
export async function pruneUnusedVersions(home: string) {
  await withLock(home, ".install-lock", async () => {
    const record = await readInstallation(home);
    const keep = new Set([record.current, record.previous?.id, record.pending?.id]);
    const directory = await storePath(home, "runtimes");
    const leases = await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of leases) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) return;
      try {
        const raw = await readStoreJson(home, `runtimes/${name}`);
        if (raw === null) continue;
        const lease = leaseSchema.parse(raw);
        if (lease.host !== os.hostname()) return;
        try { process.kill(lease.pid, 0); keep.add(lease.bundle); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
          await fs.rm(await storePath(home, `runtimes/${name}`), { force: true });
        }
      } catch { return; } // Uncertain process ownership means no deletion.
    }
    const versions = await storePath(home, "versions");
    for (const id of await fs.readdir(versions)) {
      if (!/^[a-f0-9]{24}$/.test(id) || keep.has(id)) continue;
      try {
        const directory = await storePath(home, `versions/${id}`);
        const bundle = await verifyBundle(directory);
        // Older releases do not register all running commands. Preserve those,
        // and any edited or unrecognized directory whose ownership is uncertain.
        if (bundle.manifestHash.slice(0, 24) !== id || !bundle.manifest.files["app/dist/mason-runtime.js"]) continue;
        await fs.rm(directory, { recursive: true });
      } catch { /* Busy files (including Windows executables) are retained for another check. */ }
    }
  });
}
