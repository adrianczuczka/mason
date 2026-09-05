import { z } from "zod";
import { normalizeRepoPath } from "../utils/paths.js";
import { assessTrust, type Freshness } from "../context/trust.js";

const text = (max: number) => z.string().trim().min(1).max(max);
export const decisionSourceSchema = z.object({
  kind: z.enum(["pull_request", "issue", "incident", "discussion", "document", "other"]),
  reference: text(1000),
  note: text(500).optional(),
}).strict();
export type DecisionSource = z.infer<typeof decisionSourceSchema>;
export const attributionSchema = z.object({
  owner: text(200).nullable().optional(),
  sources: z.array(decisionSourceSchema).max(20).optional(),
  actor: text(200).optional(),
});
const contentSchema = z.object({
  title: z.string().min(1), body: z.string().min(1),
  category: z.enum(["decision", "gotcha", "deprecation", "convention"]),
  files: z.array(z.string().refine(f => normalizeRepoPath(f) !== null)),
  owner: text(200).optional(), sources: z.array(decisionSourceSchema).max(20),
});
const approvalSchema = z.enum(["unreviewed", "proposed", "accepted"]);
const statusSchema = z.enum(["active", "superseded", "retired"]);
export const reviewEvidenceSchema = z.object({
  baseHash: z.string(), headHash: z.string(), historyAvailable: z.boolean(),
  changedFiles: z.array(z.string()), localChanges: z.array(z.string()),
});
const eventSchema = z.object({
  kind: z.enum(["imported", "created", "revised", "accepted", "reaffirmed", "retired", "superseded"]),
  at: z.string().datetime(), actor: text(200).optional(), note: text(1500).optional(),
  revision: z.number().int().positive(), content: contentSchema,
  approval: approvalSchema, status: statusSchema, refreshedHash: z.string(),
  evidence: reviewEvidenceSchema.optional(),
});
export type DecisionEvent = z.infer<typeof eventSchema>;
export type DecisionApproval = z.infer<typeof approvalSchema>;
export type DecisionContent = z.infer<typeof contentSchema>;

const legacySchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1), body: z.string().min(1),
  category: contentSchema.shape.category, files: contentSchema.shape.files,
  createdAt: z.string(), updatedAt: z.string(), refreshedHash: z.string(),
  status: z.enum(["active", "superseded"]), supersededBy: z.string().optional(),
}).passthrough();
const currentSchema = legacySchema.extend({
  version: z.literal(2), status: statusSchema,
  approval: approvalSchema, revision: z.number().int().positive(),
  owner: text(200).optional(), sources: z.array(decisionSourceSchema).max(20),
  history: z.array(eventSchema).min(1),
}).superRefine((record, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  let previous: DecisionEvent | undefined;
  for (const event of record.history) {
    if (!previous) {
      if (!["created", "imported"].includes(event.kind) || event.revision !== 1) invalid("History must begin with creation or legacy import at revision 1");
      if (event.approval !== (event.kind === "created" ? "proposed" : "unreviewed")) invalid("Initial records cannot claim acceptance");
    } else {
      if (["created", "imported"].includes(event.kind)) invalid("History cannot restart");
      if (previous.status !== "active") invalid("Archived decisions cannot be changed");
      if (event.revision !== previous.revision + (event.kind === "revised" ? 1 : 0)) invalid("Invalid revision sequence");
      if (event.kind !== "revised" && !same(event.content, previous.content)) invalid("A review cannot silently revise decision content");
      if (event.kind === "reaffirmed" && previous.approval !== "accepted") invalid("Only accepted decisions can be reaffirmed");
      if (event.kind === "accepted" && previous.approval === "accepted") invalid("Use reaffirmation for an accepted decision");
      const approval = event.kind === "revised" ? "proposed" : ["accepted", "reaffirmed"].includes(event.kind) ? "accepted" : previous.approval;
      if (event.approval !== approval) invalid("Approval disagrees with review history");
      if (!["accepted", "reaffirmed"].includes(event.kind) && event.refreshedHash !== previous.refreshedHash) invalid("Only a review can refresh the evidence baseline");
    }
    if (event.kind !== "imported" && event.status !== (event.kind === "retired" ? "retired" : event.kind === "superseded" ? "superseded" : "active")) invalid("Lifecycle disagrees with history");
    if (["accepted", "reaffirmed", "retired"].includes(event.kind) && (!event.actor || !event.note || !event.evidence)) invalid("Reviews require a named reviewer, reason, and code evidence");
    if (["accepted", "reaffirmed"].includes(event.kind)) {
      if (!event.content.owner || !event.content.sources.length) invalid("Accepted decisions require an owner and source");
      if (!event.evidence || !/^[a-f0-9]{40,64}$/.test(event.evidence.headHash) || event.refreshedHash !== event.evidence.headHash || event.evidence.localChanges.length) invalid("Acceptance requires a committed evidence baseline");
    }
    previous = event;
  }
  if (!previous || !same(previous.content, decisionContent(record)) || previous.approval !== record.approval || previous.status !== record.status || previous.revision !== record.revision || previous.refreshedHash !== record.refreshedHash) invalid("Decision does not match the final history event");
});

