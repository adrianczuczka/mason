import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditIssue, AuditAdvisory } from "./types.js";
export type Finding = AuditIssue | AuditAdvisory;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const checkSchema = z.enum(["deleted-reference", "new-module", "stale-count", "dead-command", "deps-changed", "decision-anchor-drift"]);
export const commitSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{40,64}$/), date: z.string(), subject: z.string() });
const anchorSchema = z.object({ doc: z.string(), line: z.number().int().positive().nullable(), excerpt: z.string().nullable() });
const count = z.number().int().nonnegative();
const scopeSchema = z.object({ basis: z.enum(["repository", "document", "document-link", "explicit"]),
  directory: z.string(), candidates: z.array(z.string()) });
const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing-path"), claimed: z.string(), renamedTo: z.string().nullable(),
    deletedInCommit: commitSchema.nullable(), everTracked: z.boolean(), parentDirExists: z.boolean(), resolvedPath: z.string().optional(), scope: scopeSchema.optional() }),
  z.object({ kind: z.literal("unmentioned-dir"), dir: z.string(), sourceFileCount: count,
    firstCommit: commitSchema.nullable(), checkedDocs: z.array(z.string()) }),
  z.object({ kind: z.literal("count-mismatch"), claimed: count, actual: count, unit: z.string(),
    countedFrom: z.string(), members: z.array(z.string()) }),
  z.object({ kind: z.literal("missing-script"), scriptName: z.string(), invocation: z.string(),
    manifestsChecked: z.array(z.string()), availableScripts: z.array(z.string()), scope: scopeSchema.optional() }),
  z.object({ kind: z.literal("doc-behind-manifests"), docLastCommit: commitSchema,
    manifestCommits: z.array(commitSchema.extend({ files: z.array(z.string()) })), totalCommits: count }),
  z.object({ kind: z.literal("decision-anchor"), decisionId: z.string(), title: z.string(),
    changedFiles: z.array(z.string()), refreshedHash: z.string(),
    provenance: z.object({}).passthrough().optional() }),
]);
const findingSchema = z.object({ message: z.string(), anchor: anchorSchema, evidence: evidenceSchema });
export const issueSchema = findingSchema.extend({
  type: z.enum(["deleted-reference", "new-module", "stale-count", "dead-command"]),
  confidence: z.enum(["certain", "likely"]),
});
export const advisorySchema = findingSchema.extend({ type: checkSchema, resolution: z.literal("recheck").optional() });
export const checkResultSchema = z.object({
  issues: z.array(issueSchema), advisories: z.array(advisorySchema),
  suppressedAdvisories: z.array(advisorySchema).optional(),
  skipped: z.array(z.object({ check: z.string(), reason: z.string(), doc: z.string().optional() })),
});
/** Lines and wording can change without changing the underlying claim. */
export function findingId(finding: Finding): string {
  const e = finding.evidence;
  let key: unknown;
  switch (e.kind) {
    case "missing-path": key = e.resolvedPath && e.resolvedPath !== e.claimed ? [e.claimed, e.resolvedPath] : e.claimed; break;
    case "unmentioned-dir": key = e.dir; break;
    case "count-mismatch": key = [e.unit.replace(/s$/, ""), e.countedFrom]; break;
    case "missing-script": key = e.scope && e.scope.directory !== "." ? [e.scriptName, e.scope.directory] : e.scriptName; break;
    case "doc-behind-manifests": key = null; break;
    case "decision-anchor": key = [e.decisionId, e.provenance?.revision, e.provenance?.approval]; break;
  }
  return digest([finding.type, finding.anchor.doc, key]);
}
