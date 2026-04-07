import { Command } from "commander";
import path from "node:path";
import ora from "ora";
import chalk from "chalk";
import { runAll } from "./analyzers/index.js";
import { isGitRepo } from "./utils/git.js";
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
