import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitAll, git, initGitRepo } from "./helpers.js";

const execute = promisify(execFile);
let root: string, runner: string;
const flagged = "packages/client [sample]/README.md";
const baseline = ".mason/reports/original.json";
const write = async (file: string, value: string) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), value);
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-workflow-"));
  runner = await fs.mkdtemp(path.join(os.tmpdir(), "mason-workflow-runner-"));
  await initGitRepo(root);
  await write(flagged, "Before\n"); await write("AGENTS.md", "Existing\n"); await write("source.ts", "export {};\n");
  await commitAll(root, "initial");
  await fs.writeFile(path.join(runner, "audit.json"), JSON.stringify({ docs: [{ path: flagged }, { path: "AGENTS.md" }],
    issues: [{ anchor: { doc: flagged } }] }));
  await write(flagged, "Repaired\n"); await write(baseline, "{}\n");
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(runner, { recursive: true, force: true }); });
async function scripts() {
  const workflow = await fs.readFile(new URL("../.github/workflows/mason-audit.yml", import.meta.url), "utf8");
  return [...workflow.matchAll(/          node --input-type=module <<'NODE'\n([\s\S]*?)          NODE/g)]
    .map(match => match[1].split("\n").map(line => line.replace(/^          /, "")).join("\n"));
}
async function run(script: string) {
  return execute(process.execPath, ["--input-type=module", "-e", script], { cwd: root,
    env: { ...process.env, RUNNER_TEMP: runner, MASON_REPAIR_BASELINE: baseline } });
}

it("allows and stages only flagged nested docs using literal Git paths", async () => {
  const [guard, stage] = await scripts();
  await run(guard); await run(stage);
  expect(await git(["diff", "--cached", "--name-only"], root)).toBe(flagged);
  expect(await git(["diff", "--cached", "--name-only", "--", baseline], root)).toBe("");
});
it.each(["source.ts", "AGENTS.md"])("rejects changes outside the flagged document scope: %s", async file => {
  await write(file, "Unrelated edit\n");
  await expect(run((await scripts())[0])).rejects.toThrow();
  expect(await git(["diff", "--cached", "--name-only"], root)).toBe("");
});
