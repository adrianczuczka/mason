import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { computeReview } from "../src/review/review.js";
import { runReviewCli } from "../src/review/cli.js";
import { git, commitAll, initGitRepo } from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-review-test-"));
  await initGitRepo(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

/** Commit a+b together `n` times so they become co-change partners. */
async function coupleHistory(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await write("src/a.ts", `export const a = ${i};\n`);
    await write("src/b.ts", `export const b = ${i};\n`);
    await commitAll(tmpDir, `feat: change a and b (${i})`);
  }
}

async function branchAndChange(files: Record<string, string>): Promise<void> {
  await git(["checkout", "-b", "feature"], tmpDir);
  for (const [rel, content] of Object.entries(files)) {
    await write(rel, content);
  }
  await commitAll(tmpDir, "feat: feature change");
}

describe("computeReview", () => {
  it("flags a historical partner the diff leaves untouched", async () => {
    await coupleHistory(5);
    await branchAndChange({ "src/a.ts": "export const a = 99;\n" });

    const report = await computeReview(tmpDir, "main");
    expect(report).not.toBeNull();
    expect(report!.changedFiles).toEqual(["src/a.ts"]);
    expect(report!.missingPartners).toHaveLength(1);
    const finding = report!.missingPartners[0];
    expect(finding.missingPartner).toBe("src/b.ts");
    expect(finding.sharedCommits).toBe(5);
    expect(finding.rate).toBeGreaterThanOrEqual(0.6);
  });

  it("stays quiet when the partner is in the diff", async () => {
    await coupleHistory(5);
    await branchAndChange({
      "src/a.ts": "export const a = 99;\n",
      "src/b.ts": "export const b = 99;\n",
    });

    const report = await computeReview(tmpDir, "main");
    expect(report!.missingPartners).toEqual([]);
  });

  it("stays quiet below the rate threshold", async () => {
    // 6 solo commits of a, then 4 coupled: rate 4/11 after the feature commit.
    for (let i = 0; i < 6; i++) {
      await write("src/a.ts", `export const a = ${i};\n`);
      await commitAll(tmpDir, `feat: a alone (${i})`);
    }
    await coupleHistory(4);
    await branchAndChange({ "src/a.ts": "export const a = 99;\n" });

    const report = await computeReview(tmpDir, "main");
    expect(report!.missingPartners).toEqual([]);
  });

  it("skips partners that no longer exist on disk", async () => {
    await coupleHistory(5);
    await git(["rm", "-q", "src/b.ts"], tmpDir);
    await commitAll(tmpDir, "chore: drop b");
    await branchAndChange({ "src/a.ts": "export const a = 99;\n" });

    const report = await computeReview(tmpDir, "main");
    expect(report!.missingPartners).toEqual([]);
  });

  it("lists decisions whose anchors the diff touches", async () => {
    await write("src/lonely.ts", "export const l = 1;\n");
    await write(
      ".mason/decisions/lonely-constraint.json",
      JSON.stringify({
        version: 1,
        id: "lonely-constraint",
        title: "Lonely has a constraint",
        body: "Never make it plural.",
        category: "convention",
        files: ["src/lonely.ts"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        refreshedHash: "unknown",
        status: "active",
      })
    );
    await commitAll(tmpDir, "init");
    await branchAndChange({ "src/lonely.ts": "export const l = 2;\n" });

    const report = await computeReview(tmpDir, "main");
    expect(report!.missingPartners).toEqual([]);
    expect(report!.touchedDecisions).toHaveLength(1);
    expect(report!.touchedDecisions[0].id).toBe("lonely-constraint");
    expect(report!.touchedDecisions[0].touchedFiles).toEqual(["src/lonely.ts"]);
  });

  it("returns null for an unresolvable base", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await commitAll(tmpDir, "init");
    expect(await computeReview(tmpDir, "no-such-ref")).toBeNull();
  });
});

describe("runReviewCli", () => {
  it("exits 1 with a summary when a partner is missing", async () => {
    await coupleHistory(5);
    await branchAndChange({ "src/a.ts": "export const a = 99;\n" });

    const out: string[] = [];
    const code = await runReviewCli(
      ["--dir", tmpDir, "--base", "main"],
      { out: (l) => out.push(l), err: () => {} }
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("src/b.ts");
    expect(out.join("\n")).toContain("missing-partner");
  });

  it("exits 0 when only decisions are touched, and emits the JSON contract", async () => {
    await write("src/lonely.ts", "export const l = 1;\n");
    await commitAll(tmpDir, "init");
    await branchAndChange({ "src/lonely.ts": "export const l = 2;\n" });

    const out: string[] = [];
    const code = await runReviewCli(
      ["--dir", tmpDir, "--base", "main", "--json"],
      { out: (l) => out.push(l), err: () => {} }
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.version).toBe(1);
    for (const key of [
      "base",
      "mergeBase",
      "changedFiles",
      "missingPartners",
      "touchedDecisions",
      "historyAvailable",
      "truncated",
    ]) {
      expect(report).toHaveProperty(key);
    }
  });

  it("exits 2 on an unknown base ref", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await commitAll(tmpDir, "init");
    const err: string[] = [];
    const code = await runReviewCli(
      ["--dir", tmpDir, "--base", "no-such-ref"],
      { out: () => {}, err: (l) => err.push(l) }
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("merge base");
  });
});
