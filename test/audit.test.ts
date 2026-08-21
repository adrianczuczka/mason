import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { computeAudit } from "../src/audit/audit.js";
import type { AuditReport } from "../src/audit/types.js";
import { git, commitAll, initGitRepo } from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-audit-test-"));
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

function issuesOf(report: AuditReport | null, type?: string) {
  expect(report).not.toBeNull();
  return type
    ? report!.issues.filter((i) => i.type === type)
    : report!.issues;
}

describe("computeAudit: basics", () => {
  it("returns null when no context file exists", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await commitAll(tmpDir, "init");
    expect(await computeAudit(tmpDir)).toBeNull();
  });

  it("reports gitAvailable=false outside a git repo", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-nogit-"));
    try {
      await fs.writeFile(path.join(bareDir, "CLAUDE.md"), "# Doc\n");
      const report = await computeAudit(bareDir);
      expect(report).not.toBeNull();
      expect(report!.gitAvailable).toBe(false);
      expect(report!.issues).toEqual([]);
    } finally {
      await fs.rm(bareDir, { recursive: true, force: true });
    }
  });

  it("is clean on a truthful doc", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("CLAUDE.md", "# Doc\n\nCode lives in `src/a.ts`. The src dir.\n");
    await commitAll(tmpDir, "init");
    const report = await computeAudit(tmpDir);
    expect(report!.clean).toBe(true);
    expect(report!.issues).toEqual([]);
  });
});

describe("computeAudit: deleted-reference", () => {
  const CHECKS = { checks: ["deleted-reference" as const] };

  it("flags a tracked-then-deleted path as certain with the deleting commit", async () => {
    await write("src/logger.ts", "export const log = 1;\n");
    await write("CLAUDE.md", "Logging lives in `src/logger.ts`.\n");
    await commitAll(tmpDir, "init");
    await fs.rm(path.join(tmpDir, "src", "logger.ts"));
    await commitAll(tmpDir, "chore: drop logger");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    expect(issues[0].confidence).toBe("certain");
    expect(issues[0].anchor).toEqual({
      doc: "CLAUDE.md",
      line: 1,
      excerpt: "src/logger.ts",
    });
    const evidence = issues[0].evidence;
    expect(evidence.kind).toBe("missing-path");
    if (evidence.kind === "missing-path") {
      expect(evidence.everTracked).toBe(true);
      expect(evidence.deletedInCommit?.subject).toBe("chore: drop logger");
    }
  });

  it("flags a renamed path as certain with renamedTo", async () => {
    await write("src/old-name.ts", "export const x = 1;\n");
    await write("CLAUDE.md", "See `src/old-name.ts`.\n");
    await commitAll(tmpDir, "init");
    await git(["mv", "src/old-name.ts", "src/new-name.ts"], tmpDir);
    await commitAll(tmpDir, "refactor: rename");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    expect(issues[0].confidence).toBe("certain");
    if (issues[0].evidence.kind === "missing-path") {
      expect(issues[0].evidence.renamedTo).toBe("src/new-name.ts");
    }
  });

  it("flags a never-tracked path with an existing parent as likely", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("CLAUDE.md", "See `src/typo.ts`.\n");
    await commitAll(tmpDir, "init");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    expect(issues[0].confidence).toBe("likely");
  });

  it("drops a never-tracked path with no parent (illustrative example)", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("CLAUDE.md", "Put helpers in `imaginary/helpers.ts`.\n");
    await commitAll(tmpDir, "init");

    expect(issuesOf(await computeAudit(tmpDir, CHECKS))).toEqual([]);
  });

  it("does not flag relative import examples in fenced code", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write(
      "CLAUDE.md",
      '# Doc\n\n```ts\nimport { a } from "./foo.js";\n```\n'
    );
    await commitAll(tmpDir, "init");

    expect(issuesOf(await computeAudit(tmpDir, CHECKS))).toEqual([]);
  });

  it("skips .mason/ paths — optional metadata, not repo structure", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("CLAUDE.md", "Configure via `.mason/config.json`.\n");
    await write(".mason/project.json", "{}\n");
    await commitAll(tmpDir, "init");

    expect(issuesOf(await computeAudit(tmpDir, CHECKS))).toEqual([]);
  });

  it("anchors issues to the doc that made the claim", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("CLAUDE.md", "See `src/gone-c.ts`.\n");
    await write("AGENTS.md", "See `src/gone-a.ts`.\n");
    await write("src/gone-c.ts", "export const c = 1;\n");
    await write("src/gone-a.ts", "export const a = 1;\n");
    await commitAll(tmpDir, "init");
    await fs.rm(path.join(tmpDir, "src", "gone-c.ts"));
    await fs.rm(path.join(tmpDir, "src", "gone-a.ts"));
    await commitAll(tmpDir, "chore: drop both");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    const byDoc = Object.fromEntries(
      issues.map((i) => [i.anchor.doc, i.anchor.excerpt])
    );
    expect(byDoc).toEqual({
      "CLAUDE.md": "src/gone-c.ts",
      "AGENTS.md": "src/gone-a.ts",
    });
  });
});

