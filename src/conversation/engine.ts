import { select, input } from "@inquirer/prompts";
import chalk from "chalk";
import type { AnalyzerResult, Gap } from "../types.js";

const MAX_QUESTIONS = 10;

export async function runConversation(
  results: AnalyzerResult[]
): Promise<Map<string, string>> {
  const answers = new Map<string, string>();

  const gaps = collectGaps(results);
  if (gaps.length === 0) return answers;

  console.log(
    chalk.bold(`\n💬 ${gaps.length} question${gaps.length > 1 ? "s" : ""} to refine your context:\n`)
  );

  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i];
    const prefix = chalk.gray(`[${i + 1}/${gaps.length}]`);

    console.log(`${prefix} ${gap.question}`);
    if (gap.context) {
      console.log(chalk.gray(`   ${gap.context}`));
    }

    const answer = await askGapQuestion(gap);
    if (answer) {
      answers.set(gap.answerKey, answer);
    }
    console.log();
  }

  return answers;
}

function collectGaps(results: AnalyzerResult[]): Gap[] {
  const allGaps: Gap[] = [];

  for (const result of results) {
    allGaps.push(...result.gaps);
  }

  // Deduplicate by answerKey
  const seen = new Set<string>();
  const unique = allGaps.filter((g) => {
    if (seen.has(g.answerKey)) return false;
    seen.add(g.answerKey);
    return true;
  });

  return unique.slice(0, MAX_QUESTIONS);
}

async function askGapQuestion(gap: Gap): Promise<string | null> {
  // Determine question type based on content
  if (isChoiceQuestion(gap)) {
    return askChoice(gap);
  }
  return askFreeText(gap);
}

function isChoiceQuestion(gap: Gap): boolean {
  // Questions about preferences, deprecated/stable, primary framework
  return (
    gap.question.includes("deprecated") ||
    gap.question.includes("primary") ||
    gap.question.includes("preference") ||
    gap.question.includes("Which") ||
    gap.question.includes("Is it")
  );
}

async function askChoice(gap: Gap): Promise<string | null> {
  const choices = generateChoices(gap);

  const answer = await select({
    message: "  →",
    choices: [
      ...choices.map((c) => ({ name: c, value: c })),
      { name: "Skip this question", value: "__skip__" },
    ],
  });

  if (answer === "__skip__") return null;
  return answer;
}

async function askFreeText(gap: Gap): Promise<string | null> {
  const answer = await input({
    message: "  →",
    default: "skip",
  });

  if (answer === "skip" || answer.trim() === "") return null;
  return answer.trim();
}

function generateChoices(gap: Gap): string[] {
  const q = gap.question.toLowerCase();

  if (q.includes("deprecated") && q.includes("stable")) {
    return ["Deprecated — ignore it", "Stable — leave it alone", "Legacy — don't modify unless asked"];
  }

  if (q.includes("deprecated") && q.includes("standalone")) {
    return ["Deprecated", "Standalone / independent package"];
  }

  if (q.includes("primary test framework")) {
    // Extract framework names from the question
    const match = gap.question.match(/both (.+?) and (.+?)\./);
    if (match) {
      return [
        `${match[1]} is primary`,
        `${match[2]} is primary`,
        "Both — different purposes",
      ];
    }
  }

  if (q.includes("should all imports use aliases")) {
    return ["Yes — use aliases everywhere", "No — keep the current mix", "Only for cross-directory imports"];
  }

  if (q.includes("state management") && q.includes("preferred")) {
    // Extract from context
    const libs = gap.context.match(/Found usage of (.+)/);
    if (libs) {
      const names = libs[1].split(" and ").map((s) => s.trim());
      return names.map((n) => `${n} for new code`);
    }
  }

  // Fallback: yes/no style
  return ["Yes", "No"];
}
