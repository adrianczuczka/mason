import path from "node:path";
import { z } from "zod";
import { readStoreJson } from "../utils/storage.js";
import { normalizeRepoPath, matchingPaths } from "../utils/paths.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { getWorkingTree } from "../drift/drift.js";
import { buildTestMap, type TestPair } from "../test-map.js";
import { decisionApproval, decisionProvenance, type DecisionRecord } from "../decisions/provenance.js";
import type { Freshness } from "../context/trust.js";
import { parseVitest } from "./evidence/vitest.js";
import { parseSarif } from "./evidence/sarif.js";
import { MAX_FINDINGS, type CheckOutcome, type RawFinding, type ParsedEvidence } from "./evidence/types.js";

const checkSchema = z.object({
  id: z.string().min(1).max(100), kind: z.enum(["tests", "static-analysis", "security", "complexity", "duplication"]),
  tool: z.string().min(1).max(200), command: z.string().min(1).max(2000),
  commit: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).nullable().optional(),
  workingTreeClean: z.boolean().optional(),
  source: z.string().max(2000).optional(), sourceRoot: z.string().min(1).max(4000).optional(),
  status: z.enum(["completed", "skipped", "unavailable"]).default("completed"), reason: z.string().min(1).max(2000).optional(),
  exitCode: z.number().int().nullable().optional(),
  report: z.object({ format: z.enum(["vitest-json", "sarif"]), path: z.string().min(1).max(4000) }).optional(),
});
type CheckInput = z.infer<typeof checkSchema>;
export interface LinkedFinding extends RawFinding {
  relatedChangedFiles: Array<{ file: string; relationship: "direct" | "paired-test"; confidence?: string }>;
  acceptedDecisions: Array<{ id: string; title: string; owner: string | null; freshness: Freshness; reviewRequired: boolean; viaFiles: string[] }>;
  totalAcceptedDecisions: number;
}
export interface EvidenceCheck {
  id: string; kind: CheckInput["kind"]; tool: string; command: string; commit: string | null;
  workingTreeClean: boolean | null;
  source: string | null; manifest: string; report: CheckInput["report"] | null;
  outcome: CheckOutcome; freshness: "current" | "stale" | "unknown";
  findings: LinkedFinding[]; totalFindings: number; counts: Record<string, number>;
  incomplete: boolean; diagnostics: string[]; truncated: boolean;
  reportedCommands?: string[]; reportedTools?: string[];
}
export interface ReviewEvidence {
  version: 1; scope: "committed"; headHash: string;
  status: "passed" | "failed" | "incomplete" | "unavailable";
  checks: EvidenceCheck[]; diagnostics: string[];
  summary: { passed: number; failed: number; skipped: number; unavailable: number; stale: number; unknown: number };
  workingTree: Awaited<ReturnType<typeof getWorkingTree>>;
  hint: string;
}

function relativeArtifact(root: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  const normalized = normalizeRepoPath(relative);
  if (!normalized) throw new Error(`Evidence artifact must be inside the repository: ${file}`);
  return normalized;
}

function linkFinding(finding: RawFinding, changed: Set<string>, pairs: TestPair[], decisions: DecisionRecord[], freshness: Record<string, Freshness>): LinkedFinding {
  const located = [...new Set(finding.locations.map(l => l.file))];
  const paired = pairs.filter(pair => located.includes(pair.test));
  const relatedChangedFiles: LinkedFinding["relatedChangedFiles"] = located.filter(file => changed.has(file)).map(file => ({ file, relationship: "direct" }));
  for (const pair of paired) {
    if (changed.has(pair.source) && !relatedChangedFiles.some(f => f.file === pair.source)) relatedChangedFiles.push({ file: pair.source, relationship: "paired-test", confidence: pair.confidence });
  }
  const allFiles = [...new Set([...located, ...paired.map(pair => pair.source)])];
  const acceptedDecisions = decisions.filter(d => d.status === "active" && decisionApproval(d) === "accepted")
    .map(d => ({ d, viaFiles: matchingPaths(d.files, allFiles) })).filter(match => match.viaFiles.length)
    .map(({ d, viaFiles }) => {
      const state = freshness[d.id] ?? "unknown", provenance = decisionProvenance(d, state);
      return { id: d.id, title: d.title, owner: provenance.owner, freshness: state, reviewRequired: provenance.reviewRequired, viaFiles };
    });
  return { ...finding, relatedChangedFiles, acceptedDecisions: acceptedDecisions.slice(0, 5), totalAcceptedDecisions: acceptedDecisions.length };
}

