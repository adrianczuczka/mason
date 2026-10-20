import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitAll, git, initGitRepo } from "./helpers.js";
import { loadDecisions, upsertDecision } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { MERGE_ATTRIBUTE, mergeDecisionRecords } from "../src/decisions/merge.js";
import {
  ancillaryEdits,
  configureDecisionMerge,
  decisionMergeStatus,
} from "../src/setup/config.js";
import { applyEdit } from "../src/setup/files.js";

const exec = promisify(execFile);
const binary = path.resolve("dist/mason.js");
let temp: string, root: string, shims: string, id: string;
const record = () => path.join(root, `.mason/decisions/${id}.json`);
const read = () => fs.readFile(record(), "utf8");
const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text);

async function inspect(note: string) {
  const prepared = await reviewDecision(root, { id });
  const result = await reviewDecision(root, {
    id,
    action: "inspect",
    inspector: "Fixture agent",
    note,
    reviewToken: prepared.reviewToken,
  });
  expect(result.status).toBe("inspected");
}
async function accept() {
  const prepared = await reviewDecision(root, { id });
  const result = await reviewDecision(root, {
    id,
    action: "accept",
    reviewer: "Fixture reviewer",
    note: "Reviewed the bounded retry implementation.",
    reviewToken: prepared.reviewToken,
  });
  expect(result.status).toBe("accepted");
}
/** Run Git with or without `mason` on PATH, as the configured driver sees it. */
const gitWith = (args: string[], withMason: boolean) =>
  exec("git", args, {
    cwd: root,
    env: {
      ...process.env,
      PATH: (withMason ? shims + path.delimiter : "") + process.env.PATH,
    },
  });

beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-merge-")));
  root = path.join(temp, "project");
  shims = path.join(temp, "bin");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(shims);
  await fs.writeFile(
    path.join(shims, "mason"),
    `#!/bin/sh\nexec "${process.execPath}" "${binary}" "$@"\n`,
    { mode: 0o755 },
  );
  await initGitRepo(root);
  await write("src/client.ts", "export const retries = 1;\n");
  await write("src/queue.ts", "export const queue = 1;\n");
  for (const edit of await ancillaryEdits(root)) await applyEdit(root, edit);
  await upsertDecision(root, {
    title: "Keep retries bounded",
    body: "The retry count must remain bounded.",
    category: "decision",
    files: ["src/client.ts"],
    owner: "Client team",
    sources: [{ kind: "document", reference: "src/client.ts" }],
  });
  id = (await loadDecisions(root))[0].id;
  await commitAll(root, "initial");
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

/** The issue's case: each side inspects, and one side also accepts. */
async function divergeWithInspectionsAndAcceptance() {
  await git(["checkout", "-b", "reviewed"], root);
  await write("src/client.ts", "export const retries = 2;\n");
  await commitAll(root, "bounded change");
  await inspect("Reviewed side: the limit still holds.");
  await accept();
  await commitAll(root, "accept");
  await git(["checkout", "-b", "stacked", "main"], root);
  await write("src/queue.ts", "export const queue = 2;\n");
  await inspect("Stacked side: no contradiction.");
  await commitAll(root, "inspect on stacked branch");
}

describe("decision record merge driver", { timeout: 60000 }, () => {
  it("rebases a stacked branch without conflicts when both sides inspect and one accepts", async () => {
    await divergeWithInspectionsAndAcceptance();
    // Without the driver, Git's text merge conflicts inside the JSON.
    await expect(gitWith(["rebase", "reviewed"], true)).rejects.toThrow();
    await git(["rebase", "--abort"], root);

    expect(await configureDecisionMerge(root)).toEqual({ attribute: true, driver: "configured" });
    await gitWith(["rebase", "reviewed"], true);
    const [merged] = await loadDecisions(root);
    expect(merged).toMatchObject({ approval: "accepted" });
    expect(merged.version === 2 && merged.inspections?.map((entry) => entry.note)).toEqual([
      "Reviewed side: the limit still holds.",
      "Stacked side: no contradiction.",
    ]);
    expect(await read()).toBe(JSON.stringify(merged, null, 2) + "\n");
    expect(await fs.readFile(path.join(root, "src/client.ts"), "utf8")).toContain("retries = 2");
  });

  it("falls back to Git's text conflict when Mason is unavailable or refuses", async () => {
    await configureDecisionMerge(root);
    await divergeWithInspectionsAndAcceptance();
    await expect(gitWith(["rebase", "reviewed"], false)).rejects.toThrow();
    expect(await read()).toMatch(/^<<<<<<< ours$/m);
    await git(["rebase", "--abort"], root);

    // Two acceptances are a real conflict for a person to resolve.
    await git(["checkout", "stacked"], root);
    await write("src/client.ts", "export const retries = 2;\n");
    await commitAll(root, "same bounded change");
    await accept();
    await commitAll(root, "second acceptance");
    const refused = gitWith(["rebase", "reviewed"], true);
    await expect(refused).rejects.toMatchObject({
      stderr: expect.stringContaining(`.mason/decisions/${id}.json: both sides changed`),
    });
    expect(await read()).toMatch(/^>>>>>>> theirs$/m);
  });

  it("merges symmetrically, removes duplicate entries and rejects rewritten history", async () => {
    const base = await read();
    await inspect("Shared inspection.");
    const shared = await read();
    await inspect("Current side.");
    const current = await read();
    await write(`.mason/decisions/${id}.json`, shared);
    await inspect("Incoming side.");
    const incoming = await read();

    const forward = mergeDecisionRecords(base, current, incoming, id);
    expect(forward).toEqual(mergeDecisionRecords(base, incoming, current, id));
    expect(forward.status).toBe("merged");
    const notes = (
      JSON.parse((forward as { text: string }).text) as {
        inspections: Array<{ note: string }>;
      }
    ).inspections.map((entry) => entry.note);
    expect(notes).toEqual(["Shared inspection.", "Current side.", "Incoming side."]);

    const rewritten = JSON.parse(current) as { inspections: unknown[] };
    rewritten.inspections.shift();
    expect(mergeDecisionRecords(shared, JSON.stringify(rewritten), incoming)).toMatchObject({
      status: "conflict",
      reason: expect.stringContaining("inspections"),
    });
    expect(mergeDecisionRecords(base, current, incoming, "another-id")).toMatchObject({
      status: "conflict",
    });
    expect(mergeDecisionRecords(base, "{", incoming)).toMatchObject({ status: "conflict" });
  });

  it("reports the shared attribute separately from local driver configuration", async () => {
    expect(await fs.readFile(path.join(root, ".gitattributes"), "utf8")).toContain(MERGE_ATTRIBUTE);
    expect(await decisionMergeStatus(root)).toEqual({ attribute: true, driver: "missing" });
    await git(["config", "merge.mason-decision.driver", "custom-merge %O %A %B"], root);
    // A customized driver is reported and left in place.
    expect(await configureDecisionMerge(root)).toEqual({ attribute: true, driver: "custom" });
    expect(await git(["config", "merge.mason-decision.driver"], root)).toBe(
      "custom-merge %O %A %B",
    );
  });
});
