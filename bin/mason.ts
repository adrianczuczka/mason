// Mason is MCP-only as of v0.4.0. This shim exists so that users with
// `mason ...` in their shell history get a clear migration message instead
// of a cryptic command-not-found.

const lines = [
  "",
  "Mason 0.4.0 is MCP-only — the standalone CLI was removed.",
  "",
  "Install for Claude Code:",
  "  claude mcp add mason --scope user -- npx -p mason-context mason-mcp",
  "",
  "Other MCP clients (Cursor, Windsurf, Codex, VS Code) — see:",
  "  https://github.com/adrianczuczka/mason#readme",
  "",
  "Then ask your assistant: \"use mason to set up this project.\"",
  "",
];
console.error(lines.join("\n"));
process.exit(1);
