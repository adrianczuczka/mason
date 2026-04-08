import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import ora from "ora";
import chalk from "chalk";
import { runAll } from "./analyzers/index.js";
import { isGitRepo } from "./utils/git.js";
import {
  loadConfig,
  saveConfig,
  validateProvider,
  getDefaultModel,
  detectCLI,
  needsApiKey,
} from "./llm/config.js";
import { callLLM } from "./llm/providers.js";
import { fullAnalysis } from "./mcp/tools.js";
import * as log from "./utils/logger.js";
import type { AnalyzerContext } from "./types.js";

async function buildContext(dir: string): Promise<AnalyzerContext> {
  return {
    rootDir: dir,
    gitAvailable: await isGitRepo(dir),
  };
}

function printFindings(results: Awaited<ReturnType<typeof runAll>>): void {
  for (const result of results) {
    if (result.findings.length === 0) {
      log.debug(`${result.analyzer}: no findings`);
      continue;
    }

    console.log(
      chalk.bold(`\n📋 ${result.analyzer}`) +
        chalk.gray(` (${result.durationMs}ms)`)
    );

    for (const finding of result.findings) {
      const conf = chalk.gray(`[${Math.round(finding.confidence * 100)}%]`);
      console.log(`  ${conf} ${finding.summary}`);
      for (const ev of finding.evidence) {
        console.log(chalk.gray(`       ${ev.filePath}: ${ev.detail}`));
      }
    }
  }
}

