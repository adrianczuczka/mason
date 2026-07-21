import { spawn } from "node:child_process";

/**
 * Score an answer against a rubric with an LLM judge (single non-agentic
 * claude -p call). Returns { score: 0-10, rationale } or { score: null }.
 */
export function judgeAnswer({ question, criteria, answer, model = "haiku" }) {
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
