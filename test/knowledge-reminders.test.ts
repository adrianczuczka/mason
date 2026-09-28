import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { pendingKnowledge } from "../src/decisions/pending.js";
import { upsertDecision } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { workspace } from "../src/automation/evidence.js";
import { automate, automationStatus } from "../src/automation/runtime.js";
import { git, commitAll, initGitRepo } from "./helpers.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-knowledge-")));
  await initGitRepo(root);
  await fs.writeFile(path.join(root, "README.md"), "# Project\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".mason/reports/\n");
  await commitAll(root, "initial");
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));
const lesson = { title: "Preserve mutation provenance", body: "A render flag cannot establish whether a mutation occurred.", category: "gotcha" as const };

it("reports untracked, staged, modified and deleted records without implying approval", async () => {
  expect(await pendingKnowledge(root)).toBeNull();
  const saved = await upsertDecision(root, lesson);
  if (saved.status !== "created") throw new Error(JSON.stringify(saved));
  const file = `.mason/decisions/${saved.id}.json`;
  expect(await pendingKnowledge(root)).toContain("1 uncommitted decision record(s)");
  await git(["add", file], root);
  expect(await pendingKnowledge(root)).toContain(file);
  await commitAll(root, "save proposal");
  const committed = await pendingKnowledge(root);
  expect(committed).not.toContain("uncommitted");
  expect(committed).toContain("1 proposal(s) awaiting review");
  expect(committed).toContain("No approval is implied");
  await upsertDecision(root, { ...lesson, id: saved.id, body: lesson.body + " Track mutation causes explicitly." });
  expect(await pendingKnowledge(root)).toContain("1 uncommitted decision record(s)");
  await fs.unlink(path.join(root, file));
  expect(await pendingKnowledge(root)).toContain(file);
  expect(await pendingKnowledge(root)).not.toContain("proposal(s)");
});

