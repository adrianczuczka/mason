import path from "node:path";
import fs from "node:fs/promises";
import { inspectSnapshot, normalizeFeatureType } from "../snapshot/snapshot.js";
import { createFileAccess } from "../utils/files.js";
import type { FeatureType, Snapshot } from "../snapshot/snapshot.js";
import { computeDrift, type DriftReport } from "../drift/drift.js";
import { analyzeImpact } from "../impact/impact.js";
import type { CochangeEntry, ReferenceEntry } from "../impact/impact.js";
import { scoreEntry, tokenSet } from "./lexical.js";
import { loadDecisionStore } from "../decisions/decisions.js";
import { decisionKnowledge, effectiveDecision, DECISION_GUIDANCE } from "../decisions/provenance.js";
import { anchorMatches, sanitizeRepoPaths } from "../utils/paths.js";
import { assessTrust, trustHint, type TrustState } from "./trust.js";
import type { StoreDiagnostic } from "../utils/storage.js";
import type { DecisionDriftReport } from "../decisions/drift.js";
import type { DecisionCategory, DecisionRecord } from "../decisions/decisions.js";
import { computeDecisionDrift } from "../decisions/drift.js";

const MAX_FEATURES = 5;
const MAX_FLOWS = 3;
const MAX_IMPACT_TARGETS = 3;
const MAX_DECISIONS = 5;
const DECISION_FEATURE_OVERLAP_BOOST = 2;

export interface MatchedFeature {
  description: string;
  files: string[];
  tests?: string[];
  type: FeatureType;
  score: number;
  stale: boolean;
  trust: TrustState;
}

export interface MatchedFlow {
  description: string;
  chain: string[];
  score: number;
  stale: boolean;
  trust: TrustState;
}

export interface MatchedDecision extends ReturnType<typeof decisionKnowledge> {
  title: string;
  /** Full body — the payload the decisions store exists for. */
  body: string;
  category: DecisionCategory;
  files: string[];
  score: number;
  /** Anchor files changed since this record was last verified. */
  stale: boolean;
  trust: TrustState;
}

export interface ContextBundle {
  exists: true;
  map: { status: "available" };
  diagnostics?: StoreDiagnostic[];
  task: string;
  features: Record<string, MatchedFeature>;
  flows: Record<string, MatchedFlow>;
  /** Relevant knowledge; approval distinguishes constraints from proposals. */
  decisions: Record<string, MatchedDecision>;
  /** All tests paired with the matched files, deduped. */
  relatedTests: string[];
  impact: {
    targets: string[];
    cochange: CochangeEntry[];
    references: ReferenceEntry[];
  } | null;
  freshness: {
    stale: boolean;
    recommendation: string;
    /** Matched entries whose files changed since they were last verified. */
    staleMatches: string[];
  };
  hint: string;
}

export interface NoMatchBundle {
  exists: true;
  map: { status: "available" };
  impact?: ContextBundle["impact"];
  relatedTests?: string[];
  diagnostics?: StoreDiagnostic[];
  freshness?: DriftReport | null;
  trust?: { features: Record<string, TrustState>; flows: Record<string, TrustState> };
  task: string;
  features: Record<string, never>;
  flows: Record<string, never>;
  /** Decisions can match even when no feature does. */
  decisions: Record<string, MatchedDecision>;
  /** The full feature catalog, so the caller can still act without a second guess. */
  availableFeatures: Record<string, string>;
  availableFlows: Record<string, string>;
  hint: string;
}

export interface UnmappedContextBundle extends Omit<ContextBundle, "exists" | "map" | "freshness"> {
  /** Legacy exists indicates map availability, not decision availability. */
  exists: false;
  map: { status: "missing" | "invalid" };
  freshness: { stale: null; recommendation: "no-map" | "repair-map"; staleMatches: string[] };
}

async function collectImpact(root: string, candidates: string[]): Promise<{
  impact: ContextBundle["impact"]; relatedTests: string[];
}> {
  const targets = new Set<string>();
  let sourceFiles: string[] | undefined;
  for (const candidate of sanitizeRepoPaths(candidates)) {
    const stat = await fs.stat(path.join(root, candidate)).catch(() => null);
    if (stat?.isDirectory()) {
      sourceFiles ??= await (await createFileAccess(root)).list();
      for (const file of sourceFiles) {
        if (anchorMatches(candidate, file)) targets.add(file);
        if (targets.size >= MAX_IMPACT_TARGETS) break;
      }
    } else {
      targets.add(candidate);
    }
    if (targets.size >= MAX_IMPACT_TARGETS) break;
  }
  if (!targets.size) return { impact: null, relatedTests: [] };
  const result = await analyzeImpact(root, [...targets]);
  return {
    impact: { targets: result.targetFiles, cochange: result.cochange, references: result.references.slice(0, 10) },
    relatedTests: [...new Set(result.tests.map(t => t.file))],
  };
}

