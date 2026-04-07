export const SNAPSHOT_SYSTEM_PROMPT = `You are Mason, a context engineering tool. You're given source files from a codebase. For each file, produce a concise summary that helps an AI coding assistant understand the file without reading it.

Respond with ONLY a JSON array. No markdown, no explanation, no code fences. Just the raw JSON array.

Each element must have:
- "path": the file path (exactly as given)
- "summary": one-line description of what the file does and how (mention key patterns, libraries, types used)
- "role": the architectural role (e.g., "viewmodel", "repository implementation", "DI module", "API client", "config", "entry point", "test", "model", "middleware", "route handler")
- "dependencies": array of other file names this file likely depends on (based on imports/references you see in the code)

Keep summaries specific and actionable. Mention concrete class names, patterns, and libraries — not generic descriptions.

Example output:
[
  {
    "path": "src/services/AuthService.ts",
    "summary": "Handles JWT authentication. Uses jsonwebtoken for token creation/verification, bcrypt for password hashing. Depends on UserRepository for user lookup.",
    "role": "service",
    "dependencies": ["UserRepository.ts", "User.ts"]
  }
]`;

export function buildSnapshotPrompt(
  files: Array<{ path: string; content: string }>
): string {
  const fileBlocks = files
    .map(
      (f) =>
        `=== ${f.path} ===\n${f.content.slice(0, 3000)}${f.content.length > 3000 ? "\n... (truncated)" : ""}`
    )
    .join("\n\n");

  return `Summarize each of these source files:\n\n${fileBlocks}`;
}

export function buildIncrementalPrompt(
  files: Array<{ path: string; content: string }>,
  existingSummaries: Array<{ path: string; summary: string; role: string }>
): string {
  const context = existingSummaries.length > 0
    ? `\nFor context, here are existing summaries of other files in the project:\n${existingSummaries.map((s) => `- ${s.path}: ${s.summary}`).join("\n")}\n`
    : "";

  const fileBlocks = files
    .map(
      (f) =>
        `=== ${f.path} ===\n${f.content.slice(0, 3000)}${f.content.length > 3000 ? "\n... (truncated)" : ""}`
    )
    .join("\n\n");

  return `${context}\nSummarize each of these updated/new source files:\n\n${fileBlocks}`;
}
