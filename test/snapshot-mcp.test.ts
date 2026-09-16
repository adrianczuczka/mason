import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveSnapshotData } from "../src/mcp/tools.js";
import { initGitRepo, commitAll } from "./helpers.js";

const server = path.resolve("dist/mason-mcp.js");
let repo: string, control: string, preload: string;
let clients: Client[];
const exists = async (file: string) => { await expect(fs.access(file)).resolves.toBeUndefined(); };
const waitForFile = (file: string) => vi.waitFor(() => exists(file), { timeout: 5000, interval: 10 });

async function connect(barrier?: string, attempted?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", pathToFileURL(preload).href, server], cwd: repo,
    env: { ...process.env, MASON_TEST_BARRIER: barrier ?? "", MASON_TEST_ATTEMPTED: attempted ?? "" } as Record<string, string>,
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
const rename = fs.rename, open = fs.open;
let held = false;
fs.open = async (...args) => {
  if (process.env.MASON_TEST_ATTEMPTED && path.basename(String(args[0])) === 'lock' && path.basename(path.dirname(String(args[0]))) === 'snapshot-write') {
    await fs.writeFile(process.env.MASON_TEST_ATTEMPTED, 'attempted');
  }
  return open(...args);
};
fs.rename = async (...args) => {
  const barrier = process.env.MASON_TEST_BARRIER;
  if (barrier && !held && path.basename(String(args[1])) === 'snapshot.json') {
    held = true;
    await fs.writeFile(barrier + '.ready', 'ready');
    while (true) {
      try { await fs.access(barrier + '.release'); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
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
});
