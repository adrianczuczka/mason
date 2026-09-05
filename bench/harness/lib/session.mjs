import { spawn } from "node:child_process";
import fs from "node:fs";
import { validAdapterResult } from "./adapter.mjs";

/**
 * Run a coding session using the built-in Claude driver or a JSON adapter.
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
  maxBudgetUsd,
  controlled = false,
  executable = "claude",
  transcriptFile,
  adapter,
}) {
  const args = adapter ? adapter.args : [
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
  if (!adapter && systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (!adapter && maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(maxBudgetUsd));
  if (!adapter && controlled) {
    args.push("--setting-sources", "", "--no-session-persistence", "--disable-slash-commands",
      "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
      "--tools", "Read,Write,Edit,Glob,Grep,Bash",
      "--disallowedTools", "mcp__mason__save_snapshot,mcp__mason__save_partial_snapshot,mcp__mason__save_decision,mcp__mason__save_verification,mcp__mason__generate_snapshot_batch,mcp__mason__mason_complete_init,mcp__mason__mason_set_confluence,mcp__mason__sync_confluence");
  }

  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(adapter?.command ?? executable, args, { cwd, env: process.env, detached: process.platform !== "win32" });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") stderr += error.message; });
    child.stdin.end(adapter ? JSON.stringify({ version: 1, cwd, prompt, systemPrompt, model, mcpConfig,
      limits: { maxTurns, timeoutMs, maxBudgetUsd }, controlled }) + "\n" : undefined);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const transcript = transcriptFile ? fs.createWriteStream(transcriptFile, { flags: "wx" }) : null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputLimited = false;
    let interrupted = false;
    const kill = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* process already exited */ }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        kill();
      }
    }, timeoutMs);
    const interrupt = () => { interrupted = true; kill(); };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);

    child.stdout.on("data", (d) => {
      if (stdout.length + d.length > 16 * 1024 * 1024) { outputLimited = true; kill(); return; }
      stdout += d;
      transcript?.write(d);
    });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-16000); });
    child.on("error", error => { stderr += error.message; });
    transcript?.on("error", error => { stderr += `Transcript error: ${error.message}`; outputLimited = true; kill(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      settled = true;
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);

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

      const result = events.findLast((ev) => ev.type === "result");
      const adapterValid = !adapter || validAdapterResult(result);
      const toolCalls = adapter && adapterValid ? result.toolCalls : [];
      for (const ev of events) {
        if (adapter || ev.type !== "assistant" || !Array.isArray(ev.message?.content)) continue;
        for (const block of ev.message.content) {
          if (block.type === "tool_use") {
            toolCalls.push({ name: block.name, input: block.input });
          }
        }
      }

      const readFiles = adapter && adapterValid ? [...(result.readFiles ?? [])] : [];
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

      const usage = result?.usage ?? {};
      const providerOk = adapter ? adapterValid && result.ok : result?.subtype === "success" && !result.is_error;
      const error = adapter ? adapterValid ? result.error ?? null : "invalid_adapter_result" : events.find(e => e.is_api_error_message)?.error ?? result?.terminal_reason ?? null;

      const session = {
        ok: providerOk && code === 0 && !timedOut && !outputLimited && !interrupted,
        exitCode: code,
        resultSubtype: adapter ? providerOk ? "success" : "error" : result?.subtype ?? null,
        error,
        timedOut,
        outputLimited,
        interrupted,
        wallTimeMs: Date.now() - start,
        models: adapter ? adapterValid && result.model ? [result.model] : [] : Object.keys(result?.modelUsage ?? {}).sort(),
        resultText: adapter ? adapterValid ? result.resultText : "Adapter did not return a valid result event" : result?.result ?? "",
        costUsd: adapter ? adapterValid ? result.costUsd : null : result?.total_cost_usd ?? null,
        numTurns: adapter ? adapterValid ? result.numTurns ?? null : null : result?.num_turns ?? null,
        durationMs: adapter ? null : result?.duration_ms ?? null,
        usage: adapter ? result?.usage ?? null : {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        },
        toolCalls,
        readFiles,
        mcpCalls,
        stderr: stderr.slice(0, 2000),
      };
      if (transcript) transcript.end(() => resolve(session));
      else resolve(session);
    });
  });
}
