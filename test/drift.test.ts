import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { computeDrift } from "../src/drift/drift.js";
import type { FeatureEntry, FlowEntry } from "../src/snapshot/snapshot.js";
import { git, commitAll } from "./helpers.js";

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

describe("computeDrift", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-drift-test-"));
    await git(["init"], tmpDir);
    await git(["config", "user.email", "test@test.com"], tmpDir);
    await git(["config", "user.name", "Test"], tmpDir);
    await fs.mkdir(path.join(tmpDir, "src"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no snapshot exists", async () => {
    expect(await computeDrift(tmpDir)).toBeNull();
  });

  it("reports up-to-date when the snapshot matches HEAD", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    const hash = await commitAll(tmpDir, "feat: add a");
    await writeSnapshot(tmpDir, hash, {
      core: { description: "core", files: ["src/a.ts"] },
    });

    const report = await computeDrift(tmpDir);
    expect(report).not.toBeNull();
    expect(report!.stale).toBe(false);
    expect(report!.recommendation).toBe("up-to-date");
    expect(report!.commitsBehind).toBe(0);
    expect(report!.staleFeatures).toEqual({});
  });

  it("flags features whose files were modified", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 1;\n");
    const hash = await commitAll(tmpDir, "feat: add a and b");
    await writeSnapshot(tmpDir, hash, {
      alpha: { description: "alpha", files: ["src/a.ts"] },
      beta: { description: "beta", files: ["src/b.ts"] },
    });

    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 2;\n");
    await commitAll(tmpDir, "fix: bump a");

    const report = await computeDrift(tmpDir);
    expect(report!.stale).toBe(true);
    expect(report!.historyAvailable).toBe(true);
    expect(report!.commitsBehind).toBe(1);
    expect(report!.changedFiles).toEqual(["src/a.ts"]);
    expect(report!.staleFeatures).toEqual({ alpha: ["src/a.ts"] });
    expect(report!.staleFlows).toEqual({});
    expect(report!.recommendation).toBe("incremental");
  });

  it("flags flows whose chain files were modified", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 1;\n");
    const hash = await commitAll(tmpDir, "feat: add a and b");
    await writeSnapshot(
      tmpDir,
      hash,
      { alpha: { description: "alpha", files: ["src/a.ts"] } },
      { fetch: { description: "fetch flow", chain: ["src/a.ts", "src/b.ts"] } }
    );

    await fs.writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 2;\n");
    await commitAll(tmpDir, "fix: bump b");

    const report = await computeDrift(tmpDir);
    expect(report!.staleFeatures).toEqual({});
    expect(report!.staleFlows).toEqual({ fetch: ["src/b.ts"] });
  });

  it("reports deleted mapped files as ghosts and marks the feature stale", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 1;\n");
    const hash = await commitAll(tmpDir, "feat: add a and b");
    await writeSnapshot(tmpDir, hash, {
      alpha: { description: "alpha", files: ["src/a.ts", "src/b.ts"] },
    });

    await fs.rm(path.join(tmpDir, "src", "b.ts"));
    await commitAll(tmpDir, "refactor: drop b");

    const report = await computeDrift(tmpDir);
    expect(report!.ghostFiles).toEqual(["src/b.ts"]);
    expect(report!.staleFeatures).toEqual({ alpha: ["src/b.ts"] });
  });

  it("reports new source files missing from the map", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    const hash = await commitAll(tmpDir, "feat: add a");
    await writeSnapshot(tmpDir, hash, {
      alpha: { description: "alpha", files: ["src/a.ts"] },
    });

    await fs.writeFile(path.join(tmpDir, "src", "c.ts"), "export const c = 1;\n");
    await commitAll(tmpDir, "feat: add c");

    const report = await computeDrift(tmpDir);
    expect(report!.unmappedFiles).toEqual(["src/c.ts"]);
    expect(report!.staleFeatures).toEqual({});
    expect(report!.recommendation).toBe("incremental");
  });

  it("tracks renames and marks the affected feature stale", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "old.ts"),
      "export const value = 42;\nexport function compute(): number { return value; }\n"
    );
    const hash = await commitAll(tmpDir, "feat: add old");
    await writeSnapshot(tmpDir, hash, {
      alpha: { description: "alpha", files: ["src/old.ts"] },
    });

    await git(["mv", "src/old.ts", "src/new.ts"], tmpDir);
    await commitAll(tmpDir, "refactor: rename old to new");

    const report = await computeDrift(tmpDir);
    expect(report!.renames).toEqual([{ from: "src/old.ts", to: "src/new.ts" }]);
    expect(report!.staleFeatures).toEqual({ alpha: ["src/old.ts"] });
    expect(report!.ghostFiles).toEqual(["src/old.ts"]);
    expect(report!.unmappedFiles).toEqual(["src/new.ts"]);
  });

  it("detects stale entries even when the top-level hash is at HEAD", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 1;\n");
    const firstHash = await commitAll(tmpDir, "feat: add a and b");

    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 2;\n");
    await fs.writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 2;\n");
    const secondHash = await commitAll(tmpDir, "fix: bump both");

    // A partial refresh: alpha was re-verified at HEAD, beta was skipped and
    // is still pinned to the first commit — the top-level hash alone would
    // hide beta's staleness.
    await writeSnapshot(tmpDir, secondHash, {
      alpha: {
        description: "alpha",
        files: ["src/a.ts"],
        refreshedHash: secondHash,
      },
      beta: {
        description: "beta",
        files: ["src/b.ts"],
        refreshedHash: firstHash,
      },
    });

    const report = await computeDrift(tmpDir);
    expect(report!.stale).toBe(true);
    expect(report!.staleFeatures).toEqual({ beta: ["src/b.ts"] });
    expect(report!.recommendation).toBe("incremental");
    expect(report!.commitsBehind).toBe(1);
  });

  it("falls back to full-rebuild when the snapshot commit is unreachable", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await commitAll(tmpDir, "feat: add a");
    // A syntactically valid hash that exists in no repository
    await writeSnapshot(tmpDir, "0123456789abcdef0123456789abcdef01234567", {
      alpha: { description: "alpha", files: ["src/a.ts"] },
    });

    const report = await computeDrift(tmpDir);
    expect(report!.stale).toBe(true);
    expect(report!.historyAvailable).toBe(false);
    expect(report!.commitsBehind).toBeNull();
    expect(report!.recommendation).toBe("full-rebuild");
  });

  it("recommends full-rebuild when most of the map changed", async () => {
    const fileCount = 12;
    const files: string[] = [];
    for (let i = 0; i < fileCount; i++) {
      const file = `src/f${i}.ts`;
      files.push(file);
      await fs.writeFile(path.join(tmpDir, file), `export const f${i} = 1;\n`);
    }
    const hash = await commitAll(tmpDir, "feat: add all");
    await writeSnapshot(tmpDir, hash, {
      everything: { description: "everything", files },
    });

    // Touch 11 of 12 mapped files — over both full-rebuild thresholds
    for (let i = 0; i < fileCount - 1; i++) {
      await fs.writeFile(
        path.join(tmpDir, `src/f${i}.ts`),
        `export const f${i} = 2;\n`
      );
    }
    await commitAll(tmpDir, "refactor: rewrite almost everything");

    const report = await computeDrift(tmpDir);
    expect(report!.recommendation).toBe("full-rebuild");
    expect(report!.historyAvailable).toBe(true);
  });
});
