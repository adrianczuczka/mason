import { verifySnapshot } from "../src/mcp/tools.js";
import type { SnapshotVerdict } from "../src/snapshot/review.js";

/** Prepare real evidence before recording test verdicts through the public API. */
export async function prepareVerdicts(repo: string, verdicts: Record<string, { ok: boolean; note?: string; kind?: "feature" | "flow" }>): Promise<Record<string, SnapshotVerdict>> {
  const { entries } = JSON.parse(await verifySnapshot(repo, 1000));
  return Object.fromEntries(Object.entries(verdicts).map(([name, verdict]) => {
    const entry = entries.find((e: { name: string; kind: string }) => e.name === name && (!verdict.kind || e.kind === verdict.kind));
    return [name, { ...verdict, kind: entry?.kind ?? "feature", reviewToken: entry?.reviewToken ?? "0".repeat(64) }];
  }));
}