function extractMarkdown(raw: string): string {
  const trimmed = raw.trim();

  // If it starts with a markdown heading, it's already clean
  if (trimmed.startsWith("# ")) return trimmed;

  // If wrapped in a code fence, extract the content
  const fenceMatch = trimmed.match(/```(?:markdown|md)?\n([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Find the first markdown heading and take everything from there
  const headingIndex = trimmed.search(/^# /m);
  if (headingIndex >= 0) return trimmed.slice(headingIndex).trim();

  // Last resort: find any line starting with ## and take from there
  const subheadingIndex = trimmed.search(/^## /m);
  if (subheadingIndex >= 0) return trimmed.slice(subheadingIndex).trim();

  // Nothing looks like markdown — return as-is
  return trimmed;
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name("mason")
    .description(
      "Context engineering CLI & MCP server — generates intelligent CLAUDE.md files"
    )
    .version("0.1.0");

  program
    .command("setup")
    .description("Register Mason as an MCP server with Claude Code")
    .option("--scope <scope>", "Config scope: user or project", "user")
    .action(async (opts: { scope: string }) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);

      try {
        // Check if claude CLI is available
        await exec("claude", ["--version"]);
      } catch {
        log.error(
          "Claude Code CLI not found. Install it from https://claude.ai/code"
        );
        process.exit(1);
      }

      try {
        const args = [
          "mcp", "add", "mason",
          "--scope", opts.scope,
          "--", "npx", "mason-ai", "mcp",
        ];
        await exec("claude", args);
        log.success("Mason registered with Claude Code.");
        log.info("Restart Claude Code to start using Mason's tools.");
      } catch (err) {
        log.error(
          `Failed to register: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });

  program
    .command("set-llm")
    .description("Configure the LLM provider for standalone generation")
    .argument("<provider>", "LLM provider: claude, gemini, openai, or ollama")
    .argument("[api-key]", "API key (not needed for claude or ollama)")
    .option("--model <model>", "Override the default model")
    .option("--ollama-host <host>", "Ollama server URL", "http://localhost:11434")
    .action(
      async (
        provider: string,
        apiKey: string | undefined,
        opts: { model?: string; ollamaHost?: string }
      ) => {
        const validProvider = validateProvider(provider);

        // Claude and Ollama can work without API keys via their CLIs
        if (needsApiKey(validProvider) && !apiKey) {
          log.error(
            `API key is required for ${validProvider}. Usage: mason set-llm ${validProvider} <api-key>`
          );
          process.exit(1);
        }

        // For CLI-based providers, verify the CLI is available
        if (!apiKey && !needsApiKey(validProvider)) {
          const cli = await detectCLI(validProvider);
          if (!cli.available) {
            const hints: Record<string, string> = {
              claude: "Claude Code CLI not found. Install it from https://claude.ai/code, or provide an API key: mason set-llm claude <api-key>",
              gemini: "Gemini CLI not found. Install it from https://ai.google.dev/gemini-api/docs/cli, or provide an API key: mason set-llm gemini <api-key>",
              ollama: "Ollama not found. Install it from https://ollama.ai",
            };
            log.error(hints[validProvider] ?? "CLI not found for this provider.");
            process.exit(1);
          }
          log.info(
            `Found ${validProvider} CLI (${cli.version ?? "installed"}). No API key needed.`
          );
        }

        const config = {
          provider: validProvider,
          apiKey,
          model: opts.model,
          ollamaHost: validProvider === "ollama" ? opts.ollamaHost : undefined,
        };

        await saveConfig(config);
        const model = config.model ?? getDefaultModel(validProvider);
        log.success(
          `Configured ${validProvider} (model: ${model}). Run "mason generate" to create a CLAUDE.md.`
        );
      }
    );

  program
    .command("generate")
    .description("Analyze codebase and generate CLAUDE.md using configured LLM")
    .argument("[dir]", "Directory to analyze", ".")
    .option("--model <model>", "Override the configured model for this run")
    .action(async (dir: string, opts: { model?: string }) => {
      const config = await loadConfig();
      if (!config) {
        log.error(
          'No LLM configured. Run "mason set-llm <provider> <api-key>" first.'
        );
        process.exit(1);
      }

      const rootDir = path.resolve(dir);
      const runConfig = opts.model ? { ...config, model: opts.model } : config;

      const spinner = ora("Analyzing codebase...").start();
      const analysisData = await fullAnalysis(rootDir);
      spinner.text = `Generating CLAUDE.md with ${runConfig.provider}...`;

      try {
        const result = await callLLM(
          runConfig,
          `Here is the full project analysis. Write a CLAUDE.md based on this data:\n\n${analysisData}`
        );

        spinner.stop();

        if (result.type === "prompt") {
          // No CLI/API available — output prompt for user to paste
          console.log(
            chalk.bold("\nNo API key or CLI available. Copy this prompt into your LLM:\n")
          );
          console.log(chalk.gray("─".repeat(60)));
          console.log(result.text);
          console.log(chalk.gray("─".repeat(60)));
          console.log(
            chalk.gray("\nPaste the LLM's response into CLAUDE.md manually.")
          );
          return;
        }

        const markdown = extractMarkdown(result.text);
        if (!markdown.trim()) {
          log.error("LLM returned empty response.");
          process.exit(1);
        }

        const claudeDir = path.join(rootDir, ".claude");
        await fs.mkdir(claudeDir, { recursive: true });
        const outPath = path.join(claudeDir, "CLAUDE.md");
        await fs.writeFile(outPath, markdown, "utf-8");
        log.success(`Generated ${outPath}`);
      } catch (err) {
        spinner.stop();
        log.error(
          `Failed to generate: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });

  program
    .command("snapshot")
    .description("Generate a persistent project snapshot using LLM")
    .argument("[dir]", "Directory to analyze", ".")
    .option("--install-hook", "Install a post-commit git hook to auto-update")
    .action(async (dir: string, opts: { installHook?: boolean }) => {
      const {
        createSnapshot,
        installHook,
      } = await import("./snapshot/snapshot.js");

      const rootDir = path.resolve(dir);

      if (opts.installHook) {
        try {
          await installHook(rootDir);
          log.success("Post-commit hook installed. Snapshot will auto-update on each commit.");
        } catch (err) {
          log.error(
            `Failed to install hook: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }

      const config = await loadConfig();
      if (!config) {
        log.error(
          'No LLM configured. Run "mason set-llm <provider> <api-key>" first.'
        );
        process.exit(1);
      }

      const spinner = ora("Building project snapshot...").start();
      try {
        const snapshot = await createSnapshot(rootDir, config);
        spinner.stop();
        const featureCount = Object.keys(snapshot.features).length;
        const flowCount = Object.keys(snapshot.flows).length;
        log.success(
          `Concept map created: ${featureCount} features, ${flowCount} flows → .mason/snapshot.json`
        );
      } catch (err) {
        spinner.stop();
        log.error(
          `Failed to create snapshot: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });

  program
    .command("snapshot-update")
    .description("Incrementally update snapshot with recent changes")
    .argument("[dir]", "Directory to update", ".")
    .action(async (dir: string) => {
      const { updateSnapshot } = await import("./snapshot/snapshot.js");
      const rootDir = path.resolve(dir);

      const config = await loadConfig();
      if (!config) return; // Silent exit — called from hook, don't spam

      try {
        const result = await updateSnapshot(rootDir, config);
        if (result.status === "up-to-date" || result.status === "unchanged") {
          return; // Silent when called from hook
        }
        log.success(`Concept map ${result.status}: ${result.details}`);
      } catch {
        // Silent failure — don't break the user's commit flow
      }
    });

  program
    .command("analyze")
    .description("Analyze the codebase and print findings")
    .argument("[dir]", "Directory to analyze", ".")
    .action(async (dir: string) => {
      const rootDir = path.resolve(dir);
      const spinner = ora("Analyzing codebase...").start();

      const context = await buildContext(rootDir);
      const results = await runAll(context);

      spinner.stop();
      printFindings(results);

      const totalFindings = results.reduce(
        (sum, r) => sum + r.findings.length,
        0
      );
      console.log(
        chalk.bold(`\n${totalFindings} findings from ${results.length} analyzers`)
      );
    });

  program
    .command("mcp")
    .description("Start the MCP server (stdio transport)")
    .action(async () => {
      const { startMcpServer } = await import("./mcp/server.js");
      await startMcpServer();
    });

  return program;
}
