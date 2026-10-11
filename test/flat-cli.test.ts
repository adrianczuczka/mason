import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const binary = path.resolve("dist/mason.js");

it("advertises top-level hook commands", async () => {
  const { stdout } = await exec(process.execPath, [binary, "--help"]);
  expect(stdout).toContain("install --host");
  expect(stdout).toContain("config ");
  expect(stdout).toContain("hook --host");
  expect(stdout).not.toMatch(/^ {2}auto\s/m);
});

it.each(["setup", "teardown", "status", "check", "stats", "install", "config", "hook"])(
  "keeps the auto %s alias equivalent",
  async (command) => {
    const direct = await exec(process.execPath, [binary, command, "--help"]);
    const legacy = await exec(process.execPath, [binary, "auto", command, "--help"]);
    expect(direct.stdout).toBe(legacy.stdout);
    expect(direct.stderr).toBe("");
    expect(direct.stdout).not.toContain("mason auto");
  },
);

it("generates shorter hook commands through top-level config", async () => {
  const { stdout } = await exec(process.execPath, [binary, "config", "--host", "claude"]);
  const config = JSON.parse(stdout);
  for (const groups of Object.values(config.hooks) as any[])
    for (const group of groups)
      expect(group.hooks[0].command).toBe(
        "npx --no-install --package mason-context mason hook --host claude",
      );
});

it("retains the standalone hook config entry point", async () => {
  const direct = await exec(process.execPath, [binary, "hook", "--print-config"]);
  const standalone = await exec(process.execPath, [
    path.resolve("dist/mason-hook.js"),
    "--print-config",
  ]);
  expect(direct.stdout).toBe(standalone.stdout);
});

it.each([["hook"], ["hook", "--host", "claude"], ["auto", "hook", "--host", "claude"]])(
  "keeps %j safe for invalid hook input",
  async (...args) => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [binary, ...args]);
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end("{invalid");
      },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    if (args.length === 1) expect(result.stdout).toBe("");
    else expect(JSON.parse(result.stdout).systemMessage).toContain("not valid JSON");
  },
);
