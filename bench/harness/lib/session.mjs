import { spawn } from "node:child_process";

/**
 * Run one headless Claude Code session and parse its stream-json output.
 *
 * Returns:
 *   {
 *     ok, resultText, costUsd, numTurns, durationMs,
 *     usage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens },
 *     toolCalls: [{ name, input }],          // every tool_use in order
 *     readFiles: [string],                   // distinct Read file paths, in order
 *     mcpCalls: [string],                    // mason MCP tool names called, in order
 *   }
 */
export function runSession({
  cwd,
  prompt,
  mcpConfig = { mcpServers: {} },
  model = "sonnet",
  maxTurns = 40,
  systemPrompt,
  timeoutMs = 15 * 60 * 1000,
}) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--dangerously-skip-permissions",
  ];
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      clearTimeout(timer);
      settled = true;

      const events = stdout
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const toolCalls = [];
      for (const ev of events) {
        if (ev.type !== "assistant" || !ev.message?.content) continue;
        for (const block of ev.message.content) {
          if (block.type === "tool_use") {
            toolCalls.push({ name: block.name, input: block.input });
          }
        }
      }

      const readFiles = [];
      for (const tc of toolCalls) {
        if (tc.name === "Read" && tc.input?.file_path) {
          if (!readFiles.includes(tc.input.file_path)) {
            readFiles.push(tc.input.file_path);
          }
        }
      }

      const mcpCalls = toolCalls
        .filter((tc) => tc.name.startsWith("mcp__"))
        .map((tc) => tc.name);

      const result = events.find((ev) => ev.type === "result");
      const usage = result?.usage ?? {};

      resolve({
        ok: result?.subtype === "success" && code === 0,
        resultText: result?.result ?? "",
        costUsd: result?.total_cost_usd ?? null,
        numTurns: result?.num_turns ?? null,
        durationMs: result?.duration_ms ?? null,
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        },
        toolCalls,
        readFiles,
        mcpCalls,
        stderr: stderr.slice(0, 2000),
      });
    });
  });
}
