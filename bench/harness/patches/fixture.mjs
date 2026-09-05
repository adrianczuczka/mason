import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const STAMP = "2026-09-01T00:00:00.000Z";
const INSTRUCTIONS = `# Parcel service

Small dependency-free Node.js service modules. Source lives in src/ and public
tests in test/. Run npm test. Preserve existing public exports and behavior
unless the task requests a change. Engineering history is in docs/decisions.md;
docs/concept-map.md describes the original module layout. Inspect current code
when historical guidance conflicts with it. These documents can be out of date.

If Mason tools are available, call get_context with the task before exploring,
and get_impact before editing. Consult freshness and verification evidence.
`;

function gitOutput(repo, ...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Mason benchmark", GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
      GIT_COMMITTER_NAME: "Mason benchmark", GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
      GIT_AUTHOR_DATE: STAMP, GIT_COMMITTER_DATE: STAMP },
  });
}

export function git(repo, ...args) { return gitOutput(repo, ...args).trim(); }

export async function writeFiles(repo, files) {
  for (const [relative, content] of Object.entries(files)) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error(`Unsafe fixture path: ${relative}`);
    const file = path.join(repo, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

export const digest = content => createHash("sha256").update(content).digest("hex");

/** New checkout for every task × arm × repeat; source commits match both arms. */
export async function prepareFixture(repo, task, arm) {
  if (!["baseline", "mason"].includes(arm)) throw new Error(`Unknown arm: ${arm}`);
  await fs.mkdir(repo, { recursive: false });
  const sources = Object.keys(task.files).filter(f => f.startsWith("src/"));
  const mapFiles = task.mapFiles ?? sources;
  const mapTests = ["test/smoke.test.mjs"];
  const documents = {
    "docs/decisions.md": "# Engineering history\n\n" + (task.decisions.length ? task.decisions.map(d =>
      `## ${d.title}\n\nId: ${d.id}\nAnchors: ${d.files.join(", ")}\nHistory: ${d.freshness}\n\n${d.body}\n`
    ).join("\n") : "No engineering decisions have been recorded.\n"),
    "docs/concept-map.md": `# Original module layout\n\n${task.id}: ${mapFiles.join(", ")}\nTests: ${mapTests.join(", ")}\n\n${task.prompt}\n`,
  };
  await writeFiles(repo, {
    ".gitignore": ".mason/\nnode_modules/\n",
    "package.json": JSON.stringify({ name: "parcel-benchmark-fixture", private: true, type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2) + "\n",
    "CLAUDE.md": INSTRUCTIONS,
    "test/smoke.test.mjs": `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${sources.map((f, i) => `test(${JSON.stringify(f)},async()=>{const module=await import(${JSON.stringify("../" + f)});assert.ok(Object.keys(module).length>0);});`).join("\n")}\n`,
    ...task.files, ...documents,
  });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", `fixture: ${task.id}`);
  const originalCommit = git(repo, "rev-parse", "HEAD");
  if (task.advance) {
    await writeFiles(repo, task.advance);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "fixture: current source supersedes historical context");
  }
  const sourceCommit = git(repo, "rev-parse", "HEAD");
  const snapshot = { version: 2, createdAt: STAMP, updatedAt: STAMP, gitHash: originalCommit,
    features: { [task.id]: { description: task.prompt, files: mapFiles, tests: mapTests } }, flows: {} };
  const records = task.decisions.map(d => ({ version: 1, id: d.id, title: d.title, body: d.body,
    category: "decision", files: d.files, status: "active", createdAt: STAMP, updatedAt: STAMP,
    refreshedHash: d.freshness === "unknown" ? "0".repeat(40) : d.freshness === "stale" ? originalCommit : sourceCommit }));
  if (arm === "mason") {
    await writeFiles(repo, {
      ".mason/project.json": JSON.stringify({ version: 1, initializedAt: STAMP }),
      ".mason/snapshot.json": JSON.stringify(snapshot, null, 2),
      ...Object.fromEntries(records.map(d => [`.mason/decisions/${d.id}.json`, JSON.stringify(d, null, 2)])),
    });
  }
  const initial = await readCheckout(repo, true);
  return { repo, sourceCommit, sourceTree: git(repo, "rev-parse", "HEAD^{tree}"), originalCommit,
    knowledgeDigest: digest(JSON.stringify({ documents, snapshot, records })),
    protectedFiles: Object.fromEntries(Object.entries(initial).filter(([f]) => !f.startsWith("src/") && !f.startsWith("test/"))),
    publicTests: { "test/smoke.test.mjs": initial["test/smoke.test.mjs"] } };
}

/** Export regular files only. The grader never executes inside the agent repo. */
export async function readCheckout(repo, includeMetadata = false) {
  const files = {};
  async function walk(relative = "") {
    for (const entry of await fs.readdir(path.join(repo, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === ".git" || name === "node_modules" || (!includeMetadata && name === ".mason")) continue;
      if (entry.isSymbolicLink()) throw new Error(`Patch contains a symlink: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const file = path.join(repo, name);
        if ((await fs.stat(file)).size > 1024 * 1024) throw new Error(`Patch file exceeds 1 MiB: ${name}`);
        files[name] = await fs.readFile(file, "utf8");
      } else throw new Error(`Patch contains a non-regular file: ${name}`);
      if (Object.keys(files).length > 1000) throw new Error("Patch exceeds fixture file limit");
    }
  }
  await walk();
  return files;
}

export async function checkIntegrity(fixture) {
  const issues = [];
  if (git(fixture.repo, "rev-parse", "HEAD") !== fixture.sourceCommit) issues.push("Agent changed the base commit");
  const files = await readCheckout(fixture.repo, true);
  for (const [file, content] of Object.entries({ ...fixture.protectedFiles, ...fixture.publicTests })) {
    if (files[file] !== content) issues.push(`Protected fixture file changed: ${file}`);
  }
  for (const file of Object.keys(files)) {
    if (!file.startsWith("src/") && !file.startsWith("test/") && !(file in fixture.protectedFiles)) issues.push(`Unexpected control file: ${file}`);
  }
  return issues;
}

export function capturePatch(fixture) {
  let patch = gitOutput(fixture.repo, "diff", "--binary", fixture.sourceCommit, "--");
  const untracked = gitOutput(fixture.repo, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  for (const file of untracked) {
    try { patch += gitOutput(fixture.repo, "diff", "--no-index", "--binary", "--", "/dev/null", file); }
    catch (error) { if (error.status !== 1) throw error; patch += error.stdout; }
  }
  return patch;
}
