import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { computeAudit } from "../src/audit/audit.js";
import { prepareRepair, verifyRepair } from "../src/audit/repair.js";
import { CHECKS } from "../src/audit/checks/index.js";
import { commitsTouchingSince } from "../src/audit/git.js";
import { releaseMetadataOnly } from "../src/audit/release-metadata.js";
import { commitAll, git, initGitRepo } from "./helpers.js";

let root: string;
const gradle = (version = "1.0.0", dependency = "1.0") => `plugins {
  id("com.android.application")
}
android {
  defaultConfig {
    versionCode = 1
    versionName = "${version}"
  }
}
dependencies {
  implementation("example:library:${dependency}")
}
`;
async function write(file: string, value: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), value);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-release-metadata-"));
  await initGitRepo(root);
  await write("CLAUDE.md", "The app directory contains the Android application.\n");
  await write("app/build.gradle.kts", gradle());
  await write(".gitignore", ".mason/reports/\n");
  await commitAll(root, "initial");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const audit = () => computeAudit(root, { checks: ["deps-changed"] });

describe("release metadata advisories", () => {
  it("omits literal Android release values but retains a later real dependency edit", async () => {
    await write("app/build.gradle.kts", gradle("1.0.1").replace("versionCode = 1", "versionCode = 2"));
    await commitAll(root, "release version");
    expect((await audit())!.advisories).toEqual([]);
    await write("app/build.gradle.kts", gradle("1.0.1", "2.0"));
    await commitAll(root, "dependency update");
    const report = await audit();
    expect(report!.advisories).toHaveLength(1);
    expect(report!.advisories[0].evidence).toMatchObject({ totalCommits: 1 });
  });

  it.each([
    ["mixed dependency edit", gradle("1.0.1", "2.0")],
    ["computed version", gradle().replace('versionName = "1.0.0"', 'versionName = releaseVersion()')],
    ["unrecognized scope", gradle().replace("defaultConfig {", "customConfig {")],
    ["another use of the version", gradle("1.0.1") + 'val dependencyVersion = android.defaultConfig.versionName\n'],
    ["ambiguous multiline syntax", gradle("1.0.1") + 'val script = """versionName = "example"""\n'],
    ["plugin alias without a proven Android plugin", gradle("1.0.1").replace('id("com.android.application")', 'alias(libs.plugins.application)')],
  ])("retains %s", async (_, value) => {
    await write("app/build.gradle.kts", value);
    await commitAll(root, "manifest edit");
    expect((await audit())!.advisories).toHaveLength(1);
  });

  it("keeps version values used in dependency string interpolation advisory", async () => {
    const withReference = (version: string) => gradle(version) + 'dependencies { implementation("example:library:${android.defaultConfig.versionName}") }\n';
    await write("app/build.gradle.kts", withReference("1.0.0"));
    await commitAll(root, "version drives dependency");
    await write("CLAUDE.md", "The app directory contains the Android application and its dependencies.\n");
    await commitAll(root, "document current configuration");
    await write("app/build.gradle.kts", withReference("1.0.1"));
    await commitAll(root, "version affecting dependencies");
    expect((await audit())!.advisories).toHaveLength(1);
  });

  it("retains additions, removals, and other manifest changes in the same release", async () => {
    await write("app/build.gradle.kts", gradle("1.0.1"));
    await write("other/build.gradle.kts", gradle("1.0.1"));
    await commitAll(root, "add module during release");
    expect((await audit())!.advisories).toHaveLength(1);
    await write("CLAUDE.md", "The app and other directories contain Android applications.\n");
    await commitAll(root, "instructions");
    await fs.rm(path.join(root, "other/build.gradle.kts"));
    await write("app/build.gradle.kts", gradle("1.0.2"));
    await commitAll(root, "remove module during release");
    expect((await audit())!.advisories).toHaveLength(1);
    await write("CLAUDE.md", "The app directory contains the Android application.\n");
    await commitAll(root, "instructions again");
    await write("package.json", '{"version":"2.0.0"}');
    await write("app/build.gradle.kts", gradle("1.0.3"));
    await commitAll(root, "multi-ecosystem release");
    expect((await audit())!.advisories).toHaveLength(1);
  });

  it("does not classify merge commits or unavailable history as release-only", async () => {
    const initial = await git(["rev-parse", "HEAD"], root);
    await git(["switch", "-c", "release"], root);
    await write("app/build.gradle.kts", gradle("1.0.1"));
    await commitAll(root, "release version");
    await git(["switch", "main"], root);
    await git(["merge", "--no-ff", "release", "-m", "merge release"], root);
    const head = await git(["rev-parse", "HEAD"], root);
    expect(await releaseMetadataOnly(root, { hash: head, date: "", subject: "", files: ["app/build.gradle.kts"] })).toBe(false);
    expect(await releaseMetadataOnly(root, { hash: "f".repeat(40), date: "", subject: "", files: ["app/build.gradle.kts"] })).toBe(false);
    expect(await commitsTouchingSince(root, initial, ["app/build.gradle.kts"])).not.toBeNull();
  });

  it("leaves an advisory retained by an older engine review-required", async () => {
    const initial = await git(["rev-parse", "HEAD"], root);
    await write("app/build.gradle.kts", gradle("1.0.1"));
    await commitAll(root, "release version");
    const commits = (await commitsTouchingSince(root, initial, ["app/build.gradle.kts"]))!;
    vi.spyOn(CHECKS, "deps-changed").mockImplementationOnce(async ctx => ({
      issues: [], skipped: [], advisories: [{ type: "deps-changed", message: "dependency manifests touched since instructions", anchor: { doc: "CLAUDE.md", line: null, excerpt: null },
        evidence: { kind: "doc-behind-manifests", docLastCommit: ctx.docs[0].lastCommit!, manifestCommits: commits.commits, totalCommits: commits.total } }],
    }));
    const baseline = await prepareRepair(root, ["deps-changed"]);
    vi.restoreAllMocks();
    const bytes = await fs.readFile(path.join(root, baseline.baselinePath), "utf8");
    const verified = await verifyRepair(root, baseline.baselinePath);
    expect(verified.currentAudit!.advisories).toEqual([]);
    expect(verified.findings[0].status).toBe("review-required");
    expect(await fs.readFile(path.join(root, baseline.baselinePath), "utf8")).toBe(bytes);
  });
});
