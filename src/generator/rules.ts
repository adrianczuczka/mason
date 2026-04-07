import type { AnalyzerResult, Rule } from "../types.js";

const CONFIDENCE_THRESHOLD = 0.6;

const CATEGORY_TO_SECTION: Record<string, string> = {
  convention: "Code Conventions",
  boundary: "Architecture",
  risk: "Areas of Note",
  pattern: "Code Conventions",
};

export function generateRules(
  results: AnalyzerResult[],
  _answers: Map<string, string>
): Rule[] {
  const rules: Rule[] = [];

  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.confidence < CONFIDENCE_THRESHOLD) continue;
      if (!finding.ruleCandidate) continue;

      rules.push({
        section: CATEGORY_TO_SECTION[finding.category] ?? "General",
        text: finding.ruleCandidate,
        source: finding.analyzer,
        priority: finding.confidence,
      });
    }
  }

  return deduplicateRules(rules);
}

function deduplicateRules(rules: Rule[]): Rule[] {
  const seen = new Map<string, Rule>();

  for (const rule of rules) {
    const key = rule.text.toLowerCase().slice(0, 50);
    const existing = seen.get(key);
    if (!existing || rule.priority > existing.priority) {
      seen.set(key, rule);
    }
  }

  return [...seen.values()];
}
