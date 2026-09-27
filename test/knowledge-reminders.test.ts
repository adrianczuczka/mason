import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { pendingKnowledge } from "../src/decisions/pending.js";
import { upsertDecision } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { workspace } from "../src/automation/evidence.js";
import { automate } from "../src/automation/runtime.js";
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

it("shows pending records across sessions while keeping worktrees separate", async () => {
  await upsertDecision(root, lesson);
  const event = { event: "session_start" as const, host: "claude" as const };
  for (const sessionId of ["one", "two"]) expect((await automate(root, { ...event, sessionId })).message).toContain("proposal(s) awaiting review");
  expect((await automate(root, { ...event, event: "turn_start", sessionId: "two" })).message).toBeNull();
  const linked = root + "-linked";
  try {
    await git(["worktree", "add", "-b", "linked", linked], root);
    expect(await pendingKnowledge(linked)).toBeNull();
    expect((await automate(linked, { ...event, sessionId: "two" })).report.capture).toBe("observed");
  } finally { await git(["worktree", "remove", "--force", linked], root); }
}, 20000);

it("prints only changed findings and preserves overflow across persisted session state", async () => {
  await fs.mkdir(path.join(root, "src"));
  const names = Array.from({ length: 7 }, (_, i) => `src/file${i}.ts`);
  await fs.writeFile(path.join(root, "README.md"), names.map(name => `Use \`${name}\`.`).join("\n"));
  for (const name of names) await fs.writeFile(path.join(root, name), "present");
  await commitAll(root, "document files");
  const session = { host: "claude" as const, sessionId: "one" };
  await automate(root, { ...session, event: "session_start" });
  for (const name of names) await fs.unlink(path.join(root, name));
  await commitAll(root, "remove files");
  const first = await automate(root, { ...session, event: "turn_start" });
  expect(first.report.findings).toHaveLength(7);
  expect(first.message).toContain("3 more findings");
  const second = await automate(root, { ...session, event: "turn_start" });
  const displayed = (text: string | null) => names.filter(name => text?.includes(name));
  expect(displayed(first.message)).toHaveLength(4);
  expect(displayed(second.message)).toHaveLength(3);
  expect(new Set([...displayed(first.message), ...displayed(second.message)]).size).toBe(7);
  expect((await automate(root, { ...session, event: "turn_start" })).message).toBeNull();
  const explicit = await automate(root, { event: "turn_start" });
  expect(explicit.report.findings).toHaveLength(7);
  await fs.writeFile(path.join(root, names[0]), "restored");
  expect((await automate(root, { ...session, event: "turn_start" })).message).toContain("[resolved]");
  await fs.unlink(path.join(root, names[0]));
  expect((await automate(root, { ...session, event: "turn_start" })).message).toContain(names[0]);
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

it("loads existing session state without notification detail fields", async () => {
  const event = { event: "session_start" as const, host: "claude" as const, sessionId: "old" };
  await automate(root, event);
  const ws = await workspace(root);
  const statePath = path.join(root, ws.directory, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  for (const session of Object.values(state.sessions) as any[]) {
    delete session.notifiedFindings;
    delete session.notifiedDiagnostics;
  }
  await fs.writeFile(statePath, JSON.stringify(state));
  expect((await automate(root, { ...event, event: "turn_start" })).message).toBeNull();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "README.md"), "See `src/missing.ts`.\n");
  const changed = await automate(root, { ...event, event: "turn_start" });
  expect(changed.message).toContain("missing.ts");
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
