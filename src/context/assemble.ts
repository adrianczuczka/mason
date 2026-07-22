import path from "node:path";
import { loadSnapshot, normalizeFeatureType } from "../snapshot/snapshot.js";
import type { FeatureType, Snapshot } from "../snapshot/snapshot.js";
import { computeDrift } from "../drift/drift.js";
import { analyzeImpact } from "../impact/impact.js";
import type { CochangeEntry, ReferenceEntry } from "../impact/impact.js";
import { scoreEntry, tokenSet } from "./lexical.js";
import { loadDecisions } from "../decisions/decisions.js";
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
}

export interface MatchedFlow {
  description: string;
  chain: string[];
  score: number;
  stale: boolean;
}

export interface MatchedDecision {
  title: string;
  /** Full body — the payload the decisions store exists for. */
  body: string;
  category: DecisionCategory;
  files: string[];
  score: number;
  /** Anchor files changed since this record was last verified. */
  stale: boolean;
}

export interface ContextBundle {
  exists: true;
  task: string;
  features: Record<string, MatchedFeature>;
  flows: Record<string, MatchedFlow>;
  /** Recorded team knowledge matching this task — treat as constraints. */
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
): Promise<ContextBundle | NoMatchBundle | null> {
  const resolvedRoot = path.resolve(rootDir);
  const snapshot = await loadSnapshot(resolvedRoot);
  if (!snapshot) return null;

  const drift = await computeDrift(resolvedRoot);
  const allDecisions = await loadDecisions(resolvedRoot);
  const decisionDrift = await computeDecisionDrift(resolvedRoot, allDecisions);
  const taskTokens = tokenSet(task);
  const anchorFiles = new Set(files ?? []);

  const anchorBoost = (entryFiles: string[]): number => {
    let boost = 0;
    for (const f of entryFiles) if (anchorFiles.has(f)) boost += 5;
    return boost;
  };

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
    decisionDrift.staleDecisions
  );

  if (featureScores.length === 0 && flowScores.length === 0) {
    return noMatchBundle(snapshot, task, decisions);
  }

  const features: Record<string, MatchedFeature> = {};
  const staleMatches: string[] = [];
  for (const { name, feat, score } of featureScores) {
    const stale = drift?.staleFeatures[name] !== undefined;
    if (stale) staleMatches.push(name);
    features[name] = {
      description: feat.description,
      files: feat.files,
      ...(feat.tests && feat.tests.length > 0 ? { tests: feat.tests } : {}),
      type: normalizeFeatureType(feat.type),
      score,
      stale,
    };
  }

  const flows: Record<string, MatchedFlow> = {};
  for (const { name, flow, score } of flowScores) {
    const stale = drift?.staleFlows[name] !== undefined;
    if (stale) staleMatches.push(name);
    flows[name] = {
      description: flow.description,
      chain: flow.chain,
      score,
      stale,
    };
  }

  // Blast radius for the most relevant files: anchor files first, then the
  // top-scoring feature's files.
  const impactTargets = [
    ...anchorFiles,
    ...featureScores.flatMap((e) => e.feat.files),
  ].slice(0, MAX_IMPACT_TARGETS);

  let impact: ContextBundle["impact"] = null;
  let impactTests: string[] = [];
  if (impactTargets.length > 0) {
    const result = await analyzeImpact(resolvedRoot, impactTargets);
    impact = {
      targets: result.targetFiles,
      cochange: result.cochange,
      references: result.references.slice(0, 10),
    };
    impactTests = result.tests.map((t) => t.file);
  }

  const relatedTests = [
    ...new Set([
      ...featureScores.flatMap((e) => e.feat.tests ?? []),
      ...impactTests,
    ]),
  ];

  const stale = drift?.stale ?? false;
  const staleDecisionIds = Object.keys(decisions).filter(
    (id) => decisions[id].stale
  );
  return {
    exists: true,
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
    hint: bundleHint(stale, staleMatches, staleDecisionIds),
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
  staleDecisions: Record<string, string[]>
): Record<string, MatchedDecision> {
  const scored = allDecisions
    .filter((d) => d.status === "active")
    .map((d) => {
      let score =
        scoreEntry(taskTokens, {
          name: d.title,
          description: d.body,
          files: d.files,
        }) + anchorBoost(d.files);
      if (d.files.some((f) => matchedEntryFiles.has(f))) {
        score += DECISION_FEATURE_OVERLAP_BOOST;
      }
      return { d, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DECISIONS);

  const result: Record<string, MatchedDecision> = {};
  for (const { d, score } of scored) {
    result[d.id] = {
      title: d.title,
      body: d.body,
      category: d.category,
      files: d.files,
      score,
      stale: staleDecisions[d.id] !== undefined,
    };
  }
  return result;
}

function bundleHint(
  stale: boolean,
  staleMatches: string[],
  staleDecisionIds: string[] = []
): string {
  const parts: string[] = [];
  if (staleMatches.length > 0) {
    parts.push(
      `Entries [${staleMatches.join(", ")}] changed since they were last verified — read their files rather than trusting the descriptions, and consider mason_check_drift for a refresh plan.`
    );
  } else if (stale) {
    parts.push(
      "The matched entries are current, but other parts of the map have drifted — mason_check_drift shows what needs refreshing."
    );
  } else {
    parts.push(
      "Map is current. Start from the listed files; cochange/references show what else an edit would touch."
    );
  }
  if (staleDecisionIds.length > 0) {
    parts.push(
      `Decisions [${staleDecisionIds.join(", ")}] have anchor files that changed since they were recorded — verify each still holds; if it does, re-save it with its id to re-pin, otherwise update or supersede it via save_decision.`
    );
  }
  return parts.join(" ");
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
    task,
    features: {},
    flows: {},
    decisions,
    availableFeatures,
    availableFlows,
    hint: "No map entry matched the task wording. The full catalog is listed — pick the relevant entries and call get_context again with their names in the task, or read their files directly via get_snapshot.",
  };
}
