import { callLLM } from "../llm/providers.js";
import type { MasonConfig } from "../llm/config.js";
import type {
  FeatureEntry,
  FlowEntry,
  Snapshot,
} from "../snapshot/snapshot.js";
import {
  hashDescription,
  type RewriteCache,
  type RewriteCacheEntry,
} from "./diff.js";

const PM_REWRITE_SYSTEM_PROMPT = `You are Mason, rewriting an engineering-flavoured concept map into product-readable language for a company wiki.

You will receive a JSON object with two maps:
- "features": each entry has a description and a list of source file paths.
- "flows": each entry has a description and an ordered chain of file paths.

Your job: rewrite EACH description so a Product Manager, designer, or non-engineering stakeholder can understand what the system does — without seeing any code. Treat the file paths as hints, not content. Do NOT include them in your output.

Hard rules:
- NEVER mention file names, directory names, file extensions, class names, function names, repository names, framework names, or libraries.
- NEVER use words like "module", "service", "handler", "controller", "ViewModel", "repository", "endpoint", "API", "schema", "interface", "class".
- Use plain English. Focus on what users or the business can do, what data moves, what decisions get made, and why it matters.
- 1–3 sentences per description. Concrete. No filler.
- Preserve the original keys exactly; only the description values change.

Output ONLY raw JSON with the same shape as the input — same keys, rewritten descriptions. No markdown, no code fences, no preamble.`;

type Rewritten = {
  features: Record<string, string>;
  flows: Record<string, string>;
};

interface RewriteInput {
  features: Record<string, FeatureEntry>;
  flows: Record<string, FlowEntry>;
}

function buildPrompt(input: RewriteInput): string {
  return `Rewrite the descriptions below for a product audience. Return ONLY a JSON object of the form {"features": {"name": "rewritten description", ...}, "flows": {...}}.\n\n${JSON.stringify(input, null, 2)}`;
}

function parseRewriteResponse(raw: string): Rewritten {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  try {
    const parsed = JSON.parse(cleaned);
    return {
      features: parsed.features ?? {},
      flows: parsed.flows ?? {},
    };
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          features: parsed.features ?? {},
          flows: parsed.flows ?? {},
        };
      } catch {
        return { features: {}, flows: {} };
      }
    }
    return { features: {}, flows: {} };
  }
}

export interface RewriteResult {
  features: Record<string, string>;
  flows: Record<string, string>;
  /** Updated prose cache to persist into the sync state. */
  cache: RewriteCache;
}

export interface RewriteContext {
  /** Prose cache from the previous sync; used to skip unchanged entries. */
  previousCache?: RewriteCache;
  /** LLM caller; injectable for tests. Defaults to the configured provider. */
  llm?: typeof callLLM;
}

/** Pick a subset of a record by key. */
function pick<T>(source: Record<string, T>, keys: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of keys) out[k] = source[k];
  return out;
}

/**
 * Rewrite engineering descriptions into product-readable prose, incrementally.
 *
 * Entries whose source description is unchanged since the last sync (matched by
 * content hash) reuse their cached prose verbatim — no LLM call. Only new or
 * changed entries are sent to the model, batched into a single request. When
 * nothing changed, the LLM is not invoked at all.
 */
export async function rewriteForProduct(
  snapshot: Snapshot,
  config: MasonConfig,
  ctx: RewriteContext = {}
): Promise<RewriteResult> {
  const featureHashes = hashEntries(snapshot.features);
  const flowHashes = hashEntries(snapshot.flows);

  const missFeatures = missingNames(
    snapshot.features,
    featureHashes,
    ctx.previousCache?.features
  );
  const missFlows = missingNames(
    snapshot.flows,
    flowHashes,
    ctx.previousCache?.flows
  );

  let parsed: Rewritten = { features: {}, flows: {} };
  if (missFeatures.length > 0 || missFlows.length > 0) {
    const input: RewriteInput = {
      features: pick(snapshot.features, missFeatures),
      flows: pick(snapshot.flows, missFlows),
    };
    const prompt = buildPrompt(input);
    const llm = ctx.llm ?? callLLM;
    const result = await llm(config, prompt, PM_REWRITE_SYSTEM_PROMPT);
    const text =
      typeof result === "string"
        ? result
        : result.type === "response"
          ? result.text
          : "";
    // Empty text means no API/CLI is available — leave `parsed` empty so every
    // miss falls back to its engineering description (cached as fallback).
    if (text) parsed = parseRewriteResponse(text);
  }

  const features = resolve(
    snapshot.features,
    featureHashes,
    parsed.features,
    ctx.previousCache?.features
  );
  const flows = resolve(
    snapshot.flows,
    flowHashes,
    parsed.flows,
    ctx.previousCache?.flows
  );

  return {
    features: features.descriptions,
    flows: flows.descriptions,
    cache: { features: features.cache, flows: flows.cache },
  };
}

function hashEntries(
  entries: Record<string, { description: string }>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) {
    out[name] = hashDescription(entry.description);
  }
  return out;
}

/** A cache entry is a hit only if the source hash matches and it isn't a fallback. */
function isHit(
  prev: RewriteCacheEntry | undefined,
  hash: string
): prev is RewriteCacheEntry {
  return !!prev && prev.sourceHash === hash && !prev.fallback;
}

function missingNames(
  entries: Record<string, { description: string }>,
  hashes: Record<string, string>,
  prevCache: Record<string, RewriteCacheEntry> | undefined
): string[] {
  return Object.keys(entries).filter(
    (name) => !isHit(prevCache?.[name], hashes[name])
  );
}

/**
 * Build the final prose map + next cache for one collection (features or flows):
 * reuse cached prose on a hit, take fresh model prose on a miss, or fall back to
 * the engineering description (marked `fallback`) when the model omitted it.
 */
function resolve(
  entries: Record<string, { description: string }>,
  hashes: Record<string, string>,
  rewritten: Record<string, string>,
  prevCache: Record<string, RewriteCacheEntry> | undefined
): { descriptions: Record<string, string>; cache: Record<string, RewriteCacheEntry> } {
  const descriptions: Record<string, string> = {};
  const cache: Record<string, RewriteCacheEntry> = {};

  for (const [name, entry] of Object.entries(entries)) {
    const hash = hashes[name];
    const prev = prevCache?.[name];

    if (isHit(prev, hash)) {
      descriptions[name] = prev.product;
      cache[name] = { sourceHash: hash, product: prev.product };
      continue;
    }

    const fresh = rewritten[name];
    if (typeof fresh === "string" && fresh.trim().length > 0) {
      descriptions[name] = fresh;
      cache[name] = { sourceHash: hash, product: fresh };
    } else {
      // No usable model output — keep the engineering description and mark it a
      // fallback so a later successful run re-attempts it.
      descriptions[name] = entry.description;
      cache[name] = { sourceHash: hash, product: entry.description, fallback: true };
    }
  }

  return { descriptions, cache };
}
