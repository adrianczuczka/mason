export type Freshness = "current" | "changed" | "unknown";
export interface TrustState {
  freshness: Freshness;
  verification: "unverified" | "passed" | "failed";
  verifiedAt?: string;
  verifiedHash?: string;
  reasons: string[];
}

export function assessTrust(entry: { verifiedAt?: string; verifiedHash?: string; verificationFailed?: boolean; verificationNote?: string }, freshness: Freshness): TrustState {
  const verification = entry.verificationFailed ? "failed" : entry.verifiedAt ? "passed" : "unverified";
  const reasons: string[] = [];
  if (freshness === "unknown") reasons.push("Anchors, history, or working-tree evidence are unavailable; verify before relying on this entry.");
  if (freshness === "changed") reasons.push("Anchored files changed; verify against current code before relying on this entry.");
  if (verification === "failed") reasons.push(`Verification failed: ${entry.verificationNote ?? "re-map this entry before relying on it"}`);
  if (verification === "unverified") reasons.push("No correctness verification has been recorded.");
  return { freshness, verification, verifiedAt: entry.verifiedAt, verifiedHash: entry.verifiedHash, reasons };
}

export function trustHint(states: TrustState[]): string {
  const parts: string[] = [];
  if (states.some(s => s.verification === "failed")) parts.push("Verification failed for returned entries; do not rely on those descriptions until corrected.");
  if (states.some(s => s.freshness === "unknown")) parts.push("Freshness is unknown for some returned entries; inspect their files before relying on them.");
  if (states.some(s => s.freshness === "changed")) parts.push("Some returned entries have changed files, including possible local edits; verify against the current code.");
  if (!parts.length) parts.push("No changes detected in the returned anchors. This does not prove the descriptions are correct.");
  if (states.some(s => s.verification === "unverified")) parts.push("Some entries have never been verified; read their evidence or use verify_snapshot for map descriptions.");
  return parts.join(" ");
}
