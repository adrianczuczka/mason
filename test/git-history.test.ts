import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHistoryAnalyzer } from "../src/analyzers/git-history.js";
import type { AnalyzerContext } from "../src/types.js";
import { fixturePath } from "./helpers.js";

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<void> {
  await exec("git", args, { cwd });
}

describe("git-history analyzer", () => {
  const analyzer = new GitHistoryAnalyzer();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-test-"));
    await git(["init"], tmpDir);
    await git(["config", "user.email", "test@test.com"], tmpDir);
    await git(["config", "user.name", "Test"], tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects conventional commit patterns", async () => {
    // Create commits with conventional format
    for (const msg of [
      "feat: add login",
      "fix: handle null email",
      "chore: update deps",
      "feat: add signup",
      "fix: validation error",
    ]) {
      await fs.writeFile(path.join(tmpDir, `${Date.now()}.txt`), msg);
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", msg], tmpDir);
    }

    const result = await analyzer.analyze({ rootDir: tmpDir, gitAvailable: true });
    const conventionalFinding = result.findings.find((f) =>
      f.summary.includes("conventional commit")
    );
    expect(conventionalFinding).toBeDefined();
    expect(conventionalFinding!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("detects ticket references in commits", async () => {
    for (const msg of [
      "JIRA-123 add feature",
      "JIRA-456 fix bug",
      "JIRA-789 update flow",
      "misc change",
    ]) {
      await fs.writeFile(path.join(tmpDir, `${Date.now()}.txt`), msg);
      await git(["add", "."], tmpDir);
      await git(["commit", "-m", msg], tmpDir);
    }

    const result = await analyzer.analyze({ rootDir: tmpDir, gitAvailable: true });
    const ticketFinding = result.findings.find((f) =>
      f.summary.includes("ticket")
    );
    expect(ticketFinding).toBeDefined();
  });

  it("handles non-git directory gracefully", async () => {
    const result = await analyzer.analyze({
      rootDir: fixturePath("empty"),
      gitAvailable: false,
    });
    expect(result.findings).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it("handles repo with no commits gracefully", async () => {
    // tmpDir has git init but no commits
    const result = await analyzer.analyze({
      rootDir: tmpDir,
      gitAvailable: true,
    });
    expect(result.findings).toEqual([]);
  });

  it("returns timing info", async () => {
    const result = await analyzer.analyze({
      rootDir: tmpDir,
      gitAvailable: true,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.analyzer).toBe("git-history");
  });
});
