import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import ora from "ora";
import chalk from "chalk";
import { runAll } from "./analyzers/index.js";
import { isGitRepo } from "./utils/git.js";
import { generateRules } from "./generator/rules.js";
import { renderClaude } from "./generator/renderer.js";
import * as log from "./utils/logger.js";
import type { AnalyzerContext } from "./types.js";

async function buildContext(dir: string): Promise<AnalyzerContext> {
  let packageJson: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf-8");
    packageJson = JSON.parse(raw);
  } catch {
    // No package.json
  }

  return {
    rootDir: dir,
    packageJson,
    gitAvailable: await isGitRepo(dir),
    previousAnswers: new Map(),
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
    .name("foreman")
    .description(
      "Context engineering CLI — generates intelligent CLAUDE.md files"
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
    .command("init")
    .description("Analyze codebase and generate CLAUDE.md")
    .argument("[dir]", "Directory to analyze", ".")
    .action(async (dir: string) => {
      const rootDir = path.resolve(dir);
      const spinner = ora("Analyzing codebase...").start();

      const context = await buildContext(rootDir);
      const results = await runAll(context);

      spinner.stop();
      printFindings(results);

      // TODO: Phase 7 — conversation engine for gaps
      const answers = new Map<string, string>();
      const rules = generateRules(results, answers);

      if (rules.length === 0) {
        log.warn("No rules generated — not enough patterns detected.");
        return;
      }

      const markdown = renderClaude(rules);
      const outPath = path.join(rootDir, "CLAUDE.md");
      await fs.writeFile(outPath, markdown, "utf-8");
      log.success(`Generated ${outPath} with ${rules.length} rules`);
    });

  program
    .command("update")
    .description("Re-analyze and update existing CLAUDE.md")
    .argument("[dir]", "Directory to analyze", ".")
    .action(async (_dir: string) => {
      log.warn("Update command not yet implemented — use `foreman init` for now.");
    });

  return program;
}
