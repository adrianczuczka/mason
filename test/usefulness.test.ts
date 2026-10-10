import { beforeEach, afterEach, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initGitRepo, commitAll, git } from "./helpers.js";
import { runAutomationCli } from "../src/automation/cli.js";
import { runAutomationHook } from "../src/automation/adapters.js";
import { automate } from "../src/automation/runtime.js";
import {
  configureUsefulness,
  observeUsefulness,
  rateUsefulness,
  retrievedDecisions,
  usefulnessStatus,
  summarizeUsefulness,
} from "../src/automation/usefulness.js";
let root: string;
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
};
const hook = (name: string, extra = {}) =>
  runAutomationHook(
    "claude",
    JSON.stringify({
      cwd: root,
      session_id: "private-session-id",
      hook_event_name: name,
      ...extra,
    }),
  );
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-usefulness-"));
  await initGitRepo(root);
  await write("old/index.js", "export const greeting = 'hello';\n");
  await write("README.md", "Use `old/index.js`.\n");
  await write(".gitignore", ".mason/reports/\n");
  await commitAll(root, "fixture");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("is disabled by default and does not create local tracking files", async () => {
  await hook("SessionStart");
  expect(await usefulnessStatus(root)).toMatchObject({ enabled: false, sessions: [] });
  await expect(fs.access(path.join(root, ".mason/local"))).rejects.toThrow();
}, 30000);

it("tracks real delivery, resolution, supplied ratings and retrieval without saving payloads", async () => {
  await configureUsefulness(root, true);
  await hook("SessionStart");
  const tool = { tool_name: "Bash", tool_use_id: "move" };
  await hook("PreToolUse", tool);
  await fs.rename(path.join(root, "old"), path.join(root, "new"));
  expect(JSON.stringify(await hook("PostToolUse", tool))).toContain("old/index.js");
  const first = (await usefulnessStatus(root)).sessions[0];
  const id = Object.keys(first.findings).find(
    (id) => first.findings[id].type === "deleted-reference",
  )!;
  expect(id).toBeTruthy();
  expect(first.findings[id].channels).toContain("agent");
  await rateUsefulness(root, first.id, id, "helpful");
  await hook("PreToolUse", { ...tool, tool_use_id: "docs" });
  await write("README.md", "Use `new/index.js`.\n");
  await hook("PostToolUse", { ...tool, tool_use_id: "docs" });
  await hook("PostToolUse", {
    tool_name: "mcp__mason__get_context",
    tool_use_id: "context",
    tool_response: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ decisions: { "private-lesson": { body: "SECRET CONTENT" } } }),
        },
      ],
    },
  });
  await hook("Stop");
  const summary = await usefulnessStatus(root),
    session = summary.sessions[0];
  expect(session.findings[id]).toMatchObject({ status: "resolved", rating: "helpful" });
  expect(session.retrievedDecisions).toBe(1);
  expect(session.checkMs).toBeGreaterThan(0);
  expect(session.ratings.helpful).toBe(1);
  expect(session.endedAt).toBeTruthy();
  const files = await fs.readdir(path.join(root, ".mason/local/usefulness"));
  const stored = (
    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => fs.readFile(path.join(root, ".mason/local/usefulness", f), "utf8")),
    )
  ).join("");
  for (const secret of ["SECRET CONTENT", "private-session-id", "private-lesson"])
    expect(stored).not.toContain(secret);
  expect(await git(["status", "--porcelain", "--untracked-files=all"], root)).not.toContain(
    ".mason/local",
  );
  await configureUsefulness(root, false);
  await hook("Stop");
  expect((await usefulnessStatus(root)).sessions[0].checks).toBe(session.checks);
}, 30000);

it("preserves audit feedback when optional tracking is corrupt", async () => {
  await configureUsefulness(root, true);
  await hook("SessionStart");
  const files = await fs.readdir(path.join(root, ".mason/local/usefulness"));
  const state = files.find((f) => f.endsWith(".json") && f !== "config.json")!;
  await write(".mason/local/usefulness/" + state, "broken-json");
  const output = await hook("Stop");
  expect(JSON.stringify(output)).toContain("usefulness tracking unavailable");
  await expect(usefulnessStatus(root)).rejects.toThrow();
  expect(await fs.readFile(path.join(root, ".mason/local/usefulness", state), "utf8")).toBe(
    "broken-json",
  );
}, 30000);

