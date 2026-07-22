import { spawn } from "node:child_process";

/**
 * Score an answer against a rubric with a 3-vote judge panel (independent
 * non-agentic claude -p calls, median score). Single-judge variance proved
 * too noisy: identical agent behavior scored 9 vs 6 across runs.
 * Returns { score, rationale, votes } or { score: null }.
 */
export async function judgeAnswer({ question, criteria, answer, model = "haiku", panel = 3 }) {
  const votes = (
    await Promise.all(
      Array.from({ length: panel }, () => judgeOnce({ question, criteria, answer, model }))
    )
  ).filter((v) => v.score !== null);
  if (votes.length === 0) return { score: null, rationale: "all judge votes unparseable", votes: [] };
  const sorted = votes.map((v) => v.score).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const medianVote = votes.find((v) => v.score === median);
  return { score: median, rationale: medianVote.rationale, votes: sorted };
}

function judgeOnce({ question, criteria, answer, model }) {
  const prompt = [
    "You are grading an AI assistant's answer to a question about a codebase.",
    "",
    `## Question\n${question}`,
    "",
    `## Grading criteria\n${criteria}`,
    "",
    `## Answer to grade\n${answer}`,
    "",
    "Score the answer 0-10 against the criteria. Specific file paths matter;",
    "vague or wrong paths lose points. Respond with ONLY a JSON object, no",
    'other text: {"score": <0-10>, "rationale": "<one sentence>"}',
  ].join("\n");

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--model",
    model,
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  ];

  return new Promise((resolve) => {
    const child = spawn("claude", args, { env: process.env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", () => {
      try {
        const outer = JSON.parse(stdout);
        const match = (outer.result ?? "").match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(match[0]);
        resolve({
          score: typeof parsed.score === "number" ? parsed.score : null,
          rationale: parsed.rationale ?? "",
        });
      } catch {
        resolve({ score: null, rationale: "judge output unparseable" });
      }
    });
  });
}
