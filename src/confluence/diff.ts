import fs from "node:fs/promises";
import path from "node:path";
import type { Snapshot } from "../snapshot/snapshot.js";
import type { DiffSection } from "./renderer.js";

export interface SyncState {
  version: 1;
  syncedAt: string;
  pageIds: {
    index?: string;
    changelog?: string;
    features: Record<string, string>;
  };
  lastSnapshot: {
    features: Record<string, { description: string }>;
    flows: Record<string, { description: string }>;
  };
  changelogSections: string[];
}

function syncStateDir(rootDir: string): string {
  return path.join(rootDir, ".mason");
}

function syncStatePath(rootDir: string): string {
  return path.join(syncStateDir(rootDir), "confluence-sync.json");
}

export async function loadSyncState(rootDir: string): Promise<SyncState | null> {
  try {
    const raw = await fs.readFile(syncStatePath(rootDir), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSyncState(
  rootDir: string,
  state: SyncState
): Promise<void> {
  await fs.mkdir(syncStateDir(rootDir), { recursive: true });
  await fs.writeFile(
    syncStatePath(rootDir),
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

export function computeDiff(
  previous: SyncState | null,
  current: Snapshot,
  syncedAt: string
): DiffSection {
  const prevFeatures = previous?.lastSnapshot.features ?? {};
  const prevFlows = previous?.lastSnapshot.flows ?? {};

  const currentFeatureNames = Object.keys(current.features);
  const prevFeatureNames = Object.keys(prevFeatures);

  const addedFeatures = currentFeatureNames.filter(
    (n) => !(n in prevFeatures)
  );
  const removedFeatures = prevFeatureNames.filter(
    (n) => !(n in current.features)
  );
  const changedFeatures = currentFeatureNames.filter(
    (n) =>
      n in prevFeatures &&
      prevFeatures[n].description !== current.features[n].description
  );

  const currentFlowNames = Object.keys(current.flows);
  const prevFlowNames = Object.keys(prevFlows);
  const addedFlows = currentFlowNames.filter((n) => !(n in prevFlows));
  const removedFlows = prevFlowNames.filter((n) => !(n in current.flows));

  return {
    syncedAt,
    addedFeatures,
    removedFeatures,
    changedFeatures,
    addedFlows,
    removedFlows,
  };
}

export function isMeaningfulDiff(diff: DiffSection): boolean {
  return (
    diff.addedFeatures.length > 0 ||
    diff.removedFeatures.length > 0 ||
    diff.changedFeatures.length > 0 ||
    diff.addedFlows.length > 0 ||
    diff.removedFlows.length > 0
  );
}

export function snapshotMinimal(snapshot: Snapshot): SyncState["lastSnapshot"] {
  const features: Record<string, { description: string }> = {};
  for (const [k, v] of Object.entries(snapshot.features)) {
    features[k] = { description: v.description };
  }
  const flows: Record<string, { description: string }> = {};
  for (const [k, v] of Object.entries(snapshot.flows)) {
    flows[k] = { description: v.description };
  }
  return { features, flows };
}
