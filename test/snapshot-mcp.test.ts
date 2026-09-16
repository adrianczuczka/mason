import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveSnapshotData } from "../src/mcp/tools.js";
import { withSnapshotWrite } from "../src/snapshot/lock.js";
import { initGitRepo, commitAll } from "./helpers.js";

const server = path.resolve("dist/mason-mcp.js");
let repo: string, control: string, preload: string;
let clients: Client[];
const exists = async (file: string) => { await expect(fs.access(file)).resolves.toBeUndefined(); };
const waitForFile = (file: string) => vi.waitFor(() => exists(file), { timeout: 5000, interval: 10 });

async function connect(barrier?: string, attempted?: string, lockStage?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", pathToFileURL(preload).href, server], cwd: repo,
    env: { ...process.env, MASON_TEST_BARRIER: barrier ?? "", MASON_TEST_ATTEMPTED: attempted ?? "", MASON_TEST_LOCK_STAGE: lockStage ?? "" } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "snapshot-regression", version: "1" });
  clients.push(client);
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: { dir: repo, ...args } });
    if (response.isError) throw new Error(JSON.stringify(response));
    return JSON.parse((response.content as Array<{ text: string }>)[0].text);
  };
  return { call, transport };
}
const repairArgs = { features: { greeting: { description: "CORRECTED", files: ["src/a.js"] } }, flows: {}, removeFlows: ["hello to world"] };
const snapshot = async () => JSON.parse(await fs.readFile(path.join(repo, ".mason/snapshot.json"), "utf8"));
async function verdict(call: Awaited<ReturnType<typeof connect>>["call"]) {
  const reviewed = await call("verify_snapshot", { sample: 10 });
  const entry = reviewed.entries.find((e: { name: string }) => e.name === "greeting");
  return { verdicts: { greeting: { ok: true, kind: entry.kind, reviewToken: entry.reviewToken } } };
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "mason-snapshot-mcp-"));
  control = await fs.mkdtemp(path.join(os.tmpdir(), "mason-snapshot-barrier-"));
  clients = [];
  await initGitRepo(repo);
  await fs.mkdir(path.join(repo, "src"));
  await fs.writeFile(path.join(repo, "src/a.js"), "export const hello = 'hello';\n");
  await fs.writeFile(path.join(repo, "src/b.js"), "export const world = 'world';\n");
  await commitAll(repo, "source");
  await saveSnapshotData(repo, { greeting: { description: "ORIGINAL", files: ["src/a.js"] } }, {
    "hello to world": { description: "a flow", chain: ["src/a.js", "src/b.js"] },
  });
  // Interpose only in these child processes. The production server has no test
  // hooks: pause its actual atomic rename while it holds a real write lock.
  preload = path.join(control, "barrier.mjs");
  await fs.writeFile(preload, `
import fs from 'node:fs/promises';
import path from 'node:path';
const rename = fs.rename, open = fs.open, unlink = fs.unlink;
let held = false;
async function hold() {
  held = true;
  const barrier = process.env.MASON_TEST_BARRIER;
  await fs.writeFile(barrier + '.ready', 'ready');
  while (true) {
    try { await fs.access(barrier + '.release'); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
fs.open = async (...args) => {
  if (process.env.MASON_TEST_ATTEMPTED && path.basename(String(args[0])) === 'lock' && path.basename(path.dirname(String(args[0]))) === 'snapshot-write') {
    await fs.writeFile(process.env.MASON_TEST_ATTEMPTED, 'attempted');
  }
  const handle = await open(...args);
  const stage = process.env.MASON_TEST_LOCK_STAGE;
  if (!held && args[1] === 'wx' && path.basename(path.dirname(String(args[0]))) === 'snapshot-write' &&
      ((stage === 'before-owner' && path.basename(String(args[0])) === 'lock') ||
       (stage === 'before-reclaim' && path.basename(String(args[0])) === 'lock.reclaim'))) await hold();
  return handle;
};
fs.unlink = async (...args) => {
  const result = await unlink(...args);
  if (!held && process.env.MASON_TEST_LOCK_STAGE === 'after-reclaim' && path.basename(String(args[0])) === 'lock' &&
      path.basename(path.dirname(String(args[0]))) === 'snapshot-write') await hold();
  return result;
};
fs.rename = async (...args) => {
  const barrier = process.env.MASON_TEST_BARRIER;
  if (barrier && !held && !process.env.MASON_TEST_LOCK_STAGE && path.basename(String(args[1])) === 'snapshot.json') await hold();
  return rename(...args);
};
`);
});
afterEach(async () => {
  await Promise.allSettled(clients.map(client => client.close()));
  await fs.rm(repo, { recursive: true, force: true });
  await fs.rm(control, { recursive: true, force: true });
});

