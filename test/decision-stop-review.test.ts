import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initGitRepo, commitAll } from "./helpers.js";
import { upsertDecision, loadDecisions } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { runAutomationHook } from "../src/automation/adapters.js";
import { automate, automationStatus } from "../src/automation/runtime.js";
import { runAutomationCli } from "../src/automation/cli.js";

let root: string;
let id: string;
const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text);
const hook = (name: string, extra = {}, host: "claude" | "codex" = "claude", session = "session") =>
  runAutomationHook(
    host,
    JSON.stringify({ cwd: root, session_id: session, hook_event_name: name, ...extra }),
  );
const tool = { tool_name: "Edit", tool_use_id: "edit" };
async function edit(text: string, file = "src/client.ts") {
  await hook("PreToolUse", tool);
  await write(file, text);
  await hook("PostToolUse", tool);
}
async function inspect() {
  const prepared = await reviewDecision(root, { id });
  expect(
    (
      await reviewDecision(root, {
        id,
        action: "inspect",
        inspector: "Fixture agent",
        note: "Read the retry implementation; its limit remains bounded.",
        reviewToken: prepared.reviewToken,
      })
    ).status,
  ).toBe("inspected");
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-stop-"));
  await initGitRepo(root);
  await fs.mkdir(path.join(root, "src"));
  await write("README.md", "# Client\n");
  await write(".gitignore", ".mason/reports/\n");
  await write("src/client.ts", "export const retries = 1;\n");
  await commitAll(root, "initial");
  await upsertDecision(root, {
    title: "Bound retries",
    body: "Retries must remain bounded.",
    category: "decision",
    files: ["src"],
  });
  id = (await loadDecisions(root))[0].id;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Claude decision Stop review", { timeout: 30000 }, () => {
  it("blocks once, preserves the advisory, and reopens on another edit to the same dirty file", async () => {
    await hook("SessionStart");
    await edit("export const retries = 2;\n");
    const first = await hook("Stop");
    expect(first).toMatchObject({ decision: "block", reason: expect.stringContaining(id) });
    expect(first?.reason).toContain('review_decision(action: "prepare"');
    expect(first?.reason).toContain('action: "inspect"');
    expect(first?.reason).toContain("authorized human review");
    expect(await hook("Stop")).toMatchObject({ systemMessage: expect.stringContaining(id) });
    await edit("export const retries = 3;\n");
    expect(await hook("Stop")).toMatchObject({ decision: "block" });
    expect(
      (await automate(root, { event: "task_end" })).report.counts["review-required"],
    ).toBeGreaterThan(0);
  });

  it("honors stop_hook_active even on the first Stop and keeps subsequent delivery advisory", async () => {
    await edit("export const retries = 2;\n");
    expect(await hook("Stop", { stop_hook_active: true })).toMatchObject({
      systemMessage: expect.stringContaining(id),
    });
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("keeps external committed drift advisory, even when a session observes a no-op tool", async () => {
    await hook("SessionStart");
    await write("src/client.ts", "export const retries = 2;\n");
    await commitAll(root, "external change");
    await hook("PreToolUse", tool);
    await hook("PostToolUse", tool);
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("does not attribute commit-only content changes during a shell tool to local edits", async () => {
    const shell = { tool_name: "Bash", tool_use_id: "pull" };
    await hook("PreToolUse", shell);
    await write("src/client.ts", "export const retries = 2;\n");
    await commitAll(root, "simulate incoming committed content");
    await hook("PostToolUse", shell);
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("does not infer session edits from an unmatched post-tool event", async () => {
    await write("src/client.ts", "export const retries = 2;\n");
    await hook("PostToolUse", tool);
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("clears reviewed evidence without claiming human approval and blocks subsequent content", async () => {
    await edit("export const retries = 2;\n");
    expect(await hook("Stop")).toHaveProperty("decision", "block");
    await inspect();
    expect((await hook("Stop"))?.decision).toBeUndefined();
    expect((await loadDecisions(root))[0].approval).toBe("proposed");
    await edit("export const retries = 3;\n");
    expect(await hook("Stop")).toHaveProperty("decision", "block");
  });

  it("clears a resolved finding on an explicit check so recurrence can block again", async () => {
    await edit("export const retries = 2;\n");
    expect(await hook("Stop")).toHaveProperty("decision", "block");
    await edit("export const retries = 1;\n");
    await automate(root, { event: "task_end" });
    await edit("export const retries = 2;\n");
    expect(await hook("Stop")).toHaveProperty("decision", "block");
  });

  it("observes directory additions and deletions and retains evidence across commits", async () => {
    await edit("export const extra = true;\n", "src/extra.ts");
    await commitAll(root, "session commit");
    expect(await hook("Stop")).toHaveProperty("decision", "block");
    await inspect();
    await hook("PreToolUse", tool);
    await fs.unlink(path.join(root, "src/extra.ts"));
    await hook("PostToolUse", tool);
    expect(await hook("Stop")).toHaveProperty("decision", "block");
  });

  it("does not consume another session's block or treat its unobserved edits as ours", async () => {
    await hook("SessionStart", {}, "claude", "other");
    await edit("export const retries = 2;\n");
    expect((await hook("Stop", {}, "claude", "other"))?.decision).toBeUndefined();
    expect(await hook("Stop")).toHaveProperty("decision", "block");
  });

  it("does not reblock for external edits to other anchors after delivering a reminder", async () => {
    await edit("export const retries = 2;\n");
    expect(await hook("Stop")).toHaveProperty("decision", "block");
    await write("src/other.ts", "export const external = true;\n");
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("preserves other completion findings when the Stop block is emitted", async () => {
    await hook("PreToolUse", tool);
    await write("src/client.ts", "export const retries = 2;\n");
    await write("README.md", "See `src/missing.ts`.\n");
    await hook("PostToolUse", tool);
    const output = await hook("Stop");
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain(id);
    expect(output?.reason).toContain("src/missing.ts");
  });

  it("names every affected decision in one block", async () => {
    await upsertDecision(root, {
      title: "Keep client exports stable",
      body: "The client exports retries.",
      category: "decision",
      files: ["src/client.ts"],
    });
    const ids = (await loadDecisions(root)).map((record) => record.id);
    await edit("export const retries = 2;\n");
    const output = await hook("Stop");
    expect(output?.decision).toBe("block");
    for (const decisionId of ids) expect(output?.reason).toContain(decisionId);
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("requires inspection of accepted guidance even after a revised proposal captures the edits", async () => {
    await upsertDecision(root, {
      id,
      title: "Bound retries",
      body: "Retries must remain bounded.",
      category: "decision",
      files: ["src"],
      owner: "Client team",
      sources: [{ kind: "document", reference: "README.md" }],
    });
    await commitAll(root, "decision proposal");
    const prepared = await reviewDecision(root, { id });
    expect(
      (
        await reviewDecision(root, {
          id,
          action: "accept",
          reviewer: "Fixture reviewer",
          note: "Reviewed the retry limit.",
          reviewToken: prepared.reviewToken,
        })
      ).status,
    ).toBe("accepted");
    await edit("export const retries = Infinity;\n");
    await upsertDecision(root, {
      id,
      title: "Bound retries",
      body: "The retry limit is currently missing; restore it before relying on this constraint.",
      category: "decision",
      files: ["src"],
    });
    expect((await hook("Stop"))?.decision).toBe("block");
    expect((await loadDecisions(root))[0].approval).toBe("proposed");
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("keeps incomplete anchor scopes advisory", async () => {
    await hook("PreToolUse", tool);
    await write("src/client.ts", "export const retries = 2;\n");
    await fs.symlink("client.ts", path.join(root, "src/link.ts"));
    await hook("PostToolUse", tool);
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("does not reblock on unrelated commits or external overwrites of observed content", async () => {
    await edit("export const retries = 2;\n");
    expect((await hook("Stop"))?.decision).toBe("block");
    await commitAll(root, "commit observed content");
    expect((await hook("Stop"))?.decision).toBeUndefined();
    await write("src/client.ts", "export const retries = 4;\n");
    expect((await hook("Stop"))?.decision).toBeUndefined();
  });

  it("keeps Codex advisory and supports the CLI opt-out, status, and help", async () => {
    await hook("PreToolUse", tool, "codex");
    await write("src/client.ts", "export const retries = 2;\n");
    await hook("PostToolUse", tool, "codex");
    expect((await hook("Stop", {}, "codex"))?.decision).toBeUndefined();
    await edit("export const retries = 3;\n");
    const output: string[] = [];
    const io = { out: (s: string) => output.push(s), err: (s: string) => output.push(s) };
    expect(await runAutomationCli(["config", "--dir", root, "--stop-block", "off"], "", io)).toBe(
      0,
    );
    expect((await automationStatus(root)).stopBlock).toBe("off");
    expect((await hook("Stop"))?.decision).toBeUndefined();
    expect(await runAutomationCli(["config", "--dir", root, "--stop-block", "drift"], "", io)).toBe(
      0,
    );
    expect(await hook("Stop")).toHaveProperty("decision", "block");
    await runAutomationCli(["hook", "--help"], "", io);
    expect(output.at(-1)).toContain("Claude Stop can block once");
  });
});
