import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const PROMPT = "Rename the old-module directory to greeting-module and update the project to use it. Keep the behavior unchanged.";
export const CONTROL_PROMPT = "Change the greeting from hello to welcome. Keep the existing module organization.";
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export function auto(binary, cwd, args, input) {
  try {
    const output = execFileSync(process.execPath, [binary, ...args], { cwd, input: input ? JSON.stringify(input) : undefined, encoding: "utf8" });
    return output.trim() ? JSON.parse(output) : null;
  }
  catch (error) { if (error.stdout?.trim().startsWith("{")) return JSON.parse(error.stdout); throw error; }
}
export async function fixture(root, host, arm, binary) {
  await fs.mkdir(path.join(root, "old-module"), { recursive: true });
  await fs.writeFile(path.join(root, "old-module/index.mjs"), "export function greeting() { return 'hello'; }\n");
  await fs.writeFile(path.join(root, "app.mjs"), "import { greeting } from './old-module/index.mjs';\nconsole.log(greeting());\n");
  const doc = "# Greeting project\n\nThe `old-module/index.mjs` module exports greeting(). `app.mjs` prints its result.\nKeep the greeting API and executable behavior consistent. Run `node app.mjs` to check it.\n";
  const instructions = arm === "baseline" ? "" : "\nUse Mason to preserve audit evidence before changes and check it after changes. Resume existing evidence instead of discarding it. Command: `" + process.execPath + " " + binary + " check --json`. Report unavailable checks and outstanding advisories explicitly.\n";
  for (const file of ["CLAUDE.md", "AGENTS.md"]) await fs.writeFile(path.join(root, file), doc + instructions);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"greeting-fixture","type":"module"}\n');
  await fs.writeFile(path.join(root, ".gitignore"), ".mason/reports/\n");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Mason evaluation");
  git(root, "config", "user.email", "evaluation@example.invalid");
  if (arm === "hooks") auto(binary, root, ["install", "--host", host, "--command", quote(process.execPath) + " " + quote(binary)]);
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  const initialDocs = {};
  for (const file of ["CLAUDE.md", "AGENTS.md"]) initialDocs[file] = digest(await fs.readFile(path.join(root, file), "utf8"));
  const protectedFiles = {};
  for (const file of [".gitignore", ".claude/settings.json", ".codex/hooks.json", ".mason/automation.json"]) {
    try { protectedFiles[file] = await fs.readFile(path.join(root, file), "utf8"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return { head: git(root, "rev-parse", "HEAD"), initialDocs, protectedFiles };
}

export async function grade(root, host, arm, binary, initial, task = "rename") {
  const failures = [];
  const expectedDir = task === "rename" ? "greeting-module" : "old-module";
  const expectedGreeting = task === "rename" ? "hello" : "welcome";
  try {
    await fs.access(path.join(root, expectedDir, "index.mjs"));
    if (task === "rename") {
      try { await fs.access(path.join(root, "old-module")); failures.push("old module still exists"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    if (execFileSync(process.execPath, ["app.mjs"], { cwd: root, encoding: "utf8", timeout: 10000 }).trim() !== expectedGreeting) failures.push("behavior changed incorrectly");
  } catch { failures.push("module or executable behavior is invalid"); }
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const text = await fs.readFile(path.join(root, file), "utf8").catch(() => "");
    if (!text.includes(expectedDir + "/index.mjs") || !text.includes("greeting()") || !text.includes("node app.mjs")) failures.push(file + " lost or missed documentation");
    if (task === "rename" && text.includes("old-module")) failures.push(file + " still names old module");
  }
  for (const [file, text] of Object.entries(initial.protectedFiles)) {
    if (await fs.readFile(path.join(root, file), "utf8").catch(() => null) !== text) failures.push("protected integration changed: " + file);
  }
  const status = auto(binary, root, ["status"]);
  let captureBeforeEdit = null, observedEvents = [], continuations = 0;
  if (arm === "hooks") {
    observedEvents = status.hosts?.[host]?.observedEvents ?? [];
    if (!["session_start", "before_tool", "after_tool", "task_end"].every(e => observedEvents.includes(e))) failures.push("required host lifecycle events were not observed");
    if (status.reportPath) {
      const state = JSON.parse(await fs.readFile(path.join(root, path.dirname(path.dirname(status.reportPath)), "state.json"), "utf8"));
      captureBeforeEdit = Object.values(state.sessions).some(s => s.host === host && Object.entries(initial.initialDocs).every(([file, sum]) => s.initialDocs[file] === sum));
      continuations = Object.values(state.sessions).filter(s => s.continued).length;
    }
    if (!captureBeforeEdit) failures.push("original documentation capture was not established");
    if (task === "control" && continuations) failures.push("irrelevant continuation on the control task");
  }
  // This commit is performed by the grader after agent completion, not by an evaluation prompt.
  git(root, "add", ".");
  git(root, "commit", "--allow-empty", "-m", "evaluate final patch");
  const final = arm === "baseline" ? null : auto(binary, root, ["check", "--json"]);
  if (final && final.status !== "verified") failures.push("final committed evidence is " + final.status);
  return { pass: !failures.length, failures, captureBeforeEdit, observedEvents, continuations,
    finalVerification: final?.status ?? "not-requested", finalReport: final?.reportPath ?? null };
}
