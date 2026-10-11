import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { checkOperation, referenceOperation } from "./knowledge/cancellation-check.mjs";
const { values } = parseArgs({ options: { output: { type: "string" } } });
const repo = fileURLToPath(new URL("../../", import.meta.url));
const out = path.resolve(
  values.output ??
    path.join(
      repo,
      ".mason/reports/cancellation-check-" + new Date().toISOString().replaceAll(":", "-"),
    ),
);
await fs.mkdir(out, { recursive: true });
const reportPath = path.join(out, "report.json");
await fs.writeFile(reportPath, "{}", { flag: "wx" });
const report = {
  version: 1,
  nodeVersion: process.version,
  source: {
    issue: "https://github.com/nodejs/node/issues/35990",
    correction: "https://github.com/nodejs/node/commit/aa1eb1fd597f68c6cb67c2a4d631a8d66f2cb94e",
    parent: "1a6d4dce6db09cb58cb77714cdcb28d84a7c7073",
  },
  fingerprint: createHash("sha256")
    .update(await fs.readFile(path.join(repo, "bench/harness/knowledge/cancellation-check.mjs")))
    .digest("hex"),
  rows: [],
  scope: "Deterministic constructed-transfer checker, not agent outcome or upstream execution.",
};
for (const mode of ["once-only", "finally-cleanup", "managed-dispose"])
  report.rows.push({ mode, ...(await checkOperation(referenceOperation(mode))) });
report.pass = report.rows.every((r) => r.pass === (r.mode !== "once-only"));
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    output: out,
    pass: report.pass,
    rows: report.rows.map((r) => ({ mode: r.mode, pass: r.pass, failures: r.failures })),
  }),
);
if (!report.pass) process.exitCode = 1;
