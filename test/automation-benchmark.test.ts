import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const harness = fileURLToPath(new URL("../bench/harness/run-automation.mjs", import.meta.url));
it("replays both real adapter binaries through protected grading and final committed verification without models", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "mason-auto-bench-"));
  try {
    await exec(process.execPath, [harness, "--validate", "--output", output], { timeout: 60000 });
    const report = JSON.parse(await fs.readFile(path.join(output, "report.json"), "utf8"));
    expect(report.mode).toBe("replay");
    expect(report.rows).toHaveLength(4);
    for (const row of report.rows) {
      expect(row.session.kind).toBe("deterministic-replay");
      expect(row.evaluation).toMatchObject({ pass: true, captureBeforeEdit: true, continuations: 0, finalVerification: "verified" });
    }
  } finally { await fs.rm(output, { recursive: true, force: true }); }
}, 65000);

it("does not wait for stdin when hook help is requested", async () => {
  const { spawn } = await import("node:child_process");
  const binary = fileURLToPath(new URL("../dist/mason-auto.js", import.meta.url));
  const child = spawn(process.execPath, [binary, "hook", "--help"], { stdio: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  const code = await new Promise(resolve => child.once("close", resolve));
  clearTimeout(timer);
  expect(code).toBe(0);
});
