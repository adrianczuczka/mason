import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as storage from "../src/utils/storage.js";
import { saveSnapshotData, saveVerification, verifySnapshot } from "../src/mcp/tools.js";
import { withSnapshotWrite } from "../src/snapshot/lock.js";
import { savePartial, loadAllPartials } from "../src/snapshot/partials.js";
import type { Snapshot } from "../src/snapshot/snapshot.js";
import { initGitRepo, commitAll } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("snapshot writer isolation", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "mason-snapshot-race-"));
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "src"));
    await fs.writeFile(path.join(repo, "src/a.js"), "export const hello = 'hello';\n");
    await fs.writeFile(path.join(repo, "src/b.js"), "export const world = 'world';\n");
    await commitAll(repo, "source");
    await saveSnapshotData(repo, {
      greeting: { description: "ORIGINAL", files: ["src/a.js"] },
    }, { "hello to world": { description: "a flow", chain: ["src/a.js", "src/b.js"] } });
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(repo, { recursive: true, force: true }); });

  it("never restores an old description or deleted flow when verification overlaps a repair", async () => {
    const entry = JSON.parse(await verifySnapshot(repo)).entries.find((e: { name: string }) => e.name === "greeting");
    const ready = deferred(), resume = deferred(), contended = deferred();
    const write = storage.writeStoreJson;
    vi.spyOn(storage, "writeStoreJson").mockImplementation(async (root, relative, value) => {
      if (relative === ".mason/snapshot.json" && (value as Snapshot).features.greeting.verifiedAt) {
        ready.resolve();
        await resume.promise;
      }
      return write(root, relative, value);
    });
    const verification = saveVerification(repo, { greeting: { ok: true, kind: "feature", reviewToken: entry.reviewToken } });
    await ready.promise;
    // Observe the second writer's lock attempt. Without isolation it completes
    // its write instead. Either event releases the first writer without sleeps.
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (path.basename(String(args[0])) === "lock" && path.basename(path.dirname(String(args[0]))) === "snapshot-write") contended.resolve();
      return open(...args);
    });
    const repair = saveSnapshotData(repo, {
      greeting: { description: "CORRECTED", files: ["src/a.js"] },
    }, {}, [], ["hello to world"]);
    try { await Promise.race([repair, contended.promise]); }
    finally { resume.resolve(); }
    await Promise.all([verification, repair]);
    const saved = JSON.parse(await fs.readFile(path.join(repo, ".mason/snapshot.json"), "utf8"));
    expect(saved.features.greeting.description).toBe("CORRECTED");
    expect(saved.flows).toEqual({});
    // A content edit after verification correctly invalidates that verdict.
    expect(saved.features.greeting.verifiedAt).toBeUndefined();
  });

  it("keeps a partial submitted during consolidation after the old partials are cleared", async () => {
    await savePartial(repo, { batchId: "old", offset: 0, features: {}, flows: {}, savedAt: new Date().toISOString() });
    const ready = deferred(), resume = deferred(), contended = deferred();
    const write = storage.writeStoreJson;
    vi.spyOn(storage, "writeStoreJson").mockImplementation(async (root, relative, value) => {
      if (relative === ".mason/snapshot.json") { ready.resolve(); await resume.promise; }
      return write(root, relative, value);
    });
    const consolidation = saveSnapshotData(repo, { greeting: { description: "CONSOLIDATED", files: ["src/a.js"] } }, {});
    await ready.promise;
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (path.basename(String(args[0])) === "lock" && path.basename(path.dirname(String(args[0]))) === "snapshot-write") contended.resolve();
      return open(...args);
    });
    const incoming = savePartial(repo, { batchId: "new", offset: 50, features: {}, flows: {}, savedAt: new Date().toISOString() });
    try { await contended.promise; }
    finally { resume.resolve(); }
    await Promise.all([consolidation, incoming]);
    expect((await loadAllPartials(repo)).map(partial => partial.batchId)).toEqual(["new"]);
  });

  it("leaves a complete snapshot and releases the lock after a write failure", async () => {
    const file = path.join(repo, ".mason/snapshot.json");
    const before = await fs.readFile(file, "utf8");
    vi.spyOn(storage, "writeStoreJson").mockRejectedValueOnce(new Error("controlled disk failure"));
    await expect(saveSnapshotData(repo, { greeting: { description: "FAILED", files: [] } }, {})).rejects.toThrow("controlled disk failure");
    expect(await fs.readFile(file, "utf8")).toBe(before);
    await saveSnapshotData(repo, { greeting: { description: "RECOVERED", files: [] } }, {});
    expect(JSON.parse(await fs.readFile(file, "utf8")).features.greeting.description).toBe("RECOVERED");
  });

  it("returns an actionable contention error without taking over a live lock", async () => {
    const file = path.join(repo, ".mason/local/snapshot-write/lock");
    await withSnapshotWrite(repo, async () => {
      const owner = await fs.readFile(file, "utf8");
      await expect(withSnapshotWrite(repo, async () => { throw new Error("must not run"); }, 0)).rejects.toThrow("Snapshot store is busy");
      expect(await fs.readFile(file, "utf8")).toBe(owner);
    });
  });

  it.each(["malformed", "remote"])("preserves a %s lock instead of guessing it is abandoned", async state => {
    const file = path.join(repo, ".mason/local/snapshot-write/lock");
    const owner = state === "malformed" ? "{broken" : JSON.stringify({ pid: process.pid, host: "another-machine" });
    await fs.writeFile(file, owner);
    await expect(withSnapshotWrite(repo, async () => {}, 0)).rejects.toThrow("lock needs inspection");
    expect(await fs.readFile(file, "utf8")).toBe(owner);
  });

  it.skipIf(process.platform === "win32")("uses the same lock through a repository path alias", async () => {
    const alias = repo + "-alias";
    await fs.symlink(repo, alias);
    try {
      await withSnapshotWrite(repo, async () => {
        await expect(withSnapshotWrite(alias, async () => {}, 0)).rejects.toThrow("Snapshot store is busy");
      });
    } finally { await fs.unlink(alias); }
  });

});
