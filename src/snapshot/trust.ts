import { assessTrust, type Freshness, type TrustState } from "../context/trust.js";
import { createFileAccess } from "../utils/files.js";
import { createSnapshotEvidenceReader, type SnapshotEntryKind } from "./review.js";
import type { FeatureEntry, FlowEntry, Snapshot } from "./snapshot.js";
import type { DriftReport } from "../drift/drift.js";

/** Recheck reviewed evidence for one retrieval; never persist or reuse it across calls. */
export function createSnapshotTrustReader(root: string) {
  // Share the file policy/inventory, and initialize only for token-bearing verdicts.
  let reader: Promise<ReturnType<typeof createSnapshotEvidenceReader> | null> | undefined;
  return async (kind: SnapshotEntryKind, name: string, entry: FeatureEntry | FlowEntry, freshness: Freshness): Promise<TrustState> => {
    const trust = assessTrust(entry, freshness);
    const verdict = entry.verificationFailed ? "failed" : entry.verifiedAt ? "passed" : undefined;
    if (!verdict) return trust;
    trust.recordedVerdict = verdict;
    const unknown = (reason: string) => {
      trust.verification = "unknown";
      trust.reasons.push(reason);
      return trust;
    };
    if (!entry.verificationToken || !/^[a-f0-9]{64}$/.test(entry.verificationToken)) return unknown("The recorded verdict has no supported evidence token; obtain a fresh verify_snapshot review.");
    try {
      reader ??= createFileAccess(root).then(createSnapshotEvidenceReader).catch(() => null);
      const readReview = await reader;
      if (!readReview) return unknown("Verification source evidence could not be read under the current file policy.");
      const review = await readReview(kind, name, entry);
      if (!review.evidenceAvailable) {
        return unknown("Verification source evidence is missing, excluded, unreadable, or empty; the recorded verdict cannot be confirmed.");
      }
      if (review.reviewToken !== entry.verificationToken) {
        trust.verification = "stale";
        trust.reasons.push("The entry or sampled source contents differ from the recorded verification evidence; obtain a fresh review.");
      }
      return trust;
    } catch {
      return unknown("Verification source evidence could not be read under the current file policy.");
    }
  };
}

/** Walk the catalog sequentially to keep source reads bounded on large maps. */
export async function readSnapshotTrustIndex(readTrust: ReturnType<typeof createSnapshotTrustReader>, snapshot: Snapshot, drift: DriftReport | null) {
  const features: Record<string, TrustState> = Object.create(null), flows: Record<string, TrustState> = Object.create(null);
  for (const [name, entry] of Object.entries(snapshot.features)) {
    features[name] = await readTrust("feature", name, entry, drift?.featureFreshness?.[name] ?? "unknown");
  }
  for (const [name, entry] of Object.entries(snapshot.flows)) {
    flows[name] = await readTrust("flow", name, entry, drift?.flowFreshness?.[name] ?? "unknown");
  }
  return { features, flows };
}
