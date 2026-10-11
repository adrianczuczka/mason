// Transparent observation of synthetic fixtures; notes emits no context.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const [arm, binary, receipt] = process.argv.slice(2);
if (!["mason", "notes"].includes(arm)) throw new Error("Unknown arm");
const input = fs.readFileSync(0, "utf8"),
  request = JSON.parse(input);
const witness = () =>
  Object.fromEntries(
    ["operation.mjs", "greeting.txt", "managed.mjs"].map((file) => {
      const target = path.join(process.cwd(), file),
        stat = fs.lstatSync(target, { throwIfNoEntry: false });
      return [
        file,
        stat?.isFile() && !stat.isSymbolicLink()
          ? createHash("sha256").update(fs.readFileSync(target)).digest("hex")
          : null,
      ];
    }),
  );
const before = witness(),
  startedAt = new Date().toISOString();
const result =
  arm === "mason"
    ? spawnSync(process.execPath, [binary, "auto", "hook", "--host", "claude"], {
        input,
        encoding: "utf8",
        timeout: 35000,
        maxBuffer: 1024 * 1024,
      })
    : { status: 0, stdout: "", stderr: "" };
let output = null;
try {
  output = JSON.parse(result.stdout);
} catch {
  /* quiet */
}
fs.appendFileSync(
  receipt,
  JSON.stringify({
    arm,
    event: request.hook_event_name,
    tool: request.tool_name,
    toolId: request.tool_use_id,
    toolInput: request.tool_input,
    startedAt,
    completedAt: new Date().toISOString(),
    before,
    after: witness(),
    code: result.status,
    error: result.error?.message ?? null,
    output,
  }) + "\n",
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
