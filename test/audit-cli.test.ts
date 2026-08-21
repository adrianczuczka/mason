import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runAuditCli } from "../src/audit/cli.js";
import type { AuditCliIo } from "../src/audit/cli.js";
import { commitAll, initGitRepo } from "./helpers.js";

let tmpDir: string;
let out: string[];
let err: string[];
let io: AuditCliIo;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-audit-cli-test-"));
  await initGitRepo(tmpDir);
  out = [];
  err = [];
  io = { out: (l) => out.push(l), err: (l) => err.push(l) };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

/** A repo whose CLAUDE.md references a file that was then deleted. */
async function seedStaleRepo(): Promise<void> {
  await write("src/logger.ts", "export const log = 1;\n");
  await write("src/kept.ts", "export const kept = 1;\n");
  await write("CLAUDE.md", "Logging is in `src/logger.ts`. The src dir.\n");
  await commitAll(tmpDir, "init");
  await fs.rm(path.join(tmpDir, "src", "logger.ts"));
  await commitAll(tmpDir, "chore: drop logger");
}

describe("runAuditCli: argument handling", () => {
  it("prints usage on --help and exits 0", async () => {
    expect(await runAuditCli(["--help"], io)).toBe(0);
    expect(out.join("\n")).toContain("Usage: mason-audit");
  });

  it("rejects unknown arguments with exit 2", async () => {
    expect(await runAuditCli(["--bogus"], io)).toBe(2);
    expect(err.join("\n")).toContain("Unknown argument");
  });

  it("rejects --json with --fix-prompt", async () => {
    expect(await runAuditCli(["--json", "--fix-prompt"], io)).toBe(2);
    expect(err.join("\n")).toContain("mutually exclusive");
  });

  it("rejects an unknown check name", async () => {
    expect(await runAuditCli(["--checks", "nonsense"], io)).toBe(2);
    expect(err.join("\n")).toContain("Unknown check");
  });
});

describe("runAuditCli: environment errors", () => {
  it("exits 2 when no context file exists", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await commitAll(tmpDir, "init");
    expect(await runAuditCli(["--dir", tmpDir], io)).toBe(2);
    expect(err.join("\n")).toContain("No CLAUDE.md");
  });

  it("exits 2 outside a git repository", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-nogit-"));
    try {
      await fs.writeFile(path.join(bareDir, "CLAUDE.md"), "# Doc\n");
      expect(await runAuditCli(["--dir", bareDir], io)).toBe(2);
      expect(err.join("\n")).toContain("not a git repository");
    } finally {
      await fs.rm(bareDir, { recursive: true, force: true });
    }
  });
});

describe("runAuditCli: outcomes", () => {
  it("exits 0 with a clean summary on a truthful doc", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("CLAUDE.md", "Code lives in `src/a.ts`. The src dir.\n");
    await commitAll(tmpDir, "init");

    expect(await runAuditCli(["--dir", tmpDir], io)).toBe(0);
    expect(out.join("\n")).toContain("clean");
  });

  it("exits 1 when a provable issue exists", async () => {
    await seedStaleRepo();
    expect(await runAuditCli(["--dir", tmpDir], io)).toBe(1);
    expect(out.join("\n")).toContain("src/logger.ts");
  });

  it("exits 0 when only advisories exist", async () => {
    await write("package.json", '{"name":"x"}');
    await write("CLAUDE.md", "# Doc\n\nThe package.json manifest.\n");
    await commitAll(tmpDir, "init");
    await write("package.json", '{"name":"x","dependencies":{"zod":"^3"}}');
    await commitAll(tmpDir, "feat: add zod");

    expect(await runAuditCli(["--dir", tmpDir], io)).toBe(0);
    expect(out.join("\n")).toContain("Advisories");
  });

  it("filters checks via --checks", async () => {
    await seedStaleRepo();
    expect(
      await runAuditCli(["--dir", tmpDir, "--checks", "stale-count"], io)
    ).toBe(0);
  });
});

describe("runAuditCli: --json contract", () => {
  it("emits the versioned report shape", async () => {
    await seedStaleRepo();
    expect(await runAuditCli(["--dir", tmpDir, "--json"], io)).toBe(1);
    const report = JSON.parse(out.join("\n"));
    expect(report.version).toBe(1);
    for (const key of [
      "root",
      "gitAvailable",
      "docs",
      "decisionsChecked",
      "issues",
      "advisories",
      "skippedChecks",
      "clean",
    ]) {
      expect(report).toHaveProperty(key);
    }
    expect(report.issues[0].anchor.doc).toBe("CLAUDE.md");
    expect(report.issues[0].evidence.kind).toBe("missing-path");
  });
});

describe("runAuditCli: --fix-prompt", () => {
  it("prints the work order when issues exist", async () => {
    await seedStaleRepo();
    expect(await runAuditCli(["--dir", tmpDir, "--fix-prompt"], io)).toBe(1);
    const prompt = out.join("\n");
    expect(prompt).toContain("RULES:");
    expect(prompt).toContain("Edit ONLY these files: CLAUDE.md");
    expect(prompt).toContain("AUDIT REPORT");
    expect(prompt).toContain('"kind": "missing-path"');
    expect(prompt).toContain("ADVISORIES");
  });

  it("prints the clean summary when there is nothing to fix", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("CLAUDE.md", "Code lives in `src/a.ts`. The src dir.\n");
    await commitAll(tmpDir, "init");

    expect(await runAuditCli(["--dir", tmpDir, "--fix-prompt"], io)).toBe(0);
    expect(out.join("\n")).toContain("clean");
    expect(out.join("\n")).not.toContain("RULES:");
  });
});
