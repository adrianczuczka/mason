import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import ora from "ora";
import chalk from "chalk";
import { runAll } from "./analyzers/index.js";
import { isGitRepo } from "./utils/git.js";
import { generateRules } from "./generator/rules.js";
import { renderClaude } from "./generator/renderer.js";
import { runConversation } from "./conversation/engine.js";
import { loadCache, saveCache, hashFinding } from "./cache.js";
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
    .name("mason")
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
    .option("--no-questions", "Skip interactive questions")
    .action(async (dir: string, opts: { questions: boolean }) => {
      const rootDir = path.resolve(dir);
      const spinner = ora("Analyzing codebase...").start();

      const context = await buildContext(rootDir);
      const results = await runAll(context);

      spinner.stop();
      printFindings(results);

      let answers = new Map<string, string>();
      if (opts.questions) {
        answers = await runConversation(results);
      }

      const rules = generateRules(results, answers);

      if (rules.length === 0) {
        log.warn("No rules generated — not enough patterns detected.");
        return;
      }

      const markdown = renderClaude(rules);
      const outPath = path.join(rootDir, "CLAUDE.md");
      await fs.writeFile(outPath, markdown, "utf-8");

      // Save cache for future updates
      const hashes = results.flatMap((r) =>
        r.findings.map((f) => hashFinding(f.summary, f.analyzer))
      );
      await saveCache(rootDir, answers, hashes);

      log.success(`Generated ${outPath} with ${rules.length} rules`);
    });

  program
    .command("update")
    .description("Re-analyze and update existing CLAUDE.md")
    .argument("[dir]", "Directory to analyze", ".")
    .option("--no-questions", "Skip interactive questions")
    .action(async (dir: string, opts: { questions: boolean }) => {
      const rootDir = path.resolve(dir);
      const cache = await loadCache(rootDir);

      const spinner = ora("Re-analyzing codebase...").start();

      const context = await buildContext(rootDir);
      context.previousAnswers = cache.answers;
      const results = await runAll(context);

      spinner.stop();

      // Identify new findings
      const currentHashes = results.flatMap((r) =>
        r.findings.map((f) => hashFinding(f.summary, f.analyzer))
      );
      const newFindings = currentHashes.filter(
        (h) => !cache.findingHashes.has(h)
      );
      const removedFindings = [...cache.findingHashes].filter(
        (h) => !currentHashes.includes(h)
      );

      if (newFindings.length === 0 && removedFindings.length === 0) {
        log.info("No changes detected since last run.");
        return;
      }

      if (newFindings.length > 0) {
        log.info(`${newFindings.length} new finding(s) detected`);
      }
      if (removedFindings.length > 0) {
        log.info(`${removedFindings.length} finding(s) no longer apply`);
      }

      printFindings(results);

      // Merge previous answers with new conversation
      let answers = new Map(cache.answers);
      if (opts.questions) {
        // Only ask about new gaps (filter out gaps already answered)
        const newAnswers = await runConversation(
          results.map((r) => ({
            ...r,
            gaps: r.gaps.filter((g) => !cache.answers.has(g.answerKey)),
          }))
        );
        for (const [key, val] of newAnswers) {
          answers.set(key, val);
        }
      }

      const rules = generateRules(results, answers);

      if (rules.length === 0) {
        log.warn("No rules generated — not enough patterns detected.");
        return;
      }

      const markdown = renderClaude(rules);
      const outPath = path.join(rootDir, "CLAUDE.md");
      await fs.writeFile(outPath, markdown, "utf-8");
      await saveCache(rootDir, answers, currentHashes);

      log.success(`Updated ${outPath} with ${rules.length} rules`);
    });

  return program;
}
