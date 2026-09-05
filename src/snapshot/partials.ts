import fs from "node:fs/promises";
import { z } from "zod";
import { readStoreJson, writeStoreJson, storePath } from "../utils/storage.js";
import { featureSchema, flowSchema } from "./snapshot.js";
import type { FeatureEntry, FlowEntry } from "./snapshot.js";

export interface Partial {
  batchId: string;
  offset: number;
  features: Record<string, FeatureEntry>;
  flows: Record<string, FlowEntry>;
  savedAt: string;
}

const DIRECTORY = ".mason/partial-snapshots";
const partialSchema = z.object({
  batchId: z.string().regex(/^[a-zA-Z0-9_-]+$/), offset: z.number().int().nonnegative(),
  features: z.record(featureSchema), flows: z.record(flowSchema), savedAt: z.string(),
});
const scopeSchema = z.object({ files: z.array(z.string()), savedAt: z.string() });

export async function savePartial(rootDir: string, partial: Partial): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(partial.batchId)) throw new Error(`Invalid batchId: ${partial.batchId}`);
  await writeStoreJson(rootDir, `${DIRECTORY}/${partial.batchId}.json`, partialSchema.parse(partial));
}

export async function loadAllPartials(rootDir: string): Promise<Partial[]> {
  let entries: string[];
  try { entries = await fs.readdir(await storePath(rootDir, DIRECTORY)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const partials: Partial[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "scope.json") continue;
    const partial = partialSchema.parse(await readStoreJson(rootDir, `${DIRECTORY}/${entry}`));
    if (entry !== `${partial.batchId}.json`) throw new Error(`Invalid partial filename: ${entry}`);
    partials.push(partial);
  }
  return partials.sort((a, b) => a.offset - b.offset);
}

export async function saveScope(rootDir: string, files: string[]): Promise<void> {
  await writeStoreJson(rootDir, `${DIRECTORY}/scope.json`, { files, savedAt: new Date().toISOString() });
}

export async function loadScope(rootDir: string): Promise<string[] | null> {
  const raw = await readStoreJson(rootDir, `${DIRECTORY}/scope.json`);
  return raw === null ? null : scopeSchema.parse(raw).files;
}

export async function clearScope(rootDir: string): Promise<void> {
  await fs.rm(await storePath(rootDir, `${DIRECTORY}/scope.json`), { force: true });
}

export async function clearAllPartials(rootDir: string): Promise<void> {
  await fs.rm(await storePath(rootDir, DIRECTORY), { recursive: true, force: true });
}

export function batchIdFor(offset: number): string {
  return `batch-${String(offset).padStart(6, "0")}`;
}
