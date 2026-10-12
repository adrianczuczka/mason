import { configureProject } from "./helpers.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runAutomationHook } from "../src/automation/adapters.js";
import { automate } from "../src/automation/runtime.js";
import { workspace } from "../src/automation/evidence.js";
import { upsertDecision } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import * as launcher from "../src/setup/launcher.js";
import { commitAll, initGitRepo } from "./helpers.js";

let temp: string, root: string, id: string, session: string;
const body =
  "The startup database constructor is invoked by reflection. Preserve it under release shrinking.";
const invoke = (
  event: string,
  tool = "Read",
  file = "src/startup.ts",
  host: "claude" | "codex" = "claude",
) =>
  runAutomationHook(
    host,
    JSON.stringify({
      cwd: root,
      session_id: session,
      hook_event_name: event,
      tool_name: tool,
      tool_use_id: randomUUID(),
      tool_input: { file_path: path.resolve(root, file) },
    }),
    { managed: true },
  );
const context = (output: Record<string, any> | null) =>
  output?.hookSpecificOutput?.additionalContext ?? "";
async function verdict(action: "accept" | "retire") {
  const prepared = await reviewDecision(root, { id, action: "prepare" });
  expect(prepared.status).toBe("prepared");
  const result = await reviewDecision(root, {
    id,
    action,
    reviewToken: prepared.reviewToken,
    reviewer: "Fixture reviewer",
    note: "Synthetic reviewed startup rule",
  });
  expect(result.status).toBe(action === "accept" ? "accepted" : "retired");
}
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-standard-delivery-")));
  root = path.join(temp, "project");
  session = randomUUID();
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await initGitRepo(root);
  await fs.writeFile(path.join(root, "src/startup.ts"), "export const startup = true;\n");
  await fs.writeFile(path.join(root, "README.md"), "# Project\nStartup: `src/startup.ts`.\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".mason/reports/\n.mason/local/\n");
  await commitAll(root, "source");
  const saved = await upsertDecision(root, {
    title: "Reflective startup constructor",
    body,
    category: "gotcha",
    files: ["src/startup.ts"],
    owner: "Fixture team",
    sources: [{ kind: "document", reference: "README.md" }],
  });
  if (saved.status !== "created") throw new Error(JSON.stringify(saved));
  id = saved.id;
  await verdict("accept");
  await commitAll(root, "review lesson");
  vi.stubGlobal("PKG_VERSION", "test");
  vi.spyOn(launcher, "installedCommand").mockResolvedValue({
    available: true,
    version: "test",
    message: null,
  });
  for (const key of ["MASON_SETUP_ROOT", "MASON_SETUP_HOST", "MASON_SETUP_REVISION"])
    vi.stubEnv(key, undefined);
  await configureProject(root, { host: "claude" });
  await configureProject(root, { host: "codex" });
  await commitAll(root, "setup");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(temp, { recursive: true, force: true });
});

it("delivers after a supported read without advancing audit evidence and deduplicates before edits", async () => {
  await automate(root, { event: "turn_start" });
  const ws = await workspace(root);
  const before = await fs.readFile(path.join(root, ws.directory, "execution.json"), "utf8");
  expect(context(await invoke("PreToolUse"))).not.toContain(body);
  const delivered = await invoke("PostToolUse");
  expect(delivered).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse" } });
  expect(context(delivered)).toContain(body);
  expect(context(delivered)).toContain("[accepted]");
  expect(await fs.readFile(path.join(root, ws.directory, "execution.json"), "utf8")).toBe(before);
  expect(context(await invoke("PostToolUse"))).not.toContain(body);
  expect(context(await invoke("PreToolUse", "Edit"))).not.toContain(body);
  expect(await fs.readFile(path.join(root, "src/startup.ts"), "utf8")).toBe(
    "export const startup = true;\n",
  );
}, 20000);

it.each(["Edit", "Write"])(
  "delivers before first %s when there was no read",
  async (tool) => {
    const delivered = await invoke("PreToolUse", tool);
    expect(delivered).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    expect(context(delivered)).toContain(body);
    expect(await fs.readFile(path.join(root, "src/startup.ts"), "utf8")).toBe(
      "export const startup = true;\n",
    );
    expect(context(await invoke("PreToolUse", tool))).not.toContain(body);
  },
  20000,
);

it("keeps unrelated paths, shell commands, unsupported hosts and foreign checkouts quiet", async () => {
  expect(context(await invoke("PostToolUse", "Read", "README.md"))).not.toContain(body);
  expect(context(await invoke("PostToolUse", "Bash"))).not.toContain(body);
  expect(context(await invoke("PostToolUse", "Read", "src/startup.ts", "codex"))).not.toContain(
    body,
  );
  const foreign = path.join(temp, "foreign");
  await fs.mkdir(path.join(foreign, "src"), { recursive: true });
  await initGitRepo(foreign);
  await fs.writeFile(path.join(foreign, "src/startup.ts"), "export {};\n");
  await commitAll(foreign, "foreign source");
  await upsertDecision(foreign, {
    title: "Foreign rule",
    body: "Never leak foreign guidance",
    category: "gotcha",
    files: ["src/startup.ts"],
  });
  expect(
    context(await invoke("PostToolUse", "Read", path.join(foreign, "src/startup.ts"))),
  ).not.toContain("Foreign rule");
  expect(context(await invoke("PostToolUse"))).toContain(body);
}, 20000);

it("keeps accepted guidance operative through a proposal, then delivers acceptance and retirement", async () => {
  expect(context(await invoke("PostToolUse"))).toContain(body);
  const replacement = "Retain the constructor only on the legacy startup path.";
  await upsertDecision(root, {
    id,
    title: "Reflective startup constructor",
    body: replacement,
    category: "gotcha",
    files: ["src/startup.ts"],
    owner: "Fixture team",
    sources: [{ kind: "document", reference: "README.md" }],
  });
  const proposed = context(await invoke("PostToolUse"));
  expect(proposed).toContain("[accepted]");
  expect(proposed).toContain(body);
  expect(proposed).toContain("[proposed]");
  expect(proposed).toContain(replacement);
  await verdict("accept");
  const accepted = context(await invoke("PostToolUse"));
  expect(accepted).toContain(replacement);
  expect(accepted).not.toContain(body);
  await verdict("retire");
  expect(context(await invoke("PostToolUse", "Read", "README.md"))).toContain("[retired]");
  expect(context(await invoke("PostToolUse"))).not.toContain(replacement);
}, 20000);

it("does not deliver from an unconfigured checkout and labels changed evidence", async () => {
  const inactive = path.join(temp, "inactive");
  await fs.mkdir(inactive);
  await initGitRepo(inactive);
  await fs.writeFile(path.join(inactive, "file.ts"), "export {};\n");
  await commitAll(inactive, "source");
  await upsertDecision(inactive, {
    title: "Inactive rule",
    body,
    category: "gotcha",
    files: ["file.ts"],
  });
  expect(
    await runAutomationHook(
      "claude",
      JSON.stringify({
        cwd: inactive,
        session_id: session,
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: path.join(inactive, "file.ts") },
      }),
      { managed: true },
    ),
  ).toBeNull();
  await fs.writeFile(path.join(root, "src/startup.ts"), "export const startup = false;\n");
  const changed = context(await invoke("PostToolUse"));
  expect(changed).toContain(body);
  expect(changed).toContain("changed files");
  expect(changed).toContain("verify against current code");
}, 20000);
