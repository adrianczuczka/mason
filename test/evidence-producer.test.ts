import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitAll, git, initGitRepo } from "./helpers.js";
import { computeReview } from "../src/review/review.js";

const exec = promisify(execFile);
const producer = fileURLToPath(new URL("../scripts/test-evidence.mjs", import.meta.url));
const manifestPath = ".mason/reports/evidence.json";
describe("repository CI evidence producer", () => {
  let repo: string, head: string;
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "mason-evidence-producer-"));
    await initGitRepo(repo);
    await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n.mason/reports/\n");
    await fs.writeFile(path.join(repo, "source.js"), "export const value = 1;\n");
    head = await commitAll(repo, "initial source");
    await fs.mkdir(path.join(repo, "node_modules/vitest"), { recursive: true });
  });
  afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); });
  const run = async (body: string) => {
    // A controlled child process exercises real exit status and Git provenance.
    await fs.writeFile(path.join(repo, "node_modules/vitest/vitest.mjs"), `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(fs.readFileSync('${manifestPath}', 'utf8'));
assert.equal(manifest.checks[0].status, 'unavailable');
const output = process.argv.find(arg => arg.startsWith('--outputFile.json=')).split('=')[1];
${body}
`);
    let exitCode = 0;
    try { await exec(process.execPath, [producer], { cwd: repo }); }
    catch (error) { exitCode = (error as { code: number }).code; }
    const manifest = JSON.parse(await fs.readFile(path.join(repo, manifestPath), "utf8"));
    return { exitCode, check: manifest.checks[0] };
  };
  const validReport = `fs.writeFileSync(output, JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, testResults: [{ name: 'test/source.test.js', status: 'passed', assertionResults: [{ fullName: 'works', status: 'passed' }] }] }));`;

  it("records the actual passing run and clean tested commit", async () => {
    const result = await run(validReport);
    expect(result).toMatchObject({ exitCode: 0, check: { status: "completed", exitCode: 0, commit: head, workingTreeClean: true, sourceRoot: await fs.realpath(repo) } });
    expect((await computeReview(repo, head, { evidence: [manifestPath] })).evidence.status).toBe("passed");
    expect(await git(["status", "--porcelain"], repo)).toBe("");
  });

  it("preserves a failed child process exit status even beside a passing artifact", async () => {
    expect(await run(validReport + "\nprocess.exit(1);")).toMatchObject({ exitCode: 1, check: { exitCode: 1, status: "completed" } });
    expect((await computeReview(repo, head, { evidence: [manifestPath] })).evidence.status).toBe("failed");
  });

  it.each(["fs.writeFileSync('source.js', 'changed');", "execFileSync('git', ['commit', '--allow-empty', '-m', 'concurrent commit']);"])("invalidates commit attribution when the checkout changes: %s", async mutation => {
    expect(await run(validReport + "\n" + mutation)).toMatchObject({ check: { commit: head, workingTreeClean: false } });
    expect((await computeReview(repo, head, { evidence: [manifestPath] })).evidence.status).toBe("incomplete");
  });

  it("cannot reuse a prior passing artifact when the new run produces none", async () => {
    const previous = await run(validReport);
    const next = await run("// no report");
    expect(previous.check.report.path).not.toBe(next.check.report.path);
    expect((await computeReview(repo, head, { evidence: [manifestPath] })).evidence.status).toBe("unavailable");
  });
});
