import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runDriftCli, formatDriftSummary } from "../src/drift/cli.js";
import type { DriftReport } from "../src/drift/drift.js";

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
}

const FRESH_REPORT: DriftReport = {
  stale: false,
  snapshotHash: "abc1234def",
  headHash: "abc1234def",
  commitsBehind: 0,
  historyAvailable: true,
  changedFiles: [],
  staleFeatures: {},
  staleFlows: {},
  totalFeatures: 2,
  totalFlows: 1,
  unmappedFiles: [],
  ghostFiles: [],
  renames: [],
  recommendation: "up-to-date",
};

describe("formatDriftSummary", () => {
  it("prints a one-liner when up to date", () => {
    expect(formatDriftSummary(FRESH_REPORT)).toBe(
      "Concept map is up to date against committed source (HEAD abc1234)."
    );
  });

  it("lists stale entries, unmapped and ghost files when stale", () => {
    const summary = formatDriftSummary({
      ...FRESH_REPORT,
      stale: true,
      commitsBehind: 3,
      changedFiles: ["src/a.ts"],
      staleFeatures: { auth: ["src/a.ts"] },
      unmappedFiles: ["src/new.ts"],
      ghostFiles: ["src/gone.ts"],
      recommendation: "incremental",
    });

    expect(summary).toMatch(/STALE — 3 commits behind HEAD/);
    expect(summary).toMatch(/Stale features \(1\/2\): auth/);
    expect(summary).toMatch(/Unmapped new files \(1\): src\/new\.ts/);
    expect(summary).toMatch(/Ghost files.*src\/gone\.ts/);
    expect(summary).toMatch(/Recommendation: incremental/);
  });
});

describe("runDriftCli", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-drift-cli-test-"));
    await git(["init"], tmpDir);
    await git(["config", "user.email", "test@test.com"], tmpDir);
    await git(["config", "user.name", "Test"], tmpDir);
    await fs.mkdir(path.join(tmpDir, "src"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function commitAll(message: string): Promise<string> {
    await git(["add", "."], tmpDir);
    await git(["commit", "-m", message], tmpDir);
    return git(["rev-parse", "HEAD"], tmpDir);
  }

  async function writeSnapshot(gitHash: string): Promise<void> {
    await fs.mkdir(path.join(tmpDir, ".mason"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".mason", "snapshot.json"),
      JSON.stringify({
        version: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        gitHash,
        features: { core: { description: "core", files: ["src/a.ts"] } },
        flows: {},
      })
    );
  }

  it("exits 0 and prints an up-to-date message when fresh", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    const hash = await commitAll("feat: add a");
    await writeSnapshot(hash);

    const { io, out } = captureIo();
    const code = await runDriftCli(["--dir", tmpDir], io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/up to date/);
  });

  it("exits 1 and prints the stale summary when drifted", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    const hash = await commitAll("feat: add a");
    await writeSnapshot(hash);
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 2;\n");
    await commitAll("fix: bump a");

    const { io, out } = captureIo();
    const code = await runDriftCli(["--dir", tmpDir], io);

    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/STALE/);
    expect(out.join("\n")).toMatch(/core/);
  });

  it("supports --json output", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    const hash = await commitAll("feat: add a");
    await writeSnapshot(hash);

    const { io, out } = captureIo();
    const code = await runDriftCli(["--dir", tmpDir, "--json"], io);

    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.stale).toBe(false);
    expect(report.recommendation).toBe("up-to-date");
  });

  it("--refresh-prompt emits provider-neutral scoped-refresh instructions when stale", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    const hash = await commitAll("feat: add a");
    await writeSnapshot(hash);
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 2;\n");
    await commitAll("fix: bump a");

    const { io, out } = captureIo();
    const code = await runDriftCli(["--dir", tmpDir, "--refresh-prompt"], io);

    expect(code).toBe(1);
    const prompt = out.join("\n");
    expect(prompt).toMatch(/Mason MCP tools/);
    expect(prompt).toMatch(/scoped refresh/);
    expect(prompt).toMatch(/"src\/a\.ts"/);
    expect(prompt).toMatch(/save_snapshot/);
    // Provider-neutral: no vendor CLI names in the prompt itself
    expect(prompt).not.toMatch(/claude -p|codex|gemini/i);
  });

  it("--refresh-prompt prints the up-to-date one-liner and exits 0 when fresh", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    const hash = await commitAll("feat: add a");
    await writeSnapshot(hash);

    const { io, out } = captureIo();
    const code = await runDriftCli(["--dir", tmpDir, "--refresh-prompt"], io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/up to date/);
  });

  it("rejects combining --json with --refresh-prompt", async () => {
    const { io, err } = captureIo();
    const code = await runDriftCli(
      ["--dir", tmpDir, "--json", "--refresh-prompt"],
      io
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/mutually exclusive/);
  });

  it("exits 2 when no snapshot exists", async () => {
    const { io, err } = captureIo();
    const code = await runDriftCli(["--dir", tmpDir], io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No Mason snapshot found/);
  });

  it("exits 2 when the directory is not a git repository", async () => {
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-nogit-"));
    try {
      await fs.mkdir(path.join(plainDir, ".mason"), { recursive: true });
      await fs.writeFile(
        path.join(plainDir, ".mason", "snapshot.json"),
        JSON.stringify({
          version: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          gitHash: "abc",
          features: {},
          flows: {},
        })
      );

      const { io, err } = captureIo();
      const code = await runDriftCli(["--dir", plainDir], io);

      expect(code).toBe(2);
      expect(err.join("\n")).toMatch(/git HEAD/);
    } finally {
      await fs.rm(plainDir, { recursive: true, force: true });
    }
  });

  it("exits 2 on unknown arguments and prints usage", async () => {
    const { io, err } = captureIo();
    const code = await runDriftCli(["--frobnicate"], io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/Unknown argument/);
    expect(err.join("\n")).toMatch(/Usage: mason-drift/);
  });

  it("prints usage on --help and exits 0", async () => {
    const { io, out } = captureIo();
    const code = await runDriftCli(["--help"], io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Exit codes/);
  });
});
