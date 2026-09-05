import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fixture, grade, auto, PROMPT, CONTROL_PROMPT } from "./automation/fixture.mjs";
import { runHost } from "./automation/session.mjs";

const { values } = parseArgs({ options: {
  validate: { type: "boolean" }, live: { type: "boolean" }, hosts: { type: "string", default: "claude,codex" },
  arms: { type: "string", default: "baseline,instructions,hooks" }, tasks: { type: "string", default: "rename,control" },
  model: { type: "string" }, "timeout-ms": { type: "string", default: "180000" }, "budget-usd": { type: "string", default: "1" },
  output: { type: "string" },
} });
if (!!values.validate === !!values.live) throw new Error("Select --validate (no models) or --live (real coding sessions).");
const hosts = values.hosts.split(","), arms = values.validate ? ["hooks"] : values.arms.split(","), tasks = values.tasks.split(",");
if (hosts.some(h => !["claude", "codex"].includes(h)) || arms.some(a => !["baseline", "instructions", "hooks"].includes(a)) || tasks.some(t => !["rename", "control"].includes(t))) throw new Error("Invalid hosts, arms, or tasks.");
const timeoutMs = Number(values["timeout-ms"]), budgetUsd = Number(values["budget-usd"]);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || !Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("Invalid limits.");
const binary = fileURLToPath(new URL("../../dist/mason-auto.js", import.meta.url));
await fs.access(binary);
const output = values.output ? path.resolve(values.output) : fileURLToPath(new URL("./results/automation/" + new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8), import.meta.url));
await fs.mkdir(output, { recursive: true });
console.log("Run: " + output);
console.log(values.validate ? "Deterministic lifecycle replay; no model calls. This does not measure spontaneous agent use." :
  `Real host sessions, ${timeoutMs / 1000}s timeout each. Claude budget $${budgetUsd}/session; Codex reports usage but has no enforced dollar cap. No automatic retries.`);
const rows = [];
const hostVersions = Object.fromEntries(hosts.map(host => {
  if (values.validate) return [host, "not-used"];
  try { return [host, execFileSync(host, ["--version"], { encoding: "utf8", timeout: 5000 }).trim()]; }
  catch { return [host, "unavailable"]; }
}));
const bundleSha256 = createHash("sha256").update(await fs.readFile(binary)).digest("hex");
for (const host of hosts) for (const task of tasks) for (const arm of arms) {
  const name = `${host}-${task}-${arm}`;
  const root = path.join(output, name);
  console.log("[" + name + "] running");
  const initial = await fixture(root, host, arm, binary);
  await fs.writeFile(path.join(output, name + "-initial.json"), JSON.stringify(initial, null, 2));
  let session;
  if (values.validate) {
    const fire = (event, toolId) => auto(binary, root, ["hook", "--host", host], {
      cwd: root, session_id: name, hook_event_name: event,
      ...(toolId ? { tool_name: toolId === "docs" && host === "codex" ? "apply_patch" : "Bash", tool_use_id: toolId } : {}),
    });
    fire("SessionStart");
    fire("PreToolUse", "source");
    if (task === "rename") {
      await fs.rename(path.join(root, "old-module"), path.join(root, "greeting-module"));
      await fs.writeFile(path.join(root, "app.mjs"), "import { greeting } from './greeting-module/index.mjs';\nconsole.log(greeting());\n");
    } else await fs.writeFile(path.join(root, "old-module/index.mjs"), "export function greeting() { return 'welcome'; }\n");
    fire("PostToolUse", "source");
    if (task === "rename") {
      fire("PreToolUse", "docs");
      for (const file of ["CLAUDE.md", "AGENTS.md"]) await fs.writeFile(path.join(root, file), (await fs.readFile(path.join(root, file), "utf8")).replaceAll("old-module", "greeting-module"));
      fire("PostToolUse", "docs");
    }
    fire("Stop");
    session = { ok: true, kind: "deterministic-replay", costUsd: 0 };
  } else session = await runHost({ host, arm, cwd: root, prompt: task === "rename" ? PROMPT : CONTROL_PROMPT,
    transcript: path.join(output, name + "-transcript.jsonl"), timeoutMs, budgetUsd, model: values.model });
  const evaluation = await grade(root, host, arm, binary, initial, task);
  rows.push({ host, task, arm, session, evaluation });
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ version: 1, mode: values.validate ? "replay" : "live", hostVersions, bundleSha256, rows }, null, 2));
  console.log(`[${name}] session=${session.ok ? "complete" : "failed"} evaluation=${evaluation.pass ? "pass" : "fail"} ${evaluation.failures.join("; ")}`);
}
const report = ["# Mason automation evaluation", "", values.validate ? "Deterministic replay only; not agent performance evidence." : "Live ordinary requests; no Mason-specific task prompt.", "",
  "| Host | Task | Arm | Session | Evaluation | Capture before edit | Continuations |", "|---|---|---|---|---|---|---|",
  ...rows.map(r => `| ${r.host} | ${r.task} | ${r.arm} | ${r.session.ok ? "complete" : "failed"} | ${r.evaluation.pass ? "pass" : "fail"} | ${r.evaluation.captureBeforeEdit ?? "not measured"} | ${r.evaluation.continuations} |`), "",
  "One run per cell is a smoke test, not an estimate of quality improvement or false-positive rate. Inspect report.json and transcripts for failures, costs, and actual hook activation.", "",
].join("\n");
await fs.writeFile(path.join(output, "report.md"), report);
console.log("Report: " + path.join(output, "report.md"));
process.exitCode = rows.every(r => r.session.ok && r.evaluation.pass) ? 0 : 1;
