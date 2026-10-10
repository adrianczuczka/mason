import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveCountSource } from "../src/audit/checks/stale-count.js";
import { matchDependencyChanges } from "../src/audit/dependency-claims.js";
import { initGitRepo, commitAll } from "./helpers.js";
import { loadConfig } from "../src/llm/config.js";
import { loadProjectConfig } from "../src/utils/files.js";
import { loadSyncState } from "../src/confluence/diff.js";
import { rewriteForProduct } from "../src/confluence/rewrite.js";
import { runHook } from "../src/hook/hook.js";
import { withStoreLock } from "../src/utils/store-lock.js";
import { retrievedDecisions } from "../src/automation/usefulness.js";
import type { Snapshot } from "../src/snapshot/snapshot.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-validation-"));
  await fs.mkdir(path.join(root, ".mason"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it.each([
  null,
  [],
  { provider: "unknown" },
  { provider: "claude", model: 42 },
  { provider: "claude", confluence: { baseUrl: 42 } },
])("treats malformed user configuration %j as unavailable", async (value) => {
  vi.spyOn(os, "homedir").mockReturnValue(root);
  await fs.writeFile(path.join(root, ".mason/config.json"), JSON.stringify(value));
  expect(await loadConfig()).toBeNull();
});

it.each([{ patterns: ["src/**", 42] }, { audit: { include: [42] } }, { audit: { exclude: [] } }])(
  "rejects malformed project policy %j",
  async (value) => {
    await fs.writeFile(path.join(root, ".mason/config.json"), JSON.stringify(value));
    await expect(loadProjectConfig(root)).rejects.toThrow("Cannot apply project file policy");
  },
);

const validSyncState = {
  version: 2,
  syncedAt: "2026-10-07T00:00:00Z",
  pageIds: { features: {} },
  lastSnapshot: { features: {}, flows: {} },
  changelogSections: [],
  rewriteCache: { features: {}, flows: {} },
};
it.each([
  null,
  [],
  { version: 2 },
  { ...validSyncState, lastSnapshot: { features: { Checkout: { description: 42 } }, flows: {} } },
  { ...validSyncState, rewriteCache: { features: [], flows: {} } },
])("treats malformed sync state %j as absent", async (value) => {
  await fs.writeFile(path.join(root, ".mason/confluence-sync.json"), JSON.stringify(value));
  expect(await loadSyncState(root)).toBeNull();
});

it("loads valid configuration with all optional provider and Confluence settings", async () => {
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const config = {
    provider: "claude",
    apiKey: "test-key",
    model: "test-model",
    ollamaHost: "http://localhost:11434",
    confluence: {
      baseUrl: "https://wiki.invalid",
      email: "test@example.invalid",
      apiToken: "test-token",
      spaceKey: "TEST",
      parentPageId: "123",
    },
  };
  await fs.writeFile(path.join(root, ".mason/config.json"), JSON.stringify(config));
  expect(await loadConfig()).toEqual(config);
});

it.each([
  { workspaces: ["packages/*", 42] },
  { workspaces: { packages: ["packages/*", 42] } },
  { workspaces: 42 },
])("cannot establish a workspace count from malformed declaration %j", async ({ workspaces }) => {
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces }));
  expect(
    await resolveCountSource(root, {
      count: 1,
      unit: "workspaces",
      line: 1,
      excerpt: "1 workspace",
    }),
  ).toBeNull();
});

it.each([
  ["package.json", '{"dependencies":{"zod":"3"}}', '{"dependencies":["zod"]}'],
  ["package.json", '{"dependencies":{"zod":"3"}}', '{"dependencies":{"zod":42}}'],
  ["libs.versions.toml", '[libraries]\nzod = "example:zod:3"\n', 'libraries = ["example:zod:4"]\n'],
])("retains incomplete dependency evidence for malformed %s", async (file, before, after) => {
  await initGitRepo(root);
  await fs.writeFile(path.join(root, file), before);
  const base = await commitAll(root, "valid manifest");
  await fs.writeFile(path.join(root, file), after);
  const head = await commitAll(root, "malformed manifest");
  expect(await matchDependencyChanges(root, base, head, [file], "Use zod 3.")).toEqual({
    matches: [],
    incomplete: true,
  });
});

it.each([{ session_id: 42 }, { agent_id: {} }, { cwd: [] }, { tool_input: { file_path: 42 } }])(
  "keeps malformed hook input %j silent",
  async (value) => {
    expect(await runHook(JSON.stringify(value))).toBeNull();
  },
);

it.each([null, [], { host: os.hostname(), pid: "12345" }, { host: os.hostname(), pid: -1 }])(
  "retains a lock with malformed owner %j",
  async (value) => {
    await fs.mkdir(path.join(root, "locks"));
    const file = path.join(root, "locks/lock");
    const raw = JSON.stringify(value);
    await fs.writeFile(file, raw);
    const write = vi.fn(async () => {});
    await expect(withStoreLock(root, "locks", write, 0)).rejects.toThrow("incomplete or malformed");
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  },
);

it("ignores malformed MCP blocks while recognizing a valid text response", () => {
  const tool = "mason__get_context";
  expect(
    retrievedDecisions(tool, { content: [null, 42, { type: "text", text: 42 }] }),
  ).toBeUndefined();
  expect(
    retrievedDecisions(tool, {
      content: [null, { type: "text", text: '{"decisions":{"accepted-id":{}}}' }],
    }),
  ).toEqual(["accepted-id"]);
  expect(retrievedDecisions(tool, { decisions: [] })).toBeUndefined();
});

it("falls back on invalid model descriptions while preserving valid prose", async () => {
  const snapshot = {
    features: {
      Checkout: { description: "Engineering checkout description", files: [] },
      Search: { description: "Engineering search description", files: [] },
    },
    flows: {},
  } as unknown as Snapshot;
  const result = await rewriteForProduct(
    snapshot,
    { provider: "claude" },
    {
      llm: async () => ({
        type: "response",
        text: JSON.stringify({
          features: { Checkout: ["invalid"], Search: "People can search." },
          flows: [],
        }),
      }),
    },
  );
  expect(result.features).toEqual({
    Checkout: "Engineering checkout description",
    Search: "People can search.",
  });
  expect(result.cache.features.Checkout.fallback).toBe(true);
  expect(result.cache.features.Search.fallback).toBeUndefined();
});
