import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { computeAudit } from "../src/audit/audit.js";
import { prepareRepair, verifyRepair } from "../src/audit/repair.js";
import { runAuditCli } from "../src/audit/cli.js";
import { masonInit, masonRepair } from "../src/mcp/tools.js";
import { CHECKS } from "../src/audit/checks/index.js";
import { commitAll, git, initGitRepo } from "./helpers.js";

let root: string;
async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}
async function seed() {
  await write("src/old.ts", "export const old = true;");
  await write("src/kept.ts", "export const kept = true;");
  await write("CLAUDE.md", "Source: `src/old.ts`. The src directory.\n");
  await write("package.json", '{"scripts":{"test":"vitest"}}');
  await commitAll(root, "initial");
  await fs.rm(path.join(root, "src/old.ts"));
  await commitAll(root, "remove old");
}
async function seedAdvisory() {
  await seed();
  await write("package.json", '{"scripts":{"test":"vitest","build":"tsc"}}');
  await commitAll(root, "change manifest");
}
async function cli(args: string[]) {
  const out: string[] = [], err: string[] = [];
  const code = await runAuditCli(["--dir", root, ...args], { out: s => out.push(s), err: s => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-repair-"));
  await initGitRepo(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("audit repair", () => {
  it("keeps inspection read-only and stores complete original evidence in an explicit preparation", async () => {
    await seed();
    await computeAudit(root);
    await masonInit(root, { base: "HEAD" });
    await expect(fs.access(path.join(root, ".mason"))).rejects.toThrow();
    const before = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    expect(prepared.report.issues).toHaveLength(1);
    const saved = JSON.parse(await fs.readFile(path.join(root, prepared.baselinePath), "utf8"));
    expect(saved.report.issues).toEqual(prepared.report.issues);
    expect(saved.report.checksRun).toEqual(["deleted-reference"]);
    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(before);
    expect(await git(["diff", "--name-only"], root)).toBe("");
  });

  it("compares stable claims across shifted lines and reports new findings separately", async () => {
    await seed();
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    await write("CLAUDE.md", "# Header\n\nSource: `src/old.ts`. Also `src/wrong.ts`.\n");
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.status).toBe("issues-remain");
    expect(result.findings[0].status).toBe("unresolved");
    expect(result.findings[0].original.anchor.line).toBe(1);
    expect(result.findings[0].current?.anchor.line).toBe(3);
    expect(result.newFindings).toHaveLength(1);
    expect(result.newFindings[0].evidence).toMatchObject({ claimed: "src/wrong.ts" });
  });

  it("verifies the actual repair through the final documentation and baseline metadata commit without rewriting the baseline", async () => {
    await seed();
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    const baselineBytes = await fs.readFile(path.join(root, prepared.baselinePath), "utf8");
    await write("CLAUDE.md", "Source: `src/kept.ts`. The src directory.\n");
    expect((await verifyRepair(root, prepared.baselinePath)).status).toBe("verified");
    await commitAll(root, "repair docs and record baseline");
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.status).toBe("verified");
    expect(result.counts.resolved).toBe(1);
    expect(await fs.readFile(path.join(root, prepared.baselinePath), "utf8")).toBe(baselineBytes);
  });

  it("retains dependency evidence through dirty-doc suppression and a later doc commit", async () => {
    await seedAdvisory();
    const prepared = await prepareRepair(root);
    const original = prepared.report.advisories.find(a => a.type === "deps-changed");
    expect(original).toBeDefined();
    await write("CLAUDE.md", "Source: `src/kept.ts`. The src directory.\n");
    const dirty = await verifyRepair(root, prepared.baselinePath);
    expect(dirty.counts.resolved).toBe(1);
    expect(dirty.status).toBe("incomplete");
    expect(dirty.findings.find(f => f.original.type === "deps-changed")).toMatchObject({
      status: "unverified", original,
    });
    expect(dirty.currentAudit?.advisories).toHaveLength(0);
    expect(dirty.currentAudit?.suppressedAdvisories).toEqual([original]);
    await commitAll(root, "docs repaired");
    const committed = await verifyRepair(root, prepared.baselinePath);
    expect(committed.currentAudit?.advisories).toHaveLength(0);
    expect(committed.status).toBe("incomplete");
    expect(committed.findings.find(f => f.original.type === "deps-changed")).toMatchObject({
      status: "review-required", original,
    });
  });

  it("recovers committed dependency evidence when preparation starts after setup dirtied the document", async () => {
    await seedAdvisory();
    await fs.appendFile(path.join(root, "CLAUDE.md"), "\nAssistant setup instructions.\n");
    const init = JSON.parse(await masonInit(root, { base: "HEAD" }));
    expect(init.audit.counts.suppressedAdvisories).toBe(1);
    const prepared = await prepareRepair(root);
    expect(prepared.report.advisories).toHaveLength(0);
    expect(prepared.report.suppressedAdvisories).toHaveLength(1);
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.findings.find(f => f.original.type === "deps-changed")?.status).toBe("unverified");
    const summary = await cli([]);
    expect(summary.out).toContain("[suppressed; unresolved] deps-changed");
    expect(summary.code).toBe(1);
  });

  it.each(["CLAUDE.md", ".git"])("never verifies removed evidence: %s", async file => {
    await seed();
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    await write("AGENTS.md", "Project instructions.\n");
    await fs.rm(path.join(root, file), { recursive: true, force: true });
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.status).toBe("incomplete");
    expect(result.findings[0].status).toBe("unverified");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps unavailable original history visible after Git is reinitialized", async () => {
    await seed();
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    await fs.rm(path.join(root, ".git"), { recursive: true });
    await initGitRepo(root);
    await write("CLAUDE.md", "Source: `src/kept.ts`.\n");
    await commitAll(root, "replacement history");
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.status).toBe("incomplete");
    expect(result.diagnostics.join(" ")).toContain("original audit commit");
  });

  it("does not treat erasing the context file's contents as a verified repair", async () => {
    await seed();
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    await write("CLAUDE.md", "\n");
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.status).toBe("incomplete");
    expect(result.findings[0].status).toBe("unverified");
    expect(result.diagnostics.join(" ")).toContain("empty or unreadable");
  });

  it("does not turn a now-unparseable workspace manifest into a resolved count", async () => {
    await write("CLAUDE.md", "There are 3 workspaces.\n");
    await write("package.json", '{"workspaces":["packages/*"]}');
    await write("packages/one/package.json", '{"name":"one"}');
    await commitAll(root, "workspace");
    const prepared = await prepareRepair(root, ["stale-count"]);
    expect(prepared.report.issues).toHaveLength(1);
    await write("package.json", "{broken");
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.findings[0].status).toBe("unverified");
    expect(result.status).toBe("incomplete");
  });

  it("retains unresolved script evidence when its check becomes unavailable", async () => {
    await seed();
    await write("CLAUDE.md", "Run `npm run gone`.\n");
    const prepared = await prepareRepair(root, ["dead-command"]);
    expect(prepared.report.issues).toHaveLength(1);
    await fs.rm(path.join(root, "package.json"));
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.findings[0].status).toBe("unverified");
  });

  it("rejects modified or malformed baselines and refuses paths outside the repository or through symlinks", async () => {
    await seed();
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    const file = path.join(root, prepared.baselinePath);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    await write("changed.json", JSON.stringify({ ...saved, createdAt: "2000-01-01T00:00:00.000Z" }));
    await expect(verifyRepair(root, "changed.json")).rejects.toThrow("modified");
    await write("invalid.json", JSON.stringify({ ...saved, report: { ...saved.report, checksRun: undefined } }));
    await expect(verifyRepair(root, "invalid.json")).rejects.toThrow();
    await expect(verifyRepair(root, "../outside.json")).rejects.toThrow("Invalid store path");
    await fs.symlink(file, path.join(root, "linked.json"));
    await expect(verifyRepair(root, "linked.json")).rejects.toThrow("Symlink");
    expect((await verifyRepair(root, file)).status).toBe("issues-remain");
  });

  it("binds a baseline to its repository", async () => {
    await seed();
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "mason-other-"));
    try {
      await fs.copyFile(path.join(root, prepared.baselinePath), path.join(other, "baseline.json"));
      await expect(verifyRepair(other, "baseline.json")).rejects.toThrow("different repository");
    } finally { await fs.rm(other, { recursive: true, force: true }); }
  });

  it.each(["commit", "doc"])("rejects an audit racing with a %s change", async change => {
    await seed();
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    const check = CHECKS["deleted-reference"];
    vi.spyOn(CHECKS, "deleted-reference").mockImplementation(async ctx => {
      const result = await check(ctx);
      if (change === "commit") await git(["commit", "--allow-empty", "-m", "concurrent"], root);
      else await fs.appendFile(path.join(root, "CLAUDE.md"), "\nconcurrent edit");
      return result;
    });
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.status).toBe("incomplete");
    expect(result.findings[0].status).toBe("unverified");
    expect(result.diagnostics.join(" ")).toContain("changed during the audit");
    await expect(prepareRepair(root, ["deleted-reference"])).rejects.toThrow("changed during the audit");
  });

  it("keeps all findings when onboarding summaries truncate", async () => {
    await seed();
    await write("CLAUDE.md", Array.from({ length: 25 }, (_, i) => "Path: `src/missing" + i + ".ts`.").join("\n"));
    const init = JSON.parse(await masonInit(root, { base: "HEAD" }));
    expect(init.audit.truncated).toBe(true);
    expect(init.audit.issues).toHaveLength(20);
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    expect((await verifyRepair(root, prepared.baselinePath)).findings).toHaveLength(25);
  });

  it("exposes preparation and verification through the CLI and MCP without changing ordinary exit codes", async () => {
    await seed();
    const preparedCli = await cli(["--prepare-repair", "--checks", "deleted-reference", "--json"]);
    expect(preparedCli.code).toBe(1);
    const prepared = JSON.parse(preparedCli.out);
    expect((await cli(["--verify-repair", prepared.baselinePath])).code).toBe(1);
    const preparedMcp = JSON.parse(await masonRepair(root, { action: "prepare", checks: ["deleted-reference"] }));
    expect(preparedMcp.workOrder).toContain(preparedMcp.baselinePath);
    expect(preparedMcp.workOrder).toContain("setup-only");
    await write("CLAUDE.md", "Source: `src/kept.ts`.\n");
    expect((await cli(["--verify-repair", prepared.baselinePath])).code).toBe(0);
    expect(JSON.parse(await masonRepair(root, { action: "verify", baselinePath: preparedMcp.baselinePath })).status).toBe("verified");
    expect(JSON.parse(await masonRepair(root, { action: "verify" })).status).toBe("unavailable");
    expect(JSON.parse(await masonRepair(root, { action: "verify", baselinePath: preparedMcp.baselinePath, checks: ["new-module"] })).status).toBe("unavailable");
    expect((await cli(["--verify-repair", prepared.baselinePath, "--checks", "new-module"])).code).toBe(2);
    expect((await cli(["--verify-repair"])).code).toBe(2);
    expect((await cli(["--checks", ","])).code).toBe(2);
  });

  it("prints an advisory work order and retains advisory-only default exit 0", async () => {
    await seedAdvisory();
    await write("CLAUDE.md", "Source: `src/kept.ts`. The src directory.\n");
    const prompt = await cli(["--fix-prompt"]);
    expect(prompt.code).toBe(0);
    expect(prompt.out).toContain("ADVISORIES");
    expect(prompt.out).toContain("suppressedAdvisories");
    const prepared = await prepareRepair(root);
    expect((await cli(["--verify-repair", prepared.baselinePath, "--json"])).code).toBe(2);
  });
});
