import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commitAll, git, initGitRepo } from "./helpers.js";
import { loadDecisions, upsertDecision } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { branchAttribution } from "../src/decisions/attribution.js";
import { runAutomationHook } from "../src/automation/adapters.js";
import { automationStatus, type AutomationReport } from "../src/automation/runtime.js";

let root: string;
let upstreamId: string, branchId: string;
const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text);
const hook = (name: string, session = "s") =>
  runAutomationHook(
    "claude",
    JSON.stringify({ cwd: root, session_id: session, hook_event_name: name }),
  );
const message = (output: Awaited<ReturnType<typeof hook>>) => JSON.stringify(output ?? {});
async function latestReport(): Promise<AutomationReport> {
  const status = await automationStatus(root);
  return JSON.parse(await fs.readFile(path.join(root, status.reportPath!), "utf8"));
}
const findingIds = (report: AutomationReport) =>
  report.findings.flatMap((finding) => {
    const evidence = (finding.current ?? finding.original).evidence;
    return evidence.kind === "decision-anchor" && finding.status !== "resolved"
      ? [evidence.decisionId]
      : [];
  });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-attribution-"));
  await initGitRepo(root);
  await fs.mkdir(path.join(root, "src"));
  await write(".gitignore", ".mason/reports/\n");
  await write("src/payments.ts", "export const retries = 1;\n");
  await write("src/client.ts", "export const timeout = 1;\n");
  await write("ci.yml", "jobs: {}\n");
  await commitAll(root, "initial");
  for (const [title, file] of [
    ["Bound payment retries", "src/payments.ts"],
    ["Keep client timeouts short", "src/client.ts"],
  ])
    await upsertDecision(root, { title, body: `${title}.`, category: "decision", files: [file] });
  const records = await loadDecisions(root);
  upstreamId = records.find((record) => record.files[0] === "src/payments.ts")!.id;
  branchId = records.find((record) => record.files[0] === "src/client.ts")!.id;
  await commitAll(root, "decisions");

  // The branch edits CI and the client; main changes payments; the branch is then rebased.
  await git(["checkout", "-b", "feature"], root);
  await write("ci.yml", "jobs: { test: {} }\n");
  await commitAll(root, "ci");
  await write("src/client.ts", "export const timeout = 2;\n");
  await commitAll(root, "client timeout");
  await git(["checkout", "main"], root);
  await write("src/payments.ts", "export const retries = 3;\n");
  await commitAll(root, "main changes payments");
  await git(["checkout", "feature"], root);
  await git(["rebase", "main"], root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("decision drift attribution", { timeout: 60000 }, () => {
  it("keeps branch drift as work and reports target-only drift once, separately", async () => {
    const first = await hook("SessionStart");
    expect(message(first)).toContain("only by main since this branch's merge-base");
    expect(message(first)).toContain(upstreamId);
    const report = await latestReport();
    expect(findingIds(report)).toEqual([branchId]);
    expect(report.upstreamDrift).toMatchObject({
      target: "main",
      decisions: [{ id: upstreamId, changedFiles: ["src/payments.ts"] }],
    });

    // Not repeated in the same session, and never part of a Stop block.
    expect(message(await hook("UserPromptSubmit"))).not.toContain("only by main");
    expect(message(await hook("Stop"))).not.toContain(upstreamId);
  });

  it("attributes changed files in review previews", async () => {
    const upstream = await reviewDecision(root, { id: upstreamId });
    expect(upstream.previews.attribution).toMatchObject({
      target: "main",
      branchFiles: [],
      targetFiles: ["src/payments.ts"],
    });
    const own = await reviewDecision(root, { id: branchId });
    expect(own.previews.attribution).toMatchObject({
      branchFiles: ["src/client.ts"],
      targetFiles: [],
    });
    // Uncommitted work on a target-only anchor makes it this branch's drift.
    await write("src/payments.ts", "export const retries = 4;\n");
    expect((await branchAttribution(root))?.branchFiles.has("src/payments.ts")).toBe(true);
  });

  it("reports drift as before on the default branch itself", async () => {
    await git(["checkout", "main"], root);
    expect(await branchAttribution(root)).toBeNull();
    await hook("SessionStart");
    const report = await latestReport();
    expect(findingIds(report)).toEqual([upstreamId]);
    expect(report.upstreamDrift).toBeUndefined();
  });
});
