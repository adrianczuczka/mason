import { callLLM } from "../llm/providers.js";
import type { MasonConfig } from "../llm/config.js";
import type {
  FeatureEntry,
  FlowEntry,
  Snapshot,
} from "../snapshot/snapshot.js";

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
}

export async function rewriteForProduct(
  snapshot: Snapshot,
  config: MasonConfig
): Promise<RewriteResult> {
  const input: RewriteInput = {
    features: snapshot.features,
    flows: snapshot.flows,
  };

  const prompt = buildPrompt(input);
  const result = await callLLM(config, prompt, PM_REWRITE_SYSTEM_PROMPT);
  const text =
    typeof result === "string"
      ? result
      : result.type === "response"
        ? result.text
        : "";

  if (!text) {
    // Fall back to original descriptions if no API/CLI is available
    return fallback(snapshot);
  }

  const parsed = parseRewriteResponse(text);

  // Merge any missing descriptions back in from the original
  const features: Record<string, string> = { ...fallbackDescriptions(snapshot.features) };
  for (const [k, v] of Object.entries(parsed.features)) {
    if (typeof v === "string" && v.trim().length > 0) features[k] = v;
  }
  const flows: Record<string, string> = { ...fallbackDescriptions(snapshot.flows) };
  for (const [k, v] of Object.entries(parsed.flows)) {
    if (typeof v === "string" && v.trim().length > 0) flows[k] = v;
  }
  return { features, flows };
}

function fallbackDescriptions(
  entries: Record<string, { description: string }>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k] = v.description;
  }
  return out;
}

function fallback(snapshot: Snapshot): RewriteResult {
  return {
    features: fallbackDescriptions(snapshot.features),
    flows: fallbackDescriptions(snapshot.flows),
  };
}