describe("snapshot writes through the built MCP server", { timeout: 15000 }, () => {
  it("repairs then verifies sequentially in one session and guides legacy clients", async () => {
    const { call } = await connect();
    await call("save_snapshot", repairArgs);
    const before = await snapshot();
    expect(await call("save_verification", { verdicts: { greeting: { ok: true } } })).toMatchObject({ status: "review_required", stamped: [] });
    expect(await snapshot()).toEqual(before);
    expect(await call("save_verification", await verdict(call))).toMatchObject({ status: "saved", stamped: ["greeting"] });
    const saved = await snapshot();
    expect(saved.features.greeting).toMatchObject({ description: "CORRECTED", verifiedAt: expect.any(String) });
    expect(saved.flows).toEqual({});
  });

  it.each([
    ["same session", "verification"], ["same session", "repair"],
    ["separate processes", "verification"], ["separate processes", "repair"],
  ])("serializes %s with %s first", async (mode, first) => {
    const barrier = path.join(control, "write"), attempted = path.join(control, "attempted");
    const a = await connect(barrier, attempted);
    const b = mode === "same session" ? a : await connect(undefined, attempted);
    const args = await verdict(a.call);
    const held = a.call(first === "verification" ? "save_verification" : "save_snapshot", first === "verification" ? args : repairArgs);
    await waitForFile(barrier + ".ready");
    await fs.rm(attempted, { force: true });
    let finished = false;
    const waiting = b.call(first === "verification" ? "save_snapshot" : "save_verification", first === "verification" ? repairArgs : args)
      .then(result => { finished = true; return result; });
    try {
      await waitForFile(attempted);
      expect(finished).toBe(false);
      expect((await snapshot()).features.greeting.description).toBe("ORIGINAL");
    } finally { await fs.writeFile(barrier + ".release", "release"); }
    const results = await Promise.all([held, waiting]);
    if (first === "repair") expect(results[1]).toMatchObject({ status: "conflict", stamped: [], conflicts: ["greeting"] });
    const saved = await snapshot();
    expect(saved.features.greeting.description).toBe("CORRECTED");
    expect(saved.flows).toEqual({});
    expect(saved.features.greeting.verifiedAt).toBeUndefined();
  });

  it("retains independent edits from simultaneous requests in separate processes", async () => {
    const a = await connect(), b = await connect();
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).call("save_snapshot", {
      features: { [`feature-${i}`]: { description: `Feature ${i}`, files: ["src/a.js"] } }, flows: {},
    })));
    const saved = await snapshot();
    expect(Object.keys(saved.features)).toHaveLength(9);
    for (let i = 0; i < 8; i++) expect(saved.features[`feature-${i}`].description).toBe(`Feature ${i}`);
  });

  it("recovers a terminated writer and retains the last complete snapshot", async () => {
    const barrier = path.join(control, "crash");
    const a = await connect(barrier);
    const before = await snapshot();
    const pending = a.call("save_snapshot", repairArgs).catch(error => error);
    await waitForFile(barrier + ".ready");
    process.kill(a.transport.pid!, "SIGKILL");
    expect(await pending).toBeInstanceOf(Error);
    expect(await snapshot()).toEqual(before);
    const b = await connect();
    expect(await b.call("save_snapshot", repairArgs)).toMatchObject({ status: "updated" });
    const saved = await snapshot();
    expect(saved.features.greeting.description).toBe("CORRECTED");
    expect(saved.flows).toEqual({});
    await expect(fs.access(path.join(repo, ".mason/local/snapshot-write/lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["before-owner", "before-reclaim", "after-reclaim"])("preserves data and diagnoses an interrupted lock at %s", async stage => {
    const before = await snapshot();
    const lock = path.join(repo, ".mason/local/snapshot-write/lock");
    async function interrupt(label: string, lockStage?: string) {
      const barrier = path.join(control, label);
      const writer = await connect(barrier, undefined, lockStage);
      const pending = writer.call("save_snapshot", repairArgs).catch(error => error);
      await waitForFile(barrier + ".ready");
      process.kill(writer.transport.pid!, "SIGKILL");
      expect(await pending).toBeInstanceOf(Error);
      await writer.transport.close();
    }
    if (stage !== "before-owner") await interrupt("dead-writer");
    await interrupt("interrupted-recovery", stage);
    if (stage === "after-reclaim") {
      await expect(fs.access(lock)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(withSnapshotWrite(repo, async () => "normal writes still work", 0)).resolves.toBe("normal writes still work");
      // The orphaned guard only blocks a later dead writer's recovery.
      await interrupt("later-dead-writer");
    }
    const owner = await fs.readFile(lock, "utf8");
    const run = vi.fn(async () => {});
    await expect(withSnapshotWrite(repo, run, 0)).rejects.toThrow(stage === "before-owner" ? "incomplete or malformed" : "lock.reclaim");
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readFile(lock, "utf8")).toBe(owner);
    expect(await snapshot()).toEqual(before);
    // Every child writer has exited; exercise the documented manual recovery.
    await fs.rm(lock, { force: true });
    await fs.rm(lock + ".reclaim", { force: true });
    const recovered = await connect();
    expect(await recovered.call("save_snapshot", repairArgs)).toMatchObject({ status: "updated" });
    expect((await snapshot()).features.greeting.description).toBe("CORRECTED");
  });

  it("reports a historical verdict as stale after reverting the local code it reviewed", async () => {
    const { call } = await connect();
    const file = path.join(repo, "src/a.js");
    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "export const hello = 'reviewed local edit';\n");
    await call("save_verification", await verdict(call));
    await fs.writeFile(file, original);
    expect((await call("get_snapshot", {})).trust.features.greeting).toMatchObject({ freshness: "current", verification: "stale", recordedVerdict: "passed" });
    expect((await call("get_context", { task: "greeting" })).features.greeting.trust).toMatchObject({ verification: "stale", recordedVerdict: "passed" });
  });
});
