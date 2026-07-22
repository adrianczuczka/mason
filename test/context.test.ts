import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assembleContext } from "../src/context/assemble.js";
import type { ContextBundle, NoMatchBundle } from "../src/context/assemble.js";
import type { FeatureEntry, FlowEntry } from "../src/snapshot/snapshot.js";

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(["add", "."], dir);
  await git(["commit", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

async function writeSnapshot(
  dir: string,
  gitHash: string,
  features: Record<string, FeatureEntry>,
  flows: Record<string, FlowEntry> = {}
): Promise<void> {
  const now = new Date().toISOString();
  await fs.mkdir(path.join(dir, ".mason"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".mason", "snapshot.json"),
    JSON.stringify({
      version: 2,
      createdAt: now,
      updatedAt: now,
      gitHash,
      features,
      flows,
    })
  );
}

async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

describe("assembleContext", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-context-test-"));
    await git(["init"], tmpDir);
    await git(["config", "user.email", "test@test.com"], tmpDir);
    await git(["config", "user.name", "Test"], tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedProject(): Promise<string> {
    await writeFiles(tmpDir, {
      "src/auth/login.ts": "export function login() {}\n",
      "src/auth/session.ts": "export function session() {}\n",
      "src/weather/forecast.ts": "import { login } from '../auth/login';\nexport function forecast() {}\n",
      "src/billing/invoice.ts": "export function invoice() {}\n",
      "test/login.test.ts": "// tests login\n",
    });
    return commitAll(tmpDir, "initial");
  }

  const FEATURES: Record<string, FeatureEntry> = {
    "user authentication": {
      description: "Login and session handling",
      files: ["src/auth/login.ts", "src/auth/session.ts"],
      tests: ["test/login.test.ts"],
    },
    "weather forecast": {
      description: "Fetches and renders the forecast",
      files: ["src/weather/forecast.ts"],
    },
    billing: {
      description: "Invoice generation",
      files: ["src/billing/invoice.ts"],
    },
  };

  const FLOWS: Record<string, FlowEntry> = {
    "login flow": {
      description: "Credential submission to session creation",
      chain: ["src/auth/login.ts", "src/auth/session.ts"],
    },
  };

  it("returns null when no snapshot exists", async () => {
    await seedProject();
    expect(await assembleContext(tmpDir, "fix the login bug")).toBeNull();
  });

  it("matches features and flows lexically and ranks name hits highest", async () => {
    const hash = await seedProject();
    await writeSnapshot(tmpDir, hash, FEATURES, FLOWS);

    const bundle = (await assembleContext(
      tmpDir,
      "fix a bug in user authentication"
    )) as ContextBundle;

    expect(Object.keys(bundle.features)).toContain("user authentication");
    expect(Object.keys(bundle.features)).not.toContain("billing");
    const auth = bundle.features["user authentication"];
    expect(auth.files).toEqual(["src/auth/login.ts", "src/auth/session.ts"]);
    expect(auth.stale).toBe(false);
    // "authentication" scores on the name; billing never appears
    expect(auth.score).toBeGreaterThan(0);
  });

  it("matches through file-path tokens when the task names a file concept", async () => {
    const hash = await seedProject();
    await writeSnapshot(tmpDir, hash, FEATURES, FLOWS);

    const bundle = (await assembleContext(
      tmpDir,
      "the forecast page renders wrong values"
    )) as ContextBundle;

    expect(Object.keys(bundle.features)).toContain("weather forecast");
  });

  it("boosts entries containing explicitly passed files above lexical matches", async () => {
    const hash = await seedProject();
    await writeSnapshot(tmpDir, hash, FEATURES, FLOWS);

    const bundle = (await assembleContext(tmpDir, "investigate this diff", [
      "src/billing/invoice.ts",
    ])) as ContextBundle;

    expect(Object.keys(bundle.features)).toContain("billing");
    expect(bundle.features["billing"].score).toBeGreaterThanOrEqual(5);
  });

  it("collects related tests from matched features", async () => {
    const hash = await seedProject();
    await writeSnapshot(tmpDir, hash, FEATURES, FLOWS);

    const bundle = (await assembleContext(
      tmpDir,
      "user authentication is broken"
    )) as ContextBundle;

    expect(bundle.relatedTests).toContain("test/login.test.ts");
  });

  it("returns the full catalog when nothing matches", async () => {
    const hash = await seedProject();
    await writeSnapshot(tmpDir, hash, FEATURES, FLOWS);

    const bundle = (await assembleContext(
      tmpDir,
      "zzzquark frobnicate"
    )) as NoMatchBundle;

    expect(bundle.features).toEqual({});
    expect(Object.keys(bundle.availableFeatures)).toEqual(
      expect.arrayContaining(["user authentication", "weather forecast", "billing"])
    );
    expect(bundle.hint).toMatch(/No map entry matched/);
  });

  it("flags matched entries whose files changed since verification", async () => {
    const hash = await seedProject();
    await writeSnapshot(tmpDir, hash, FEATURES, FLOWS);

    await writeFiles(tmpDir, {
      "src/auth/login.ts": "export function login() { /* changed */ }\n",
    });
    await commitAll(tmpDir, "change login");

    const bundle = (await assembleContext(
      tmpDir,
      "user authentication is broken"
    )) as ContextBundle;

    expect(bundle.features["user authentication"].stale).toBe(true);
    expect(bundle.freshness.stale).toBe(true);
    expect(bundle.freshness.staleMatches).toContain("user authentication");
    expect(bundle.hint).toMatch(/changed since they were last verified/);
  });

  it("includes blast radius for the top matched files", async () => {
    const hash = await seedProject();
    await writeSnapshot(tmpDir, hash, FEATURES, FLOWS);

    const bundle = (await assembleContext(
      tmpDir,
      "user authentication is broken"
    )) as ContextBundle;

    expect(bundle.impact).not.toBeNull();
    expect(bundle.impact!.targets).toContain("src/auth/login.ts");
    // forecast.ts imports login — must show up as a reference
    const refFiles = bundle.impact!.references.map((r) => r.file);
    expect(refFiles).toContain("src/weather/forecast.ts");
  });
});
