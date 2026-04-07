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

export function createCLI(): Command {
  const program = new Command();

  program
    .name("mason")
    .description(
      "Context engineering CLI & MCP server — generates intelligent CLAUDE.md files"
    )
    .version("0.1.0");

  program
    .command("set-llm")
    .description("Configure the LLM provider for standalone generation")
    .argument("<provider>", "LLM provider: claude, gemini, openai, or ollama")
    .argument("[api-key]", "API key (not needed for ollama)")
    .option("--model <model>", "Override the default model")
    .option("--ollama-host <host>", "Ollama server URL", "http://localhost:11434")
    .action(
      async (
        provider: string,
        apiKey: string | undefined,
        opts: { model?: string; ollamaHost?: string }
      ) => {
        const validProvider = validateProvider(provider);

        if (validProvider !== "ollama" && !apiKey) {
          log.error(`API key is required for ${validProvider}. Usage: mason set-llm ${validProvider} <api-key>`);
          process.exit(1);
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
        const markdown = await callLLM(runConfig, analysisData);

        if (!markdown.trim()) {
          spinner.stop();
          log.error("LLM returned empty response.");
          process.exit(1);
        }

        const outPath = path.join(rootDir, "CLAUDE.md");
        await fs.writeFile(outPath, markdown, "utf-8");
        spinner.stop();
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