export const decisionSchema = z.union([legacySchema, currentSchema]);
export type DecisionRecord = z.infer<typeof decisionSchema>;
export type ReviewedDecisionRecord = z.infer<typeof currentSchema>;

export function decisionContent(record: Pick<DecisionRecord, "title" | "body" | "category" | "files"> & { owner?: unknown; sources?: unknown }): DecisionContent {
  return { title: record.title, body: record.body, category: record.category, files: record.files,
    ...(typeof record.owner === "string" ? { owner: record.owner } : {}),
    sources: Array.isArray(record.sources) ? record.sources as DecisionSource[] : [],
  };
}

/** Reading legacy records never upgrades their approval or rewrites their files. */
export function decisionApproval(record: DecisionRecord): DecisionApproval {
  return record.version === 1 ? "unreviewed" : record.approval;
}

export function importLegacy(record: DecisionRecord, now: string): ReviewedDecisionRecord {
  if (record.version === 2) return record;
  // Ignore unrecognized legacy fields: they are not evidence of authorship or approval.
  const content = decisionContent({ title: record.title, body: record.body, category: record.category, files: record.files });
  return { id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, status: record.status, refreshedHash: record.refreshedHash, supersededBy: record.supersededBy, ...content, version: 2, approval: "unreviewed", revision: 1,
    history: [{ kind: "imported", at: now, revision: 1, content, approval: "unreviewed", status: record.status, refreshedHash: record.refreshedHash,
      note: "Imported a legacy record. Prior authorship and review history are unknown." }],
  };
}

export function decisionProvenance(record: DecisionRecord, freshness: Freshness = "unknown") {
  const approval = decisionApproval(record);
  const review = record.version === 2 ? [...record.history].reverse().find(e => ["accepted", "reaffirmed"].includes(e.kind) && e.revision === record.revision) : undefined;
  return {
    approval, revision: record.version === 2 ? record.revision : 0,
    owner: record.version === 2 ? record.owner ?? null : null,
    sources: record.version === 2 ? record.sources : [],
    guidance: record.status !== "active" ? "historical" : approval === "accepted" ? "constraint" : approval === "proposed" ? "proposal" : "unreviewed",
    reviewRequired: record.status === "active" && (approval !== "accepted" || freshness !== "current"),
    lastReview: review ? { reviewer: review.actor!, at: review.at, note: review.note!, gitHash: review.refreshedHash } : null,
  };
}

export function decisionTrust(record: DecisionRecord, freshness: Freshness) {
  const review = decisionProvenance(record, freshness).lastReview;
  return assessTrust(review ? { verifiedAt: review.at, verifiedHash: review.gitHash } : {}, freshness);
}

export const DECISION_GUIDANCE = "Accepted decisions are recorded team constraints, subject to freshness checks. Proposals are suggestions; legacy unreviewed records need confirmation. Use review_decision to inspect provenance and record an authorized review; identities and sources are recorded assertions, not authenticated proof.";
