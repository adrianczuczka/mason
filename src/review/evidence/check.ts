import { z } from "zod";
import { evidencePath } from "./paths.js";
import { messagePreview, type ParsedEvidence, type RawFinding } from "./types.js";

const schema = z.object({
  version: z.literal(1),
  commit: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).optional(),
  results: z.array(z.object({
    name: z.string().min(1).max(1000), status: z.enum(["passed", "failed", "skipped"]),
    message: z.string().max(100000).optional(),
    locations: z.array(z.object({ file: z.string().min(1).max(4000),
      line: z.number().int().positive().optional(), column: z.number().int().positive().optional() })).max(100).default([]),
  })).max(100000),
});

/** Adapter boundary for native validators. Derive outcomes from individual results;
 * a manifest still has to establish command completion and commit attribution. */
export function parseCheck(raw: unknown, sourceRoot: string): ParsedEvidence {
  const report = schema.parse(raw);
  const diagnostics: string[] = [], findings: RawFinding[] = [];
  const counts = { total: report.results.length, passed: 0, failed: 0, skipped: 0 };
  for (const [index, result] of report.results.entries()) {
    counts[result.status]++;
    const locations = result.locations.flatMap(location => {
      const file = evidencePath(location.file, sourceRoot);
      if (!file) { diagnostics.push(`Check location is outside the declared checkout or invalid: ${location.file}`); return []; }
      return [{ ...location, file }];
    });
    if (result.status === "failed") findings.push({ id: String(index),
      ...messagePreview([result.name, result.message].filter(Boolean).join("\n")), severity: "error", state: "active", locations });
  }
  if (!counts.total) diagnostics.push("No check results were recorded; an empty report is not passing evidence.");
  if (counts.skipped) diagnostics.push(`${counts.skipped} checks were skipped; verification is incomplete.`);
  return { outcome: counts.failed ? "failed" : !counts.total ? "unavailable" : !counts.passed ? "skipped" : "passed",
    counts, findings, incomplete: diagnostics.length > 0, diagnostics,
    ...(report.commit ? { reportedCommits: [report.commit] } : {}) };
}