it("retains proposal age across revisions and reports unreadable records", async () => {
  const saved = await upsertDecision(root, lesson);
  if (saved.status !== "created") throw new Error(JSON.stringify(saved));
  const file = path.join(root, `.mason/decisions/${saved.id}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  const old = new Date(Date.now() - 7 * 86400000).toISOString();
  record.createdAt = old; record.history[0].at = old;
  await fs.writeFile(file, JSON.stringify(record));
  await upsertDecision(root, { ...lesson, id: saved.id, body: lesson.body + " Preserve the cause." });
  expect(await pendingKnowledge(root)).toContain("(7 days)");
  await fs.writeFile(path.join(root, ".mason/decisions/broken.json"), "bad json");
  expect(await pendingKnowledge(root)).toContain("summary is incomplete");
});

it("keeps pending records in explicit status and out of session hooks, with worktree isolation", async () => {
  await upsertDecision(root, lesson);
  const event = { event: "session_start" as const, host: "claude" as const };
  expect((await automate(root, { ...event, sessionId: "one" })).message).toBeNull();
  expect((await automate(root, { ...event, sessionId: "two" })).message).toBeNull();
  expect((await automationStatus(root)).knowledge).toContain("proposal(s) awaiting review");
  expect((await automate(root, { ...event, event: "turn_start", sessionId: "two" })).message).toBeNull();
  const linked = root + "-linked";
  try {
    await git(["worktree", "add", "-b", "linked", linked], root);
    expect(await pendingKnowledge(linked)).toBeNull();
    expect((await automate(linked, { ...event, sessionId: "two" })).report.capture).toBe("observed");
  } finally { await git(["worktree", "remove", "--force", linked], root); }
}, 20000);

it("keeps backlog quiet, reports new findings at completion, and preserves evidence across restarts", async () => {
  await fs.writeFile(path.join(root, "README.md"), "Use `src/one.ts` and `src/two.ts`.\n");
  await fs.mkdir(path.join(root, "src"));
  for (const file of ["src/one.ts", "src/two.ts"]) await fs.writeFile(path.join(root, file), "present");
  await commitAll(root, "document files");
  await fs.unlink(path.join(root, "src/one.ts"));
  await commitAll(root, "remove first");
  const session = { host: "claude" as const, sessionId: "one" };
  const start = await automate(root, { ...session, event: "session_start" });
  expect(start.message).toBeNull();
  expect((await automate(root, { ...session, event: "turn_start" })).message).toBeNull();
  await fs.unlink(path.join(root, "src/two.ts"));
  await commitAll(root, "remove second");
  const changed = await automate(root, { ...session, event: "turn_start" });
  expect(changed.message).toContain("src/two.ts");
  const restarted = { ...session, sessionId: "restart" };
  expect((await automate(root, { ...restarted, event: "session_start" })).message).toBeNull();
  // An explicit audit must not swallow the queued completion notice.
  expect((await automate(root, { event: "task_end" })).message).toContain("src/two.ts");
  const completion = await automate(root, { ...restarted, event: "task_end" });
  expect(completion.message).toContain("src/two.ts");
  expect(completion.message).not.toContain("src/one.ts");
  expect(changed.report.findings).toHaveLength(2);
  const explicit = await automate(root, { event: "turn_start" });
  expect(explicit.message).toContain("src/one.ts");
  expect(explicit.message).toContain("src/two.ts");
  await fs.writeFile(path.join(root, "src/one.ts"), "restored");
  expect((await automate(root, { ...session, event: "task_end" })).message).toBeNull();
  await fs.unlink(path.join(root, "src/one.ts"));
  expect((await automate(root, { ...session, event: "task_end" })).message).toContain("src/one.ts");
  const fresh = await automate(root, { ...session, sessionId: "new", event: "session_start" });
  expect(fresh.message).toBeNull();
  expect((await automate(root, { ...session, sessionId: "new", event: "task_end" })).message).toBeNull();
  expect(fresh.report.counts.unresolved).toBe(2);
}, 20000);


it("includes replacement proposals while excluding accepted records from the review backlog", async () => {
  const saved = await upsertDecision(root, { ...lesson, owner: "Test team", sources: [{ kind: "document", reference: "README.md" }] });
  if (saved.status !== "created") throw new Error(JSON.stringify(saved));
  await commitAll(root, "proposal");
  const prepared = await reviewDecision(root, { id: saved.id });
  if (!("reviewToken" in prepared)) throw new Error(JSON.stringify(prepared));
  const reviewed = await reviewDecision(root, { id: saved.id, action: "accept", reviewToken: prepared.reviewToken,
    reviewer: "Test reviewer", note: "Checked the fixture evidence." });
  expect(reviewed.status).not.toBe("error");
  expect(await pendingKnowledge(root)).not.toContain("proposal(s)");
  await upsertDecision(root, { ...lesson, id: saved.id, body: lesson.body + " Retain provenance through retries." });
  expect(await pendingKnowledge(root)).toContain("1 proposal(s) awaiting review");
});

it("migrates a legacy notification baseline from the last report before inspecting new changes", async () => {
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/main.ts"), "present");
  await fs.writeFile(path.join(root, "README.md"), "See `src/main.ts`.\n");
  await commitAll(root, "document entry");
  const session = { host: "claude" as const, sessionId: "old" };
  const before = await automate(root, { ...session, event: "session_start" });
  const ws = await workspace(root);
  const statePath = path.join(root, ws.directory, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  delete state.notifications;
  await fs.writeFile(statePath, JSON.stringify(state));
  await fs.unlink(path.join(root, "src/main.ts"));
  await commitAll(root, "remove entry");
  const restarted = { ...session, sessionId: "new" };
  expect((await automate(root, { ...restarted, event: "session_start" })).message).toBeNull();
  expect((await automate(root, { ...restarted, event: "task_end" })).message).toContain("src/main.ts");
  expect((await automationStatus(root)).notificationBaselineHead).toBe(before.report.head);
}, 20000);

it("keeps Slack-like calls quiet when they make no repository changes", async () => {
  const { runAutomationHook } = await import("../src/automation/adapters.js");
  const invoke = (hook_event_name: string, extra = {}) => runAutomationHook("claude", JSON.stringify({
    cwd: root, session_id: "slack", hook_event_name, ...extra,
  }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/missing.ts"), "present");
  await fs.writeFile(path.join(root, "README.md"), "See `src/missing.ts`.\n");
  await commitAll(root, "document original file");
  await fs.unlink(path.join(root, "src/missing.ts"));
  await commitAll(root, "existing finding");
  expect(await invoke("SessionStart")).toBeNull();
  const tool = { tool_name: "mcp__slack__read_thread", tool_use_id: "slack-read" };
  expect(await invoke("PreToolUse", tool)).toBeNull();
  expect(await invoke("PostToolUse", tool)).toBeNull();
  expect(await invoke("Stop")).toBeNull();
  expect((await automate(root, { event: "task_end" })).message).toContain("missing.ts");
});

it("loads existing session state without notification detail fields", async () => {
  const event = { event: "session_start" as const, host: "claude" as const, sessionId: "old" };
  await automate(root, event);
  const ws = await workspace(root);
  const statePath = path.join(root, ws.directory, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  for (const session of Object.values(state.sessions) as any[]) {
    session.seen = "legacy-signature";
    session.continued = true;
    session.initialIssues = [];
    session.initialDocs = {};
    delete session.notifiedDiagnostics;
  }
  await fs.writeFile(statePath, JSON.stringify(state));
  expect((await automate(root, { ...event, event: "turn_start" })).message).toBeNull();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "README.md"), "See `src/missing.ts`.\n");
  const changed = await automate(root, { ...event, event: "turn_start" });
  expect(changed.message).toContain("missing.ts");
  expect((await automate(root, { ...event, event: "task_end" })).message).toContain("missing.ts");
});

it("shows the oldest proposals before the display limit regardless of filename", async () => {
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const saved = await upsertDecision(root, { ...lesson, title: `Lesson ${i}`, force: true });
    if (saved.status !== "created") throw new Error(JSON.stringify(saved));
    const file = path.join(root, `.mason/decisions/${saved.id}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.createdAt = record.updatedAt = record.history[0].at = new Date(now - (i + 1) * 86400000).toISOString();
    await fs.writeFile(file, JSON.stringify(record));
  }
  await commitAll(root, "record proposals");
  const summary = (await pendingKnowledge(root, now))!;
  expect(summary).toContain("oldest first");
  expect(summary.indexOf("lesson-5.json")).toBeLessThan(summary.indexOf("lesson-1.json"));
  expect(summary).not.toContain("lesson-0.json");
  expect(summary).toContain("1 more");
});