/**
 * Assemble everything needed to start a task in one call: matching map
 * entries, their files and tests, blast radius for the top files, and
 * per-entry freshness. Deterministic and LLM-free.
 *
 * `files` optionally anchors matching to an explicit file list (e.g. a diff):
 * entries containing those files are boosted above pure lexical matches.
 */
export async function assembleContext(
  rootDir: string,
  task: string,
  files?: string[]
): Promise<ContextBundle | NoMatchBundle | UnmappedContextBundle> {
  const resolvedRoot = path.resolve(rootDir);
  const mapState = await inspectSnapshot(resolvedRoot);
  const snapshot = mapState.snapshot;
  const store = await loadDecisionStore(resolvedRoot);
  const allDecisions = store.records;
  const decisionDrift = await computeDecisionDrift(resolvedRoot, allDecisions);
  const taskTokens = tokenSet(task);
  const anchorFiles = new Set(sanitizeRepoPaths(files ?? []));

  const anchorBoost = (entryFiles: string[]): number => {
    let boost = 0;
    for (const f of entryFiles) if ([...anchorFiles].some(file => anchorMatches(f, file))) boost += 5;
    return boost;
  };

  if (!snapshot) {
    const decisions = matchDecisions(allDecisions, taskTokens, anchorBoost, new Set(), decisionDrift);
    const { impact, relatedTests } = await collectImpact(resolvedRoot, [...anchorFiles, ...Object.values(decisions).flatMap(d => [...d.files, ...(d.pendingProposal?.files ?? [])])]);
    const invalid = mapState.status === "invalid";
    return {
      exists: false, map: { status: invalid ? "invalid" : "missing" }, task,
      features: {}, flows: {}, decisions, impact, relatedTests,
      diagnostics: [...mapState.diagnostics, ...store.diagnostics],
      freshness: { stale: null, recommendation: invalid ? "repair-map" : "no-map", staleMatches: [] },
      hint: (invalid ? "The concept map is invalid; consult diagnostics and repair it before relying on map entries. " : "No concept map is present. Maps are optional; decisions and file impact work now. ") +
        (Object.keys(decisions).length ? DECISION_GUIDANCE + " " + trustHint(Object.values(decisions).flatMap(d => [d.trust, ...(d.pendingProposal ? [d.pendingProposal.trust] : [])])) : "No saved decision matched. Inspect the source and use save_decision for a learned constraint or incident rationale. ") +
        (store.diagnostics.length ? " Some decision records are invalid; consult diagnostics before assuming all constraints were retrieved." : ""),
    };
  }

  const drift = await computeDrift(resolvedRoot);

  const featureScores = Object.entries(snapshot.features)
    .map(([name, feat]) => ({
      name,
      feat,
      score:
        scoreEntry(taskTokens, { name, description: feat.description, files: feat.files }) +
        anchorBoost([...feat.files, ...(feat.tests ?? [])]),
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FEATURES);

  const flowScores = Object.entries(snapshot.flows)
    .map(([name, flow]) => ({
      name,
      flow,
      score:
        scoreEntry(taskTokens, { name, description: flow.description, files: flow.chain }) +
        anchorBoost(flow.chain),
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FLOWS);

  const matchedEntryFiles = new Set<string>([
    ...featureScores.flatMap((e) => e.feat.files),
    ...flowScores.flatMap((e) => e.flow.chain),
  ]);
  const decisions = matchDecisions(
    allDecisions,
    taskTokens,
    anchorBoost,
    matchedEntryFiles,
    decisionDrift
  );

  if (featureScores.length === 0 && flowScores.length === 0) {
    const bundle = noMatchBundle(snapshot, task, decisions);
    Object.assign(bundle, await collectImpact(resolvedRoot, [...anchorFiles, ...Object.values(decisions).flatMap(d => [...d.files, ...(d.pendingProposal?.files ?? [])])]));
    bundle.diagnostics = store.diagnostics;
    bundle.freshness = drift;
    bundle.trust = {
      features: Object.fromEntries(Object.entries(snapshot.features).map(([name, entry]) =>
        [name, assessTrust(entry, drift?.featureFreshness?.[name] ?? "unknown")]
      )),
      flows: Object.fromEntries(Object.entries(snapshot.flows).map(([name, entry]) =>
        [name, assessTrust(entry, drift?.flowFreshness?.[name] ?? "unknown")]
      )),
    };
    bundle.hint += " " + trustHint([
      ...Object.values(bundle.trust.features),
      ...Object.values(bundle.trust.flows),
      ...Object.values(decisions).flatMap(d => [d.trust, ...(d.pendingProposal ? [d.pendingProposal.trust] : [])]),
    ]);
    if (Object.keys(decisions).length) bundle.hint += " " + DECISION_GUIDANCE;
    if (store.diagnostics.length) bundle.hint += " Some decision records are invalid; consult diagnostics.";
    return bundle;
  }

  const features: Record<string, MatchedFeature> = {};
  const staleMatches: string[] = [];
  for (const { name, feat, score } of featureScores) {
    const trust = assessTrust(feat, drift?.featureFreshness?.[name] ?? "unknown");
    const stale = trust.freshness !== "current";
    if (stale) staleMatches.push(name);
    features[name] = {
      description: feat.description,
      files: feat.files,
      ...(feat.tests && feat.tests.length > 0 ? { tests: feat.tests } : {}),
      type: normalizeFeatureType(feat.type),
      score,
      stale,
      trust,
    };
  }

  const flows: Record<string, MatchedFlow> = {};
  for (const { name, flow, score } of flowScores) {
    const trust = assessTrust(flow, drift?.flowFreshness?.[name] ?? "unknown");
    const stale = trust.freshness !== "current";
    if (stale) staleMatches.push(name);
    flows[name] = {
      description: flow.description,
      chain: flow.chain,
      score,
      stale,
      trust,
    };
  }

  const { impact, relatedTests: impactTests } = await collectImpact(resolvedRoot, [
    ...anchorFiles,
    ...featureScores.flatMap((e) => e.feat.files),
    ...flowScores.flatMap(e => e.flow.chain),
    ...Object.values(decisions).flatMap(d => [...d.files, ...(d.pendingProposal?.files ?? [])]),
  ]);

  const relatedTests = [
    ...new Set([
      ...featureScores.flatMap((e) => e.feat.tests ?? []),
      ...impactTests,
    ]),
  ];

  const stale = drift?.stale ?? false;
  return {
    exists: true,
    map: { status: "available" },
    diagnostics: store.diagnostics,
    task,
    features,
    flows,
    decisions,
    relatedTests,
    impact,
    freshness: {
      stale,
      recommendation: drift?.recommendation ?? "up-to-date",
      staleMatches,
    },
    hint: (Object.keys(decisions).length ? DECISION_GUIDANCE + " " : "") + trustHint([...Object.values(features).map(e => e.trust), ...Object.values(flows).map(e => e.trust), ...Object.values(decisions).flatMap(d => [d.trust, ...(d.pendingProposal ? [d.pendingProposal.trust] : [])])]) + (store.diagnostics.length ? " Some decision records are invalid; consult diagnostics before assuming all constraints were retrieved." : ""),
  };
}

/**
 * Score active decisions against the task with the same lexical machinery
 * as map entries, plus a feature-overlap boost: a decision anchored to a
 * file of an already-matched feature is relevant even with zero lexical
 * overlap ("auth is weird" should surface on any auth task).
 */
function matchDecisions(
  allDecisions: DecisionRecord[],
  taskTokens: Set<string>,
  anchorBoost: (files: string[]) => number,
  matchedEntryFiles: Set<string>,
  decisionDrift: DecisionDriftReport
): Record<string, MatchedDecision> {
  const scored = allDecisions
    .filter((d) => d.status === "active")
    .map((d) => {
      const scoreRevision = (revision: DecisionRecord) =>
        scoreEntry(taskTokens, { name: revision.title, description: revision.body, files: revision.files }) + anchorBoost(revision.files) +
        (revision.files.some(f => [...matchedEntryFiles].some(file => anchorMatches(f, file))) ? DECISION_FEATURE_OVERLAP_BOOST : 0);
      const score = Math.max(scoreRevision(effectiveDecision(d)), scoreRevision(d));
      return { d, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DECISIONS);

  const result: Record<string, MatchedDecision> = {};
  for (const { d, score } of scored) {
    result[d.id] = {
      ...decisionKnowledge(d, decisionDrift.freshness?.[d.id] ?? "unknown", decisionDrift.pendingProposals?.[d.id]?.freshness ?? "unknown"),
      score,
      stale: decisionDrift.freshness?.[d.id] !== "current",
    };
  }
  return result;
}

function noMatchBundle(
  snapshot: Snapshot,
  task: string,
  decisions: Record<string, MatchedDecision>
): NoMatchBundle {
  const availableFeatures: Record<string, string> = {};
  for (const [name, feat] of Object.entries(snapshot.features)) {
    availableFeatures[name] = feat.description;
  }
  const availableFlows: Record<string, string> = {};
  for (const [name, flow] of Object.entries(snapshot.flows)) {
    availableFlows[name] = flow.description;
  }
  return {
    exists: true,
    map: { status: "available" },
    task,
    features: {},
    flows: {},
    decisions,
    availableFeatures,
    availableFlows,
    hint: "No map entry matched the task wording. The full catalog is listed — pick the relevant entries and call get_context again with their names in the task, or read their files directly via get_snapshot.",
  };
}