describe("computeAudit: new-module", () => {
  const CHECKS = { checks: ["new-module" as const] };

  it("flags an unmentioned top-level dir containing source files", async () => {
    await write("mystery/thing.ts", "export const t = 1;\n");
    await write("CLAUDE.md", "# Doc\n\nNothing to see.\n");
    await commitAll(tmpDir, "init");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    expect(issues[0].confidence).toBe("likely");
    if (issues[0].evidence.kind === "unmentioned-dir") {
      expect(issues[0].evidence.dir).toBe("mystery");
    }
  });

  it("does not flag a dir mentioned only in AGENTS.md", async () => {
    await write("mystery/thing.ts", "export const t = 1;\n");
    await write("CLAUDE.md", "# Doc\n");
    await write("AGENTS.md", "The mystery/ dir holds experiments.\n");
    await commitAll(tmpDir, "init");

    expect(issuesOf(await computeAudit(tmpDir, CHECKS))).toEqual([]);
  });

  it("uses word boundaries — 'application' does not mention app/", async () => {
    await write("app/main.ts", "export const m = 1;\n");
    await write("CLAUDE.md", "The application code is documented here.\n");
    await commitAll(tmpDir, "init");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
  });

  it("flags an unmentioned subdir when the docs enumerate its siblings", async () => {
    await write("src/alpha/a.ts", "export const a = 1;\n");
    await write("src/beta/b.ts", "export const b = 1;\n");
    await write("src/gamma/c.ts", "export const c = 1;\n");
    await write("src/gamma/d.ts", "export const d = 1;\n");
    await write("CLAUDE.md", "# Doc\n\nsrc/ has `src/alpha` and `src/beta`.\n");
    await commitAll(tmpDir, "init");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    if (issues[0].evidence.kind === "unmentioned-dir") {
      expect(issues[0].evidence.dir).toBe("src/gamma");
    }
  });

  it("does not descend when the docs do not enumerate children", async () => {
    await write("src/alpha/a.ts", "export const a = 1;\n");
    await write("src/gamma/c.ts", "export const c = 1;\n");
    await write("src/gamma/d.ts", "export const d = 1;\n");
    await write("CLAUDE.md", "# Doc\n\nCode is under src/.\n");
    await commitAll(tmpDir, "init");

    expect(issuesOf(await computeAudit(tmpDir, CHECKS))).toEqual([]);
  });
});

