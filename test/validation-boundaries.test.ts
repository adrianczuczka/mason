import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveCountSource } from "../src/audit/checks/stale-count.js";
import { matchDependencyChanges } from "../src/audit/dependency-claims.js";
import { initGitRepo, commitAll } from "./helpers.js";
import { loadProjectConfig } from "../src/utils/files.js";
import { runHook } from "../src/hook/hook.js";
import { withStoreLock } from "../src/utils/store-lock.js";
import { retrievedDecisions } from "../src/automation/usefulness.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-validation-"));
  await fs.mkdir(path.join(root, ".mason"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it.each([{ patterns: ["src/**", 42] }, { audit: { include: [42] } }, { audit: { exclude: [] } }])(
  "rejects malformed project policy %j",
  async (value) => {
    await fs.writeFile(path.join(root, ".mason/config.json"), JSON.stringify(value));
    await expect(loadProjectConfig(root)).rejects.toThrow("Cannot apply project file policy");
  },
);

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
