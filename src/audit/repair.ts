import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { computeAudit } from "./audit.js";
import { DOC_CANDIDATES } from "./docs.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { getChangesWithStatus } from "../drift/drift.js";
import { readStoreJson, storePath, writeStoreJson } from "../utils/storage.js";
import { readBoundedFile } from "../utils/files.js";
import { isWithinRoot } from "../utils/paths.js";
import { ALL_CHECKS } from "./types.js";
import type { AuditAdvisory, AuditIssue, AuditReport, CheckName } from "./types.js";

const checkSchema = z.enum(["deleted-reference", "new-module", "stale-count", "dead-command", "deps-changed", "decision-anchor-drift"]);
const commitSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{40,64}$/), date: z.string(), subject: z.string() });
const anchorSchema = z.object({ doc: z.string(), line: z.number().int().positive().nullable(), excerpt: z.string().nullable() });
const count = z.number().int().nonnegative();
const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing-path"), claimed: z.string(), renamedTo: z.string().nullable(),
    deletedInCommit: commitSchema.nullable(), everTracked: z.boolean(), parentDirExists: z.boolean() }),
  z.object({ kind: z.literal("unmentioned-dir"), dir: z.string(), sourceFileCount: count,
    firstCommit: commitSchema.nullable(), checkedDocs: z.array(z.string()) }),
  z.object({ kind: z.literal("count-mismatch"), claimed: count, actual: count, unit: z.string(),
    countedFrom: z.string(), members: z.array(z.string()) }),
  z.object({ kind: z.literal("missing-script"), scriptName: z.string(), invocation: z.string(),
    manifestsChecked: z.array(z.string()), availableScripts: z.array(z.string()) }),
  z.object({ kind: z.literal("doc-behind-manifests"), docLastCommit: commitSchema,
    manifestCommits: z.array(commitSchema.extend({ files: z.array(z.string()) })), totalCommits: count }),
  z.object({ kind: z.literal("decision-anchor"), decisionId: z.string(), title: z.string(),
    changedFiles: z.array(z.string()), refreshedHash: z.string(),
    provenance: z.object({}).passthrough().optional() }),
]);
const findingSchema = z.object({ message: z.string(), anchor: anchorSchema, evidence: evidenceSchema });
const issueSchema = findingSchema.extend({
  type: z.enum(["deleted-reference", "new-module", "stale-count", "dead-command"]),
  confidence: z.enum(["certain", "likely"]),
});
const advisorySchema = findingSchema.extend({ type: z.enum(["deps-changed", "decision-anchor-drift"]) });
const reportSchema = z.object({
  version: z.literal(1), root: z.string(), gitAvailable: z.literal(true),
  headHash: commitSchema.shape.hash, checksRun: z.array(checkSchema).nonempty(),
  docs: z.array(z.object({ path: z.enum(DOC_CANDIDATES), lastCommit: commitSchema.nullable(),
    dirty: z.boolean(), lineCount: count })).nonempty(),
  decisionsChecked: z.boolean(), clean: z.boolean(),
  issues: z.array(issueSchema), advisories: z.array(advisorySchema),
  suppressedAdvisories: z.array(advisorySchema).optional(),
  skippedChecks: z.array(z.object({ check: z.string(), reason: z.string(), doc: z.string().optional() })),
});
const baselineSchema = z.object({
  kind: z.literal("mason-audit-repair"), version: z.literal(1),
  createdAt: z.string().datetime(), report: reportSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type RepairStatus = "resolved" | "unresolved" | "review-required" | "unverified";
type Finding = AuditIssue | AuditAdvisory;
export interface RepairFinding {
  id: string;
  original: Finding;
  status: RepairStatus;
  reason: string;
  current?: Finding;
}
export interface RepairVerification {
  version: 1;
  action: "verify";
  baselinePath: string;
  baselineHead: string;
  currentHead: string | null;
  status: "verified" | "issues-remain" | "incomplete";
  findings: RepairFinding[];
  newFindings: Finding[];
  diagnostics: string[];
  currentAudit: AuditReport | null;
  counts: Record<RepairStatus, number>;
  scope: string;
}

/** Lines and wording can change without changing the underlying claim. */
function findingId(finding: Finding): string {
  const e = finding.evidence;
  let key: unknown;
  switch (e.kind) {
    case "missing-path": key = e.claimed; break;
    case "unmentioned-dir": key = e.dir; break;
    case "count-mismatch": key = [e.unit.replace(/s$/, ""), e.countedFrom]; break;
    case "missing-script": key = e.scriptName; break;
    case "doc-behind-manifests": key = null; break;
    case "decision-anchor": key = [e.decisionId, e.provenance?.revision, e.provenance?.approval]; break;
  }
  return digest([finding.type, finding.anchor.doc, key]);
}
function allFindings(report: AuditReport): Finding[] {
  return [...report.issues, ...report.advisories, ...(report.suppressedAdvisories ?? [])];
}

async function docState(root: string): Promise<string> {
  const docs = [];
  for (const doc of DOC_CANDIDATES) {
    try {
      const content = await readBoundedFile(await storePath(root, doc), 10 * 1024 * 1024);
      if (content === null) throw new Error("Context file is not regular or exceeds 10 MiB: " + doc);
      docs.push([doc, digest(content)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      docs.push([doc, null]);
    }
  }
  return digest(docs);
}

/** Refuse a verification assembled across a commit or instruction-file edit. */
async function stableAudit(root: string, checks: CheckName[]) {
  const head = await getCurrentGitHash(root);
  const before = await docState(root);
  const report = await computeAudit(root, { checks });
  if (head !== await getCurrentGitHash(root) || before !== await docState(root) ||
      (report && report.headHash !== head)) {
    throw new Error("HEAD or context files changed during the audit; retry against a stable checkout.");
  }
  return report;
}

export async function prepareRepair(rootDir: string, checks: CheckName[] = ALL_CHECKS) {
  const root = await fs.realpath(rootDir);
  const selected = z.array(checkSchema).nonempty().parse(checks);
  const report = await stableAudit(root, selected);
  if (!report) throw new Error("No context files found to prepare a repair.");
  if (!report.gitAvailable) throw new Error("Readable Git history is required to prepare a repair.");
  // Canonicalize before hashing; validation on read must yield the same bytes.
  const storedReport = reportSchema.parse(report);
  const payload = { kind: "mason-audit-repair" as const, version: 1 as const,
    createdAt: new Date().toISOString(), report: storedReport };
  const baselinePath = ".mason/reports/repairs/" + randomUUID() + ".json";
  await writeStoreJson(root, baselinePath, { ...payload, digest: digest(payload) });
  return { version: 1 as const, action: "prepare" as const, baselinePath, report };
}

export async function verifyRepair(rootDir: string, baselinePath: string): Promise<RepairVerification> {
  const root = await fs.realpath(rootDir);
  const declaredRoot = path.resolve(rootDir);
  const relative = path.isAbsolute(baselinePath)
    ? path.relative(isWithinRoot(declaredRoot, baselinePath) ? declaredRoot : root, baselinePath)
    : baselinePath;
  const stored = baselineSchema.parse(await readStoreJson(root, relative));
  const { digest: savedDigest, ...payload } = stored;
  if (digest(payload) !== savedDigest) throw new Error("Repair baseline was modified; use the original baseline.");
  if (stored.report.root !== root) throw new Error("Repair baseline belongs to a different repository.");
  const original = stored.report as AuditReport;
  const diagnostics: string[] = [];
  let current: AuditReport | null = null;
  try {
    current = await stableAudit(root, original.checksRun!);
    if (!current) diagnostics.push("No context files remain available to audit.");
    else if (!current.gitAvailable) diagnostics.push("Git history is unavailable.");
    for (const doc of original.docs) {
      if (!original.issues.some(f => f.anchor.doc === doc.path) || !current?.docs.some(d => d.path === doc.path)) continue;
      const content = await readBoundedFile(await storePath(root, doc.path), 10 * 1024 * 1024);
      if (content === null || !content.trim()) {
        diagnostics.push("Original context file " + doc.path + " is empty or unreadable; losing its claims does not verify a repair.");
      }
    }
    if (await getChangesWithStatus(root, original.headHash!) === null) {
      diagnostics.push("The original audit commit is unavailable; repair history cannot be verified.");
    }
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  const currentById = new Map((current ? allFindings(current) : []).map(f => [findingId(f), f]));
  const originalFindings = allFindings(original);
  const originalIds = new Set(originalFindings.map(findingId));
  const missingDocs = original.docs.filter(doc => !current?.docs.some(d => d.path === doc.path));
  for (const doc of missingDocs) diagnostics.push("Original context file " + doc.path + " is unavailable; removing it does not verify a repair.");
  const findings = originalFindings.map((finding): RepairFinding => {
    const id = findingId(finding);
    const now = currentById.get(id);
    const base = { id, original: finding, ...(now ? { current: now } : {}) };
    if (diagnostics.length || !current) {
      return { ...base, status: "unverified", reason: "The original audit scope could not be verified. See diagnostics." };
    }
    if ("confidence" in finding && now) {
      return { ...base, status: "unresolved", reason: "The original check still reports this claim." };
    }
    const skipped = current.skippedChecks.filter(s => s.check === finding.type && (!s.doc || s.doc === finding.anchor.doc));
    if (!current.checksRun?.includes(finding.type) || skipped.length) {
      return { ...base, status: "unverified", reason: skipped.map(s => s.reason).join("; ") || "The original check did not run." };
    }
    if (!("confidence" in finding)) {
      return { ...base, status: "review-required",
        reason: "An audit cannot establish that this advisory was reviewed. Retain its original evidence and report a separate assessment; editing or committing the doc is not approval." };
    }
    return { ...base, status: "resolved", reason: "The original check ran and no longer reports this claim. Inspect the edit for semantic correctness." };
  });
  const newFindings = [...currentById].filter(([id]) => !originalIds.has(id)).map(([, f]) => f);
  const counts: Record<RepairStatus, number> = { resolved: 0, unresolved: 0, "review-required": 0, unverified: 0 };
  for (const f of findings) counts[f.status]++;
  const incomplete = diagnostics.length > 0 || counts.unverified > 0 || counts["review-required"] > 0 ||
    (current?.skippedChecks.length ?? 0) > 0 || newFindings.some(f => !("confidence" in f));
  const issuesRemain = counts.unresolved > 0 || newFindings.some(f => "confidence" in f);
  return {
    version: 1, action: "verify", baselinePath: relative, baselineHead: original.headHash!,
    currentHead: current?.gitAvailable ? current.headHash! : null,
    status: incomplete ? "incomplete" : issuesRemain ? "issues-remain" : "verified",
    findings, newFindings, diagnostics, currentAudit: current, counts,
    scope: "Original audit checks over current context files and repository evidence. Resolved means no longer detected by that check. Advisories require separate review; this is not a certification of documentation or application correctness.",
  };
}

export function repairExitCode(report: RepairVerification): number {
  return report.status === "verified" ? 0 : report.status === "issues-remain" ? 1 : 2;
}

export function formatRepairSummary(report: RepairVerification): string {
  return [
    "Repair verification: " + report.status + ". Baseline: " + report.baselinePath,
    ...report.findings.map(f => "  [" + f.status + "] " + f.original.type + " " + f.original.anchor.doc + ": " + f.original.message + "\n    " + f.reason),
    ...report.newFindings.map(f => "  [new] " + f.type + " " + f.anchor.doc + ": " + f.message),
    ...report.diagnostics.map(d => "  [unverified] " + d),
    ...(report.currentAudit?.skippedChecks ?? []).map(s => "  [skipped] " + s.check + ": " + s.reason),
    report.scope,
  ].join("\n");
}
