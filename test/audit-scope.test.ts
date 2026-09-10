import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { computeAudit } from "../src/audit/audit.js";
import { discoverDocs } from "../src/audit/docs.js";
import { extractClaims } from "../src/audit/claims.js";
import { prepareRepair, verifyRepair } from "../src/audit/repair.js";
import { readInputs, checkCache } from "../src/automation/evidence.js";
import { git, initGitRepo, commitAll } from "./helpers.js";

let root: string;
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
};
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-audit-scope-")); await initGitRepo(root); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("scoped initial audits", () => {
  it("discovers real casing, nested instructions and READMEs without setup", async () => {
    await write("agents.md", "# Instructions\n");
    await write("packages/client/README.md", "# Client\n");
    await write("packages/client/.claude/CLAUDE.md", "# Client instructions\n");
    const head = await commitAll(root, "docs");
    const docs = await discoverDocs(root);
    expect(docs.map(d => d.path).sort()).toEqual(["agents.md", "packages/client/.claude/CLAUDE.md", "packages/client/README.md"]);
    expect(docs.every(d => d.lastCommit?.hash === head && !d.dirty)).toBe(true);
    expect(docs.find(d => d.path.includes(".claude/"))?.scope).toBe("packages/client");
    await write("agents.md", "# Edited\n");
    expect((await discoverDocs(root)).find(d => d.path === "agents.md")?.dirty).toBe(true);
    await expect(fs.access(path.join(root, ".mason"))).rejects.toThrow();
  });

  it("excludes generated and configured trees while retaining tracked ignored docs", async () => {
    await write("README.md", "# Root\n");
    await write("kept/README.md", "# Kept\n");
    await commitAll(root, "docs");
    await write(".gitignore", "kept/\nscratch/\n");
    await write("scratch/README.md", "# Scratch\n");
    await write("node_modules/pkg/README.md", "# Dependency\n");
    await write("private/README.md", "# Excluded\n");
    await write(".mason/config.json", JSON.stringify({ ignore: ["private/**"] }));
    expect((await discoverDocs(root)).map(d => d.path).sort()).toEqual(["README.md", "kept/README.md"]);
  });

  it("rejects a symlinked selected document without reading its target", async () => {
    await write("README.md", "# Root\n");
    await fs.mkdir(path.join(root, "nested"));
    await fs.symlink(path.join(root, "missing.md"), path.join(root, "nested/AGENTS.md"));
    await expect(discoverDocs(root)).rejects.toThrow(/symbolic link|Symlink/i);
  });

  it("resolves Markdown links from their physical document, including reference links and encoded spaces", async () => {
    await write("packages/client/README.md", "[guide](guide.md) and [space](<a b.md>)\n\n[reference][r]\n\n[r]: guide.md#heading\n");
    await write("packages/client/guide.md", "# Guide\n");
    await write("packages/client/a b.md", "# Space\n");
    await write(".claude/CLAUDE.md", "[root](../packages/client/guide.md)\n");
    await commitAll(root, "docs");
    const report = await computeAudit(root, { checks: ["deleted-reference"] });
    expect(report?.issues).toEqual([]); expect(report?.advisories).toEqual([]);
    expect(extractClaims("`[example](missing.md)`\n```ts\n[example](missing.md)\n```\n").paths).toEqual([]);
  });

  it("retains a renamed link's scope and repair evidence through the final doc commit", async () => {
    await write("packages/client/README.md", "[guide](guide.md)\n");
    await write("packages/client/guide.md", "# Guide\n");
    await commitAll(root, "docs");
    await git(["mv", "packages/client/guide.md", "packages/client/new.md"], root);
    await commitAll(root, "rename");
    const prepared = await prepareRepair(root, ["deleted-reference"]);
    expect(prepared.report?.issues[0].evidence).toMatchObject({ kind: "missing-path", resolvedPath: "packages/client/guide.md",
      renamedTo: "packages/client/new.md", scope: { basis: "document-link", directory: "packages/client" } });
    await write("packages/client/README.md", "[guide](new.md)\n");
    await commitAll(root, "update reference");
    const result = await verifyRepair(root, prepared.baselinePath);
    expect(result.status).toBe("verified");
    expect(result.findings[0].original.evidence).toMatchObject({ scope: { basis: "document-link" } });
    expect(result.findings[0].status).toBe("resolved");
  });

  it("does not let a root-level namesake satisfy a missing nested Markdown link", async () => {
    await write("guide.md", "# Root guide\n");
    await write("packages/client/guide.md", "# Client guide\n");
    await write("packages/client/README.md", "[guide](guide.md)\n");
    await commitAll(root, "docs");
    await fs.rm(path.join(root, "packages/client/guide.md")); await commitAll(root, "remove client guide");
    expect((await computeAudit(root, { checks: ["deleted-reference"] }))?.issues).toHaveLength(1);
  });

  it("keeps bare nested paths and generated outputs advisory", async () => {
    await write("packages/client/README.md", "Read `src/old.ts` and [generated](dist/api.md).\n");
    await write("packages/client/src/old.ts", "export {};\n");
    await commitAll(root, "docs");
    await fs.rm(path.join(root, "packages/client/src/old.ts")); await commitAll(root, "remove");
    const report = await computeAudit(root, { checks: ["deleted-reference"] });
    expect(report?.issues).toEqual([]); expect(report?.advisories).toHaveLength(2);
    expect(report?.clean).toBe(true);
  });

  it("does not assume a nested count or dependency change describes the root or sibling", async () => {
    await write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    await write("packages/client/package.json", pkg({ build: "tsc" }));
    await write("packages/client/README.md", "2 packages cooperate in this integration.\n");
    await write("packages/other/package.json", pkg({}));
    await commitAll(root, "docs");
    await write("packages/other/package.json", pkg({ test: "vitest" })); await commitAll(root, "sibling change");
    const report = await computeAudit(root, { checks: ["stale-count", "deps-changed"] });
    expect(report?.issues).toEqual([]); expect(report?.advisories).toEqual([]);
    expect(report?.skippedChecks[0].check).toBe("stale-count");
    await write("packages/client/package.json", pkg({ build: "tsc", test: "vitest" })); await commitAll(root, "client change");
    expect((await computeAudit(root, { checks: ["deps-changed"] }))?.advisories).toHaveLength(1);
  });

  it("makes undocumented modules advisory and recognizes their own README", async () => {
    await write("README.md", "# Root\n"); await write("client/main.py", "print('hello')\n"); await commitAll(root, "code");
    const report = await computeAudit(root, { checks: ["new-module"] });
    expect(report?.issues).toEqual([]); expect(report?.advisories[0].type).toBe("new-module");
    await write("client/README.md", "# Usage\n");
    expect((await computeAudit(root, { checks: ["new-module"] }))?.advisories).toEqual([]);
  });

  it("checks explicit package directories without letting root or sibling scripts hide a defect", async () => {
    await write("README.md", "Run `npm --prefix packages/a run test`.\n\n```sh\ncd packages/a\nnpm run test\ncd ../b\nnpm run test\n```\n");
    await write("package.json", pkg({ test: "root-test" }));
    await write("packages/a/package.json", pkg({ build: "tsc" }));
    await write("packages/b/package.json", pkg({ test: "test-b" })); await commitAll(root, "docs");
    const report = await computeAudit(root, { checks: ["dead-command"] });
    expect(report?.issues).toHaveLength(1);
    expect(report?.issues[0].evidence).toMatchObject({ kind: "missing-script", scope: { directory: "packages/a", candidates: ["packages/a/package.json"] } });
  });

  it("resolves inline cd and preserves commands for distinct scopes", async () => {
    const claims = extractClaims("`cd packages/a && npm run test`\n`cd packages/b && npm run test`\n").commands;
    expect(claims.map(c => c.directory)).toEqual(["packages/a", "packages/b"]);
  });

  it("reports inferred command scope for review, including a repository without a root package", async () => {
    await write("packages/a/README.md", "Run `npm run build`.\n");
    await write("packages/a/package.json", pkg({ test: "test-a" }));
    await write("packages/b/package.json", pkg({ build: "build-b" })); await commitAll(root, "docs");
    const report = await computeAudit(root, { checks: ["dead-command"] });
    expect(report?.issues).toEqual([]); expect(report?.advisories[0].message).toContain("packages/b/package.json");
    expect(report?.advisories[0].evidence).toMatchObject({ scope: { directory: "packages/a", basis: "document" } });
  });

  it("preserves unavailable manifests and unsupported command selection", async () => {
    await write("README.md", "`npm run build`\n`pnpm --filter a run test`\n`npm run test --workspace a`\n");
    await write("package.json", "{broken"); await commitAll(root, "docs");
    const report = await computeAudit(root, { checks: ["dead-command"] });
    expect(report?.issues).toEqual([]); expect(report?.skippedChecks).toHaveLength(3);
    expect(report?.skippedChecks.map(s => s.reason).join(" ")).toContain("Invalid package manifest");
  });

  it("does not treat printed commands or unsupported shell constructs as proven script failures", async () => {
    await write("README.md", ["```sh", 'echo "example; npm run imaginary"', "npm run --if-present optional", "cd $TARGET", "npm run test", "```"].join("\n"));
    await write("package.json", pkg({})); await commitAll(root, "docs");
    const report = await computeAudit(root, { checks: ["dead-command"] });
    expect(report?.issues).toEqual([]);
    expect(report?.skippedChecks).toHaveLength(2);
    expect(extractClaims('`echo "npm run imaginary"`').commands).toEqual([]);
  });

  it("rechecks a speculative missing path without approving historical advisories", async () => {
    await write("README.md", "[generated](generated/api.md)\n"); await write("package.json", pkg({})); await commitAll(root, "docs");
    await write("package.json", pkg({ test: "test" })); await commitAll(root, "change manifest");
    const prepared = await prepareRepair(root, ["deleted-reference", "deps-changed"]);
    expect(prepared.report.advisories.find(f => f.type === "deleted-reference")?.resolution).toBe("recheck");
    expect((await verifyRepair(root, prepared.baselinePath)).findings.every(f => f.status === "review-required")).toBe(true);
    await write("generated/api.md", "# Generated API\n");
    await write("README.md", "[generated](generated/api.md)\nUpdated.\n"); await commitAll(root, "document");
    const verified = await verifyRepair(root, prepared.baselinePath);
    expect(verified.findings.find(f => f.original.type === "deleted-reference")?.status).toBe("resolved");
    expect(verified.findings.find(f => f.original.type === "deps-changed")?.status).toBe("review-required");
    expect(verified.status).toBe("incomplete");
  });

  it("invalidates cached checks for nested document discovery, edits, targets and scoped manifests", async () => {
    await write("README.md", "# Root\n"); await write("package.json", pkg({ test: "root" })); await commitAll(root, "initial");
    const initial = await readInputs(root);
    await write("client/README.md", "[guide](guide.md)\n`npm run test`\n");
    await write("client/package.json", pkg({ test: "client" }));
    const discovered = await readInputs(root);
    expect(discovered.fingerprint).not.toBe(initial.fingerprint);
    const cache = checkCache(null, discovered);
    const before = await computeAudit(root, cache.options);
    expect(before?.advisories.some(f => f.type === "deleted-reference")).toBe(true);
    await write("client/guide.md", "# Guide\n");
    const linked = await readInputs(root);
    expect(linked.keys["deleted-reference"]).not.toBe(discovered.keys["deleted-reference"]);
    await write("client/package.json", pkg({}));
    const changed = await readInputs(root);
    expect(changed.keys["dead-command"]).not.toBe(linked.keys["dead-command"]);
    const second = checkCache(cache.serialize(), changed);
    const after = await computeAudit(root, second.options);
    expect(second.ran.has("dead-command")).toBe(true);
    expect(after?.advisories.some(f => f.type === "dead-command")).toBe(true);
    await fs.rm(path.join(root, "client/README.md"));
    expect((await readInputs(root)).docs["client/README.md"]).toBeUndefined();
  });
});
