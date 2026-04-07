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
  answers: Map<string, string>
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

  // Generate rules from user answers to gap questions
  for (const [key, answer] of answers) {
    const rule = answerToRule(key, answer);
    if (rule) rules.push(rule);
  }

  return deduplicateRules(rules);
}

function answerToRule(key: string, answer: string): Rule | null {
  if (key.startsWith("stale-dir-")) {
    const dir = key.replace("stale-dir-", "");
    if (answer.toLowerCase().includes("deprecated")) {
      return {
        section: "Areas of Note",
        text: `The "${dir}/" directory is deprecated — do not modify or extend it.`,
        source: "user-answer",
        priority: 0.9,
      };
    }
    if (answer.toLowerCase().includes("legacy")) {
      return {
        section: "Areas of Note",
        text: `The "${dir}/" directory contains legacy code — do not refactor unless explicitly asked.`,
        source: "user-answer",
        priority: 0.85,
      };
    }
    if (answer.toLowerCase().includes("stable")) {
      return {
        section: "Areas of Note",
        text: `The "${dir}/" directory is stable and rarely needs changes.`,
        source: "user-answer",
        priority: 0.7,
      };
    }
  }

  if (key === "primary-test-framework") {
    return {
      section: "Testing",
      text: answer,
      source: "user-answer",
      priority: 0.9,
    };
  }

  if (key === "import-alias-preference") {
    if (answer.toLowerCase().includes("yes")) {
      return {
        section: "Code Conventions",
        text: "Use path aliases for all imports instead of relative paths.",
        source: "user-answer",
        priority: 0.85,
      };
    }
  }

  if (key === "state-management-preference") {
    return {
      section: "Architecture",
      text: `Preferred state management for new code: ${answer}.`,
      source: "user-answer",
      priority: 0.85,
    };
  }

  if (key.startsWith("isolated-pkg-")) {
    const pkg = key.replace("isolated-pkg-", "");
    if (answer.toLowerCase().includes("deprecated")) {
      return {
        section: "Architecture",
        text: `Package "${pkg}" is deprecated — do not add dependencies on it.`,
        source: "user-answer",
        priority: 0.9,
      };
    }
  }

  // Generic: use the answer directly as a rule if it's substantive
  if (answer.length > 10 && !answer.toLowerCase().includes("skip")) {
    return {
      section: "General",
      text: answer,
      source: "user-answer",
      priority: 0.7,
    };
  }

  return null;
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