/** Read-only imports. Commands, URLs, and result locations are never executed or fetched. */
export async function collectReviewEvidence(root: string, manifests: string[], changedFiles: string[], decisions: DecisionRecord[], decisionFreshness: Record<string, Freshness> = {}, reviewedHead?: string): Promise<ReviewEvidence> {
  const [headHash, workingTree] = await Promise.all([reviewedHead ?? getCurrentGitHash(root), getWorkingTree(root)]);
  const output: ReviewEvidence = {
    version: 1, scope: "committed", headHash, status: "unavailable", checks: [], diagnostics: [], workingTree,
    summary: { passed: 0, failed: 0, skipped: 0, unavailable: 0, stale: 0, unknown: 0 },
    hint: "Evidence describes the recorded check runs for a commit, not uncommitted edits or complete test coverage. Commands and CI provenance are imported assertions, not authenticated execution. File and test-pair associations identify relevant decisions; they do not prove a decision was violated. Missing checks must be declared in the manifest to be reported.",
  };
  const seen = new Set<string>(), changed = new Set(changedFiles);
  let pairs: TestPair[] | undefined;
  if (manifests.length > 10) output.diagnostics.push("Only the first 10 evidence manifests were imported.");
  for (const supplied of manifests.slice(0, 10)) {
    let manifest: string, raw: { version: 1; checks: unknown[] };
    try {
      manifest = relativeArtifact(root, supplied);
      raw = z.object({ version: z.literal(1), checks: z.array(z.unknown()) }).parse(await readStoreJson(root, manifest));
    } catch (error) { output.diagnostics.push(`${supplied}: ${String(error)}`); continue; }
    if (!raw.checks.length) output.diagnostics.push(`${manifest}: no checks declared.`);
    for (const [index, item] of raw.checks.entries()) {
      if (output.checks.length >= 50) { output.diagnostics.push("Only the first 50 checks were imported."); break; }
      const input = checkSchema.safeParse(item);
      if (!input.success) { output.diagnostics.push(`${manifest} check ${index}: ${input.error.message}`); continue; }
      const check = input.data;
      if (seen.has(check.id)) { output.diagnostics.push(`Duplicate check id ${check.id}; give different runs distinct ids.`); continue; }
      seen.add(check.id);
      const result: EvidenceCheck = {
        id: check.id, kind: check.kind, tool: check.tool, command: check.command,
        commit: check.commit?.toLowerCase() ?? null, workingTreeClean: check.workingTreeClean ?? null, source: check.source ?? null, manifest, report: check.report ?? null,
        outcome: "unavailable", freshness: "unknown", findings: [], totalFindings: 0, counts: {}, incomplete: false, diagnostics: [], truncated: false,
      };
      output.checks.push(result);
      if (check.workingTreeClean !== true) result.diagnostics.push("The check's working tree was dirty or not recorded; its results cannot be attributed to the claimed commit alone.");
      else if (result.commit && headHash !== "unknown") result.freshness = result.commit === headHash.toLowerCase() ? "current" : "stale";
      else result.diagnostics.push("The tested commit or reviewed HEAD is unknown.");
      if (check.status !== "completed") {
        result.outcome = check.status;
        result.diagnostics.push(check.reason ?? "No reason was recorded for this skipped or unavailable check.");
        continue;
      }
      try {
        if (!check.report) throw new Error("Completed check has no report artifact.");
        if ((check.kind === "tests") !== (check.report.format === "vitest-json")) throw new Error("Test checks require vitest-json; analysis checks require sarif.");
        const file = relativeArtifact(root, check.report.path);
        const report = await readStoreJson(root, file);
        if (report === null) throw new Error(`Report artifact is missing: ${file}`);
        const sourceRoot = check.sourceRoot ?? root;
        if (!path.posix.isAbsolute(sourceRoot) && !/^[A-Za-z]:[\\/]/.test(sourceRoot)) throw new Error("sourceRoot must identify the absolute checkout root on the check runner.");
        const parsed: ParsedEvidence = check.report.format === "vitest-json" ? parseVitest(report, sourceRoot) : parseSarif(report, sourceRoot);
        result.outcome = parsed.outcome; result.counts = parsed.counts; result.incomplete = parsed.incomplete;
        result.diagnostics.push(...parsed.diagnostics);
        result.reportedCommands = parsed.reportedCommands; result.reportedTools = parsed.reportedTools;
        if (parsed.reportedCommits?.some(commit => !result.commit || commit.toLowerCase() !== result.commit)) {
          result.freshness = "unknown"; result.incomplete = true;
          result.diagnostics.push("Report revision metadata conflicts with, or cannot be tied to, the manifest's tested commit.");
        }
        if (check.exitCode == null && !parsed.executed) {
          result.incomplete = true; result.diagnostics.push("Neither an exit code nor successful analysis invocation was recorded; completion cannot be confirmed.");
        }
        if (check.exitCode != null && check.exitCode !== 0 && result.outcome === "passed") {
          result.outcome = "failed"; result.diagnostics.push(`Check command exited ${check.exitCode} despite a report with no active failures.`);
        }
        if (check.report.format === "vitest-json" && pairs === undefined) {
          try { pairs = (await buildTestMap(root)).paired; }
          catch (error) { pairs = []; output.diagnostics.push(`Test pairing unavailable: ${String(error)}`); }
        }
        result.totalFindings = parsed.findings.length;
        // Prioritize findings on changed files while retaining overall outcomes and counts.
        const testPairs = check.kind === "tests" ? pairs ?? [] : [];
        const relevant = new Set([...changed, ...testPairs.filter(p => changed.has(p.source)).map(p => p.test)]);
        const touchesChange = (f: RawFinding) => f.locations.some(l => relevant.has(l.file));
        parsed.findings.sort((a, b) => Number(b.state === "active") - Number(a.state === "active") || Number(touchesChange(b)) - Number(touchesChange(a)));
        result.findings = parsed.findings.slice(0, MAX_FINDINGS).map(f => linkFinding(f, changed, testPairs, decisions, decisionFreshness));
        result.truncated = parsed.findings.length > MAX_FINDINGS || result.findings.some(f => f.truncated || f.totalAcceptedDecisions > f.acceptedDecisions.length);
      } catch (error) {
        result.outcome = "unavailable"; result.incomplete = true; result.diagnostics.push(String(error));
      }
    }
  }
  if (!output.checks.length) output.diagnostics.push("No readable checks were imported.");
  for (const check of output.checks) {
    output.summary[check.outcome]++;
    if (check.freshness !== "current") output.summary[check.freshness]++;
  }
  if (output.checks.some(c => c.outcome === "failed" && c.freshness === "current")) output.status = "failed";
  else if (!output.checks.length || output.checks.every(c => c.outcome === "unavailable")) output.status = "unavailable";
  else if (output.diagnostics.length || output.checks.some(c => c.outcome !== "passed" || c.freshness !== "current" || c.incomplete)) output.status = "incomplete";
  else output.status = "passed";
  return output;
}