it("does not count overflow or absence as a resolved finding; older observations cannot regress status", async () => {
  await configureUsefulness(root, true);
  await fs.rm(path.join(root, "old"), { recursive: true });
  const { report } = await automate(root, { event: "task_end" });
  const finding = report.findings.find((f) => f.original.type === "deleted-reference")!;
  expect(finding).toBeTruthy();
  const event = { event: "after_tool" as const, host: "claude" as const, sessionId: "one" };
  const findings = Array.from({ length: 6 }, (_, n) => ({ ...finding, id: "finding-" + n }));
  await observeUsefulness(
    root,
    event,
    { ...report, findings },
    findings,
    [],
    12,
    "2026-09-30T10:00:00.000Z",
  );
  expect((await usefulnessStatus(root)).sessions[0].delivered).toBe(4);
  await observeUsefulness(
    root,
    event,
    { ...report, findings: [] },
    [],
    [],
    12,
    "2026-09-30T10:01:00.000Z",
  );
  expect((await usefulnessStatus(root)).sessions[0].resolved).toBe(0);
  expect((await usefulnessStatus(root)).sessions[0].findings["finding-0"].status).toBe("unknown");
  const resolved = findings.map((f) => ({ ...f, status: "resolved" as const }));
  await observeUsefulness(
    root,
    event,
    { ...report, findings: resolved },
    [],
    [],
    12,
    "2026-09-30T10:03:00.000Z",
  );
  await observeUsefulness(
    root,
    event,
    { ...report, findings },
    [],
    [],
    12,
    "2026-09-30T10:02:00.000Z",
  );
  expect((await usefulnessStatus(root)).sessions[0].resolved).toBe(4);
}, 30000);

it("merges concurrent sessions and isolates branches", async () => {
  await configureUsefulness(root, true);
  const { report } = await automate(root, { event: "task_end" });
  await Promise.all(
    ["one", "two"].map((sessionId) =>
      observeUsefulness(root, { event: "task_end", host: "claude", sessionId }, report, [], [], 10),
    ),
  );
  expect((await usefulnessStatus(root)).sessions).toHaveLength(2);
  await git(["checkout", "-b", "other"], root);
  expect((await usefulnessStatus(root)).sessions).toHaveLength(0);
}, 30000);

it("parses successful retrieval receipts without treating calls or errors as retrieval", () => {
  const name = "mcp__mason__get_context";
  expect(retrievedDecisions(name, undefined)).toBeUndefined();
  expect(retrievedDecisions(name, { isError: true, decisions: { x: {} } })).toBeUndefined();
  expect(retrievedDecisions("other_tool", { decisions: { x: {} } })).toBeUndefined();
  expect(retrievedDecisions(name, { decisions: {} })).toEqual([]);
  expect(retrievedDecisions(name, JSON.stringify({ decisions: { x: {} } }))).toEqual(["x"]);
});

