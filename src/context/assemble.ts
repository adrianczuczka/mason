import path from "node:path";
import { loadSnapshot, normalizeFeatureType } from "../snapshot/snapshot.js";
import type { FeatureType, Snapshot } from "../snapshot/snapshot.js";
import { computeDrift } from "../drift/drift.js";
import { analyzeImpact } from "../impact/impact.js";
import type { CochangeEntry, ReferenceEntry } from "../impact/impact.js";

const MAX_FEATURES = 5;
const MAX_FLOWS = 3;
const MAX_IMPACT_TARGETS = 3;

// Question/filler words that carry no signal about which feature a task
// touches. Domain words ("auth", "drift") are never in this list.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "how", "does", "do", "is", "are", "was", "what", "where", "which", "why",
  "when", "who", "i", "we", "my", "our", "you", "your", "it", "its", "this",
  "that", "these", "those", "can", "could", "should", "would", "will",
  "want", "need", "please", "about", "into", "from", "when", "there", "any",
  "all", "some", "not", "but", "also", "just", "like", "get", "make", "use",
  "new", "work", "works", "working", "implement", "implemented", "change",
  "changed", "file", "files", "code",
]);

/** Split camelCase/PascalCase/kebab/snake/path into lowercase word tokens. */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Crude singular/plural folding so "flows" matches "flow" etc. */
function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text).map(stem));
}

interface Scorable {
  name: string;
  description: string;
  files: string[];
}

/**
 * Lexical relevance of one map entry to the task. Name hits are the
 * strongest signal, then description, then file-path words. Each distinct
 * task token counts once at its best weight, so a token appearing
 * everywhere doesn't triple-count.
 */
function scoreEntry(taskTokens: Set<string>, entry: Scorable): number {
  const nameTokens = tokenSet(entry.name);
  const descTokens = tokenSet(entry.description);
  const fileTokens = tokenSet(entry.files.map((f) => path.basename(f)).join(" "));

  let score = 0;
  for (const token of taskTokens) {
    if (nameTokens.has(token)) score += 3;
    else if (descTokens.has(token)) score += 1;
    else if (fileTokens.has(token)) score += 1;
  }
  return score;
}

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

export interface ContextBundle {
  exists: true;
  task: string;
  features: Record<string, MatchedFeature>;
  flows: Record<string, MatchedFlow>;
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

  if (featureScores.length === 0 && flowScores.length === 0) {
    return noMatchBundle(snapshot, task);
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
  return {
    exists: true,
    task,
    features,
    flows,
    relatedTests,
    impact,
    freshness: {
      stale,
      recommendation: drift?.recommendation ?? "up-to-date",
      staleMatches,
    },
    hint: bundleHint(stale, staleMatches),
  };
}

function bundleHint(stale: boolean, staleMatches: string[]): string {
  if (staleMatches.length > 0) {
    return `Entries [${staleMatches.join(", ")}] changed since they were last verified — read their files rather than trusting the descriptions, and consider mason_check_drift for a refresh plan.`;
  }
  if (stale) {
    return "The matched entries are current, but other parts of the map have drifted — mason_check_drift shows what needs refreshing.";
  }
  return "Map is current. Start from the listed files; cochange/references show what else an edit would touch.";
}

function noMatchBundle(snapshot: Snapshot, task: string): NoMatchBundle {
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
    availableFeatures,
    availableFlows,
    hint: "No map entry matched the task wording. The full catalog is listed — pick the relevant entries and call get_context again with their names in the task, or read their files directly via get_snapshot.",
  };
}
