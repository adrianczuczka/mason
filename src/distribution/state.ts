import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { z } from "zod";
import { readStoreJson } from "../utils/storage.js";
import { pathChangeSchema } from "./path.js";

export const releaseVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
const bundleId = z.string().regex(/^[a-f0-9]{24}$/);
export const updatePolicySchema = z.object({
  enabled: z.boolean(), revision: z.string(), pinnedVersion: releaseVersion.optional(), mirror: z.string().optional(),
});
export const recordSchema = z.object({
  format: z.literal(1), home: z.string(), bin: z.string(), current: bundleId, version: releaseVersion,
  launchers: z.record(z.string()), previousLaunchers: z.record(z.string()).optional(),
  pathChanges: z.array(pathChangeSchema).optional(), updates: updatePolicySchema.optional(),
  previous: z.object({ id: bundleId, version: releaseVersion }).optional(),
  pending: z.object({ id: bundleId, version: releaseVersion, policyRevision: z.string() }).optional(),
});
export type InstallRecord = z.infer<typeof recordSchema>;
export const defaultHome = () => process.env.MASON_HOME ?? (process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Mason") : path.join(os.homedir(), ".local/share/mason"));

export async function readInstallation(home: string): Promise<InstallRecord> {
  const raw = await readStoreJson(home, "install.json");
  if (!raw) throw new Error("Run this command from a standalone installation. npm users can upgrade with npm.");
  const record = recordSchema.parse(raw);
  if (record.home !== await fs.realpath(home)) throw new Error("Invalid standalone installation receipt.");
  return record;
}

export function standaloneLocation() {
  // Distribution modules are bundled into app/dist/mason.js (or mason-mcp.js).
  const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const home = path.dirname(path.dirname(bundle));
  if (path.dirname(bundle) !== path.join(home, "versions") || !/^[a-f0-9]{24}$/.test(path.basename(bundle))) {
    return null;
  }
  return { home, bundle };
}

export async function currentInstallation() {
  const location = standaloneLocation();
  if (!location) throw new Error("Run this command from a standalone installation. npm users can upgrade with npm.");
  const { home, bundle } = location;
  const record = await readInstallation(home);
  return { home, bundle, record };
}

export function automaticUpdatesAllowed(record: InstallRecord, env: NodeJS.ProcessEnv = process.env): boolean {
  return record.updates?.enabled === true && !record.updates.pinnedVersion && !record.updates.mirror
    && !env.CI && env.MASON_NO_AUTO_UPDATE !== "1" && !env.MASON_RELEASE_BASE && !env.MASON_VERSION;
}

/** Automatic updates accept stable releases only and never downgrade. */
export function newerStableVersion(candidate: string, installed: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(candidate)) return false;
  const a = candidate.split(".").map(BigInt), b = installed.split("-")[0].split(".").map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return installed.includes("-");
}