it("validates CLI options and allows explicit local opt-in from a subdirectory", async () => {
  const output: string[] = [];
  const io = { out: (s: string) => output.push(s), err: (s: string) => output.push(s) };
  expect(
    await runAutomationCli(
      ["stats", "--dir", path.join(root, "old"), "--enable", "--json"],
      "",
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(output.pop()!).enabled).toBe(true);
  expect(await runAutomationCli(["stats", "--dir", root, "--enable", "--disable"], "", io)).toBe(2);
  expect(await runAutomationCli(["status", "--dir", root, "--rating", "helpful"], "", io)).toBe(2);
  expect(
    await runAutomationCli(
      [
        "stats",
        "--dir",
        root,
        "--session",
        "missing",
        "--finding",
        "missing",
        "--rating",
        "helpful",
      ],
      "",
      io,
    ),
  ).toBe(2);
});

it("aggregates per-session observations with retrieval coverage and filters sessions without mutation", async () => {
  await configureUsefulness(root, true);
  await fs.rm(path.join(root, "old"), { recursive: true });
  const { report } = await automate(root, { event: "task_end" });
  const finding = report.findings.find((f) => f.original.type === "deleted-reference")!;
  const first = {
    event: "after_tool" as const,
    host: "claude" as const,
    sessionId: "one",
    toolId: "context",
    retrievedDecisionIds: [],
  };
  const second = { event: "after_tool" as const, host: "claude" as const, sessionId: "two" };
  await observeUsefulness(root, first, { ...report, findings: [finding] }, [finding], [], 10);
  await observeUsefulness(root, second, { ...report, findings: [finding] }, [finding], [], 10);
  await observeUsefulness(
    root,
    second,
    { ...report, findings: [{ ...finding, status: "resolved" }] },
    [],
    [],
    10,
  );
  const all = await usefulnessStatus(root);
  expect(all.summary).toMatchObject({
    sessions: 2,
    delivered: 2,
    resolved: 1,
    open: 1,
    unknown: 0,
    retrievalObservedSessions: 1,
    retrievedDecisions: 0,
    checks: 3,
    checkMs: 30,
  });
  expect(summarizeUsefulness(all)).not.toContain(all.sessions[0].id);
  const selected = all.sessions.find((s) => s.resolved === 1)!;
  const output: string[] = [];
  const io = { out: (s: string) => output.push(s), err: (s: string) => output.push(s) };
  expect(
    await runAutomationCli(["stats", "--dir", root, "--session", selected.id, "--json"], "", io),
  ).toBe(0);
  const filtered = JSON.parse(output.pop()!);
  expect(filtered.summary).toMatchObject({
    sessions: 1,
    delivered: 1,
    resolved: 1,
    retrievedDecisions: null,
  });
  expect(filtered.sessions).toHaveLength(1);
  expect(summarizeUsefulness(filtered)).toContain(finding.id);
  expect(await usefulnessStatus(root)).toEqual(all);
  expect(await runAutomationCli(["stats", "--dir", root, "--session", "missing"], "", io)).toBe(2);
}, 30000);

it("disables tracking with corrupt configuration and observations while preserving observation files", async () => {
  await configureUsefulness(root, true);
  await hook("SessionStart");
  const dir = path.join(root, ".mason/local/usefulness");
  const data = (await fs.readdir(dir)).find((f) => f.endsWith(".json") && f !== "config.json")!;
  await fs.writeFile(path.join(dir, data), "corrupt-observations");
  await fs.writeFile(path.join(dir, "config.json"), "broken-json");
  const output: string[] = [];
  const io = { out: (s: string) => output.push(s), err: (s: string) => output.push(s) };
  expect(await runAutomationCli(["stats", "--dir", root, "--disable", "--json"], "", io)).toBe(0);
  expect(JSON.parse(output.pop()!).enabled).toBe(false);
  expect(JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")).enabled).toBe(false);
  expect(await fs.readFile(path.join(dir, data), "utf8")).toBe("corrupt-observations");
  await hook("Stop");
  expect(await fs.readFile(path.join(dir, data), "utf8")).toBe("corrupt-observations");
}, 30000);

it.each(["resolved", "missing", "corrupt"] as const)(
  "uses newer %s evidence for a delayed first delivery",
  async (evidence) => {
    await configureUsefulness(root, true);
    await fs.rm(path.join(root, "old"), { recursive: true });
    const { report } = await automate(root, { event: "task_end" });
    const finding = report.findings.find((f) => f.original.type === "deleted-reference")!;
    expect(finding).toBeTruthy();
    const latest = {
      ...report,
      reportPath: path.dirname(report.reportPath) + "/stats-latest.json",
      findings: [{ ...finding, status: "resolved" as const }],
    };
    if (evidence !== "missing")
      await write(
        latest.reportPath,
        evidence === "resolved" ? JSON.stringify(latest) : "broken-json",
      );
    const event = { event: "after_tool" as const, host: "claude" as const, sessionId: "delayed" };
    await observeUsefulness(root, event, latest, [], [], 1, "2026-09-30T10:01:00.000Z");
    await observeUsefulness(root, event, report, [finding], [], 1, "2026-09-30T10:00:00.000Z");
    const result = (await usefulnessStatus(root)).sessions[0];
    expect(result.delivered).toBe(1);
    expect(result.findings[finding.id]).toMatchObject({
      status: evidence === "resolved" ? "resolved" : "unknown",
      deliveredAt: "2026-09-30T10:00:00.000Z",
      observedAt: "2026-09-30T10:01:00.000Z",
    });
    expect(result.reportPath).toBe(latest.reportPath);
  },
  30000,
);
