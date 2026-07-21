#!/usr/bin/env node
/**
 * Mason agentic benchmark runner.
 *
 * Drives real headless Claude Code sessions in two arms per question:
 *   baseline — CLAUDE.md only, no MCP servers
 *   mason    — CLAUDE.md + Mason MCP (snapshot pre-built at the pinned commit)
 *
 * Usage:
 *   node run.mjs --repo mason-self [--arms baseline,mason] [--questions id1,id2]
 *                [--model sonnet] [--judge-model haiku] [--k 5]
 *                [--checkout <commit>]   # stale-map scenario: move HEAD after snapshot
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runSession } from "./lib/session.mjs";
import { judgeAnswer } from "./lib/judge.mjs";
import { relativizeReads, firstActionPrecision, groundTruthRecall } from "./lib/metrics.mjs";
import { ensureClone, ensureClaudeMd, ensureSnapshot } from "./lib/setup.mjs";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MASON_ROOT = path.resolve(HARNESS_DIR, "..", "..");

function parseArgs(argv) {
  const args = { arms: ["baseline", "mason"], model: "sonnet", judgeModel: "haiku", k: 5 };
  for (let i = 2; i < argv.length; i++) {
    const [flag, next] = [argv[i], argv[i + 1]];
    if (flag === "--repo") args.repo = next, i++;
    else if (flag === "--arms") args.arms = next.split(","), i++;
    else if (flag === "--questions") args.questions = next.split(","), i++;
    else if (flag === "--model") args.model = next, i++;
    else if (flag === "--judge-model") args.judgeModel = next, i++;
    else if (flag === "--k") args.k = Number(next), i++;
    else if (flag === "--checkout") args.checkout = next, i++;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.repo) throw new Error("--repo is required");
  return args;
}

const SYSTEM_PROMPT =
  "Answer the user's question about this codebase. This is a read-only task: " +
  "do not create, modify, or delete any files. Do not launch background tasks " +
  "or defer work — your final message must contain the complete answer. Give " +
  "a complete, specific answer that names actual file paths.";

async function main() {
  const args = parseArgs(process.argv);
  const configPath = path.join(HARNESS_DIR, "repos", `${args.repo}.json`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const clonesDir = path.join(HARNESS_DIR, ".clones");
  const repoDir = ensureClone(config, clonesDir);
  console.log(`repo: ${config.name} @ ${config.commit?.slice(0, 8) ?? "HEAD"} → ${repoDir}`);

  const masonMcpConfig = {
    mcpServers: {
      mason: { command: "node", args: [path.join(MASON_ROOT, "dist", "mason-mcp.js")] },
    },
  };

  const setup = {};
  const claudeMd = await ensureClaudeMd(repoDir, args.model);
  setup.claudeMd = claudeMd;
  if (claudeMd.generated) console.log(`generated CLAUDE.md ($${claudeMd.costUsd?.toFixed(2)})`);

  if (args.arms.includes("mason")) {
    const snap = await ensureSnapshot(repoDir, masonMcpConfig, args.model);
    setup.snapshot = snap;
    if (snap.generated) {
      console.log(
        `built snapshot: $${snap.costUsd?.toFixed(2)}, ${snap.numTurns} turns, ${Math.round(snap.durationMs / 1000)}s`
      );
    }
  }

  if (args.checkout) {
    execFileSync("git", ["checkout", "--quiet", args.checkout], { cwd: repoDir });
    console.log(`stale scenario: HEAD moved to ${args.checkout.slice(0, 8)} (snapshot unchanged)`);
  }

  const questions = config.questions.filter(
    (q) => !args.questions || args.questions.includes(q.id)
  );

  const results = [];
  for (const q of questions) {
    for (const arm of args.arms) {
      console.log(`\n[${q.id} / ${arm}] running...`);
      const session = await runSession({
        cwd: repoDir,
        prompt: q.question,
        mcpConfig: arm === "mason" ? masonMcpConfig : { mcpServers: {} },
        model: args.model,
        systemPrompt: SYSTEM_PROMPT,
      });
      const reads = relativizeReads(session.readFiles, repoDir);
      const verdict = await judgeAnswer({
        question: q.question,
        criteria: q.criteria,
        answer: session.resultText,
        model: args.judgeModel,
      });
      const row = {
        question: q.id,
        category: q.category,
        arm,
        ok: session.ok,
        quality: verdict.score,
        qualityRationale: verdict.rationale,
        costUsd: session.costUsd,
        numTurns: session.numTurns,
        durationMs: session.durationMs,
        usage: session.usage,
        toolCallCount: session.toolCalls.length,
        mcpCalls: session.mcpCalls,
        reads,
        firstActionPrecision: firstActionPrecision(reads, q.groundTruth, args.k),
        groundTruthRecall: groundTruthRecall(reads, q.groundTruth, args.k),
        answer: session.resultText,
      };
      results.push(row);
      console.log(
        `  quality ${row.quality}/10 · $${row.costUsd?.toFixed(3)} · ${row.numTurns} turns · ` +
          `precision@${args.k} ${row.firstActionPrecision === null ? "n/a (0 reads)" : row.firstActionPrecision.toFixed(2)} · ` +
          `mason calls ${row.mcpCalls.length}`
      );
    }
  }

  const resultsDir = path.join(HARNESS_DIR, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `${stamp}-${config.name}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ config: config.name, commit: config.commit, args, setup, results }, null, 2)
  );

  printSummary(results, args.k);
  console.log(`\nfull results: ${outPath}`);
}

function fmt(v, digits = 2) {
  return v === null || v === undefined ? "—" : typeof v === "number" ? v.toFixed(digits) : v;
}

function printSummary(results, k) {
  console.log("\n| question | arm | quality | cost $ | turns | tool calls | precision@" + k + " | recall@" + k + " | mason calls |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.question} | ${r.arm} | ${fmt(r.quality, 1)} | ${fmt(r.costUsd, 3)} | ${r.numTurns} | ${r.toolCallCount} | ${fmt(r.firstActionPrecision)} | ${fmt(r.groundTruthRecall)} | ${r.mcpCalls.length} |`
    );
  }
  for (const arm of [...new Set(results.map((r) => r.arm))]) {
    const rows = results.filter((r) => r.arm === arm);
    const avg = (sel) => {
      const vals = rows.map(sel).filter((v) => typeof v === "number");
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    console.log(
      `| **avg** | ${arm} | ${fmt(avg((r) => r.quality), 1)} | ${fmt(avg((r) => r.costUsd), 3)} | ${fmt(avg((r) => r.numTurns), 1)} | ${fmt(avg((r) => r.toolCallCount), 1)} | ${fmt(avg((r) => r.firstActionPrecision))} | ${fmt(avg((r) => r.groundTruthRecall))} | |`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