it("deduplicates coverage diagnostics independently across alternating sessions", async () => {
  const a = { host: "claude" as const, sessionId: "a" };
  const b = { host: "codex" as const, sessionId: "b" };
  await automate(root, { ...a, event: "session_start" });
  const gap = await automate(root, { ...a, event: "after_tool", mutating: true, toolId: "missed" });
  expect(gap.message).toContain("verification limited");
  for (let i = 0; i < 2; i++) {
    await automate(root, { ...b, event: "turn_start" });
    const repeated = await automate(root, { ...a, event: "turn_start" });
    expect(repeated.message).toBeNull();
    expect(repeated.report.diagnostics.join(" ")).toContain("pre-tool capture");
    expect(repeated.report.status).toBe("incomplete");
  }
}, 20000);

it.each(["old-schema", "broken-json", "missing"])("recovers a %s notification report without losing repair evidence", async kind => {
  const event = { host: "claude" as const, sessionId: "upgrade", event: "session_start" as const };
  const first = await automate(root, event);
  const ws = await workspace(root);
  const statePath = path.join(root, ws.directory, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  delete state.notifications;
  delete state.agentNotifications;
  // Keep analysis and original baselines intact: only the notification source is bad.
  const oldPath = path.join(root, state.latest);
  const baselines = await Promise.all(first.report.baselinePaths.map(p => fs.readFile(path.join(root, p), "utf8")));
  if (kind === "missing") await fs.unlink(oldPath);
  else await fs.writeFile(oldPath, kind === "broken-json" ? "{" : JSON.stringify({ findings: [] }));
  await fs.writeFile(statePath, JSON.stringify(state));
  const recovered = await automate(root, event);
  expect(recovered.message).toContain("notification baseline could not be read");
  expect((await automate(root, { ...event, event: "task_end" })).message).toBeNull();
  expect((await automationStatus(root)).notificationBaselineHead).toBe(recovered.report.head);
  expect(await Promise.all(first.report.baselinePaths.map(p => fs.readFile(path.join(root, p), "utf8")))).toEqual(baselines);
  if (kind !== "missing") expect(await fs.readFile(oldPath, "utf8")).toBe(kind === "broken-json" ? "{" : JSON.stringify({ findings: [] }));
}, 20000);

it.each(["claude", "codex"] as const)("gives %s agent feedback once without consuming completion delivery", async host => {
  const { runAutomationHook } = await import("../src/automation/adapters.js");
  const invoke = (hook_event_name: string, extra = {}) => runAutomationHook(host, JSON.stringify({
    cwd: root, session_id: "feedback", hook_event_name, ...extra,
  }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/main.ts"), "present");
  await fs.writeFile(path.join(root, "README.md"), "See `src/main.ts`.\n");
  await commitAll(root, "document file");
  await invoke("SessionStart");
  const tool = { tool_name: "Bash", tool_use_id: "delete" };
  await invoke("PreToolUse", tool);
  await fs.unlink(path.join(root, "src/main.ts"));
  const feedback = await invoke("PostToolUse", tool);
  expect(feedback).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: expect.stringContaining("src/main.ts") } });
  expect(await invoke("UserPromptSubmit")).toBeNull();
  expect(await invoke("Stop")).toMatchObject({ systemMessage: expect.stringContaining("src/main.ts") });
  expect(await invoke("Stop")).toBeNull();
  // Fix within the task, then verify recurrence reaches the agent again.
  await fs.writeFile(path.join(root, "src/main.ts"), "restored");
  expect(await invoke("UserPromptSubmit")).toBeNull();
  await fs.unlink(path.join(root, "src/main.ts"));
  expect(await invoke("UserPromptSubmit")).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining("src/main.ts") } });
}, 20000);