export function summarizeEvidence(evidence: ReviewEvidence) {
  const previews = (values: string[], limit: number) => values.slice(0, limit).map(value => value.slice(0, 2000));
  const checks = evidence.checks.slice(0, 10).map(check => {
    const findings = check.findings.slice(0, 5).map(finding => ({ ...finding,
      ruleId: finding.ruleId?.slice(0, 200),
      locations: finding.locations.slice(0, 5), totalLocations: finding.locations.length,
      relatedChangedFiles: finding.relatedChangedFiles.slice(0, 5), totalRelatedChangedFiles: finding.relatedChangedFiles.length,
      acceptedDecisions: finding.acceptedDecisions.map(decision => ({ ...decision, viaFiles: decision.viaFiles.slice(0, 5) })),
      truncated: finding.truncated || finding.locations.length > 5 || finding.relatedChangedFiles.length > 5 ||
        (finding.ruleId?.length ?? 0) > 200 || finding.acceptedDecisions.some(d => d.viaFiles.length > 5),
    }));
    return { ...check, findings, reportedCommands: check.reportedCommands ? previews(check.reportedCommands, 5) : undefined,
      reportedTools: check.reportedTools ? previews(check.reportedTools, 5) : undefined,
      diagnostics: previews(check.diagnostics, 10),
      truncated: check.truncated || check.findings.length > 5 || findings.some(f => f.truncated) || check.diagnostics.length > 10 ||
        check.diagnostics.some(d => d.length > 2000) || [check.reportedCommands ?? [], check.reportedTools ?? []].some(values => values.length > 5 || values.some(v => v.length > 2000)),
    };
  });
  return { ...evidence, checks, diagnostics: previews(evidence.diagnostics, 20),
    truncated: evidence.checks.length > 10 || evidence.diagnostics.length > 20 || evidence.diagnostics.some(d => d.length > 2000) || checks.some(c => c.truncated),
  };
}