describe("computeAudit: stale-count", () => {
  const CHECKS = { checks: ["stale-count" as const] };

  it("flags an npm workspace count mismatch as certain", async () => {
    await write(
      "package.json",
      JSON.stringify({ name: "root", workspaces: ["packages/*"] })
    );
    await write("packages/a/package.json", '{"name":"a"}');
    await write("packages/b/package.json", '{"name":"b"}');
    await write("CLAUDE.md", "This monorepo has 5 packages.\n");
    await commitAll(tmpDir, "init");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    expect(issues[0].confidence).toBe("certain");
    if (issues[0].evidence.kind === "count-mismatch") {
      expect(issues[0].evidence.claimed).toBe(5);
      expect(issues[0].evidence.actual).toBe(2);
    }
  });

  it("stays quiet when the count is right", async () => {
    await write(
      "package.json",
      JSON.stringify({ name: "root", workspaces: ["packages/*"] })
    );
    await write("packages/a/package.json", '{"name":"a"}');
    await write("packages/b/package.json", '{"name":"b"}');
    await write("CLAUDE.md", "This monorepo has 2 packages.\n");
    await commitAll(tmpDir, "init");

    expect(issuesOf(await computeAudit(tmpDir, CHECKS))).toEqual([]);
  });

  it("counts multi-arg gradle includes correctly", async () => {
    await write(
      "settings.gradle.kts",
      'include(":app", ":core")\ninclude(":data")\n'
    );
    await write("CLAUDE.md", "The build has 2 modules.\n");
    await commitAll(tmpDir, "init");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    if (issues[0].evidence.kind === "count-mismatch") {
      expect(issues[0].evidence.actual).toBe(3);
    }
  });

  it("resolves cargo workspace member globs", async () => {
    await write("Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
    await write("crates/one/Cargo.toml", '[package]\nname = "one"\n');
    await write("crates/two/Cargo.toml", '[package]\nname = "two"\n');
    await write("CLAUDE.md", "The workspace has 3 crates.\n");
    await commitAll(tmpDir, "init");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    if (issues[0].evidence.kind === "count-mismatch") {
      expect(issues[0].evidence.actual).toBe(2);
    }
  });

  it("skips claims whose ecosystem has no manifest here", async () => {
    await write("package.json", '{"name":"plain"}');
    await write("CLAUDE.md", "There are 12 crates in this repo.\n");
    await commitAll(tmpDir, "init");

    expect(issuesOf(await computeAudit(tmpDir, CHECKS))).toEqual([]);
  });
});

describe("computeAudit: dead-command", () => {
  const CHECKS = { checks: ["dead-command" as const] };

  it("flags a script missing from every manifest", async () => {
    await write(
      "package.json",
      JSON.stringify({ name: "x", scripts: { build: "tsup", test: "vitest" } })
    );
    await write("CLAUDE.md", "Run `npm run lint` before pushing.\n");
    await commitAll(tmpDir, "init");

    const issues = issuesOf(await computeAudit(tmpDir, CHECKS));
    expect(issues).toHaveLength(1);
    expect(issues[0].confidence).toBe("certain");
    if (issues[0].evidence.kind === "missing-script") {
      expect(issues[0].evidence.scriptName).toBe("lint");
      expect(issues[0].evidence.availableScripts).toEqual(["build", "test"]);
    }
  });

  it("finds scripts that live only in a workspace manifest", async () => {
    await write("package.json", JSON.stringify({ name: "root", scripts: {} }));
    await write(
      "packages/web/package.json",
      JSON.stringify({ name: "web", scripts: { e2e: "playwright" } })
    );
    await write("CLAUDE.md", "In packages/web run `npm run e2e`.\n");
    await commitAll(tmpDir, "init");

    expect(issuesOf(await computeAudit(tmpDir, CHECKS))).toEqual([]);
  });

  it("skips the check with a reason when there is no root package.json", async () => {
    await write("CLAUDE.md", "Run `npm run build`.\n");
    await commitAll(tmpDir, "init");

    const report = await computeAudit(tmpDir, CHECKS);
    expect(report!.issues).toEqual([]);
    expect(report!.skippedChecks).toEqual([
      { check: "dead-command", reason: "no package.json at the repo root" },
    ]);
  });
});

describe("computeAudit: deps-changed (advisory)", () => {
  const CHECKS = { checks: ["deps-changed" as const] };

  it("emits an advisory when manifests changed after the doc, and stays clean", async () => {
    await write("package.json", '{"name":"x","dependencies":{}}');
    await write("CLAUDE.md", "# Doc\n");
    await commitAll(tmpDir, "init");
    await write("package.json", '{"name":"x","dependencies":{"zod":"^3"}}');
    await commitAll(tmpDir, "feat: add zod");

    const report = await computeAudit(tmpDir, CHECKS);
    expect(report!.clean).toBe(true);
    expect(report!.advisories).toHaveLength(1);
    const advisory = report!.advisories[0];
    expect(advisory.type).toBe("deps-changed");
    if (advisory.evidence.kind === "doc-behind-manifests") {
      expect(advisory.evidence.totalCommits).toBe(1);
      expect(advisory.evidence.manifestCommits[0].subject).toBe("feat: add zod");
      expect(advisory.evidence.manifestCommits[0].files).toEqual([
        "package.json",
      ]);
    }
  });

  it("ignores commits that touch no manifest", async () => {
    await write("package.json", '{"name":"x"}');
    await write("CLAUDE.md", "# Doc\n");
    await commitAll(tmpDir, "init");
    await write("src/a.ts", "export const a = 1;\n");
    await commitAll(tmpDir, "feat: code only");

    expect((await computeAudit(tmpDir, CHECKS))!.advisories).toEqual([]);
  });

  it("suppresses the check for a dirty doc", async () => {
    await write("package.json", '{"name":"x"}');
    await write("CLAUDE.md", "# Doc\n");
    await commitAll(tmpDir, "init");
    await write("package.json", '{"name":"x","dependencies":{"zod":"^3"}}');
    await commitAll(tmpDir, "feat: add zod");
    await write("CLAUDE.md", "# Doc being edited right now\n");

    const report = await computeAudit(tmpDir, CHECKS);
    expect(report!.advisories).toEqual([]);
    expect(report!.skippedChecks[0].reason).toContain("uncommitted edits");
  });

  it("skips an untracked doc with a reason", async () => {
    await write("package.json", '{"name":"x"}');
    await commitAll(tmpDir, "init");
    await write("CLAUDE.md", "# Never committed\n");

    const report = await computeAudit(tmpDir, CHECKS);
    expect(report!.advisories).toEqual([]);
    expect(report!.skippedChecks[0].reason).toContain("no commit history");
  });
});

describe("computeAudit: decision-anchor-drift (advisory)", () => {
  const CHECKS = { checks: ["decision-anchor-drift" as const] };

  it("stays dark when .mason/decisions does not exist", async () => {
    await write("CLAUDE.md", "# Doc\n");
    await commitAll(tmpDir, "init");

    const report = await computeAudit(tmpDir, CHECKS);
    expect(report!.decisionsChecked).toBe(false);
    expect(report!.advisories).toEqual([]);
  });

  it("emits an advisory for a decision whose anchors changed", async () => {
    await write("src/auth.ts", "export const auth = 1;\n");
    await write("CLAUDE.md", "# Doc\n");
    const firstHash = await commitAll(tmpDir, "init");
    await write(
      ".mason/decisions/auth-is-weird.json",
      JSON.stringify({
        version: 1,
        id: "auth-is-weird",
        title: "Auth is weird",
        body: "Do not touch without reading the RFC.",
        category: "gotcha",
        files: ["src/auth.ts"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        refreshedHash: firstHash,
        status: "active",
      })
    );
    await write("src/auth.ts", "export const auth = 2;\n");
    await commitAll(tmpDir, "feat: change auth");

    const report = await computeAudit(tmpDir, CHECKS);
    expect(report!.decisionsChecked).toBe(true);
    expect(report!.clean).toBe(true);
    expect(report!.advisories).toHaveLength(1);
    const advisory = report!.advisories[0];
    expect(advisory.type).toBe("decision-anchor-drift");
    if (advisory.evidence.kind === "decision-anchor") {
      expect(advisory.evidence.decisionId).toBe("auth-is-weird");
      expect(advisory.evidence.changedFiles).toEqual(["src/auth.ts"]);
    }
  });
});
