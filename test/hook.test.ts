import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runHook } from "../src/hook/hook.js";
import { runHookCli } from "../src/hook/cli.js";
import { commitAll, initGitRepo } from "./helpers.js";

let tmpDir: string;
let stateDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-hook-test-"));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-hook-state-"));
  await initGitRepo(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(stateDir, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function writeDecision(
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await write(
    `.mason/decisions/${id}.json`,
    JSON.stringify({
      version: 1,
      id,
      title: `Title of ${id}`,
      body: `Body of ${id}.`,
      category: "gotcha",
      files: ["src/auth.ts"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      refreshedHash: "unknown",
      status: "active",
      ...overrides,
    })
  );
}

function stdinFor(
  relPath: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    session_id: "session-1",
    cwd: tmpDir,
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(tmpDir, relPath) },
    ...extra,
  });
}

function contextOf(output: string | null): string {
  expect(output).not.toBeNull();
  const parsed = JSON.parse(output!);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return parsed.hookSpecificOutput.additionalContext;
}

describe("runHook", () => {
  it("stays silent when no decision store exists", async () => {
    await write("src/auth.ts", "export const a = 1;\n");
    await commitAll(tmpDir, "init");
    expect(await runHook(stdinFor("src/auth.ts"), { stateDir })).toBeNull();
  });

  it("injects a decision anchored to the touched file", async () => {
    await write("src/auth.ts", "export const a = 1;\n");
    await writeDecision("auth-is-weird");
    const head = await commitAll(tmpDir, "init");
    await writeDecision("auth-is-weird", { refreshedHash: head });

    const context = contextOf(
      await runHook(stdinFor("src/auth.ts"), { stateDir })
    );
    expect(context).toContain("Title of auth-is-weird");
    expect(context).toContain("src/auth.ts");
    expect(context).not.toContain("older commit");
  });

  it("marks decisions whose anchors drifted", async () => {
    await write("src/auth.ts", "export const a = 1;\n");
    const firstHash = await commitAll(tmpDir, "init");
    await writeDecision("auth-is-weird", { refreshedHash: firstHash });
    await write("src/auth.ts", "export const a = 2;\n");
    await commitAll(tmpDir, "feat: change auth");

    const context = contextOf(
      await runHook(stdinFor("src/auth.ts"), { stateDir })
    );
    expect(context).toContain("changed files");
    expect(context).toContain("verify against current code");
  });

  it("matches directory-prefix anchors", async () => {
    await write("src/payments/stripe.ts", "export const s = 1;\n");
    await writeDecision("payments-gotcha", { files: ["src/payments"] });
    await commitAll(tmpDir, "init");

    const context = contextOf(
      await runHook(stdinFor("src/payments/stripe.ts"), { stateDir })
    );
    expect(context).toContain("payments-gotcha");
  });

  it("does not inject the same decision twice in one session", async () => {
    await write("src/auth.ts", "export const a = 1;\n");
    await writeDecision("auth-is-weird");
    await commitAll(tmpDir, "init");

    expect(await runHook(stdinFor("src/auth.ts"), { stateDir })).not.toBeNull();
    expect(await runHook(stdinFor("src/auth.ts"), { stateDir })).toBeNull();
  });

  it("injects again for a different session", async () => {
    await write("src/auth.ts", "export const a = 1;\n");
    await writeDecision("auth-is-weird");
    await commitAll(tmpDir, "init");

    expect(await runHook(stdinFor("src/auth.ts"), { stateDir })).not.toBeNull();
    expect(
      await runHook(stdinFor("src/auth.ts", { session_id: "session-2" }), {
        stateDir,
      })
    ).not.toBeNull();
  });

  it("ignores superseded decisions and unrelated files", async () => {
    await write("src/auth.ts", "export const a = 1;\n");
    await write("src/other.ts", "export const o = 1;\n");
    await writeDecision("old-way", { status: "superseded" });
    await commitAll(tmpDir, "init");

    expect(await runHook(stdinFor("src/auth.ts"), { stateDir })).toBeNull();
    expect(await runHook(stdinFor("src/other.ts"), { stateDir })).toBeNull();
  });

  it("caps injection and prefers exact anchors over prefix matches", async () => {
    await write("src/auth.ts", "export const a = 1;\n");
    await writeDecision("dir-one", { files: ["src"], updatedAt: "2026-04-01T00:00:00.000Z" });
    await writeDecision("dir-two", { files: ["src"], updatedAt: "2026-03-01T00:00:00.000Z" });
    await writeDecision("dir-three", { files: ["src"], updatedAt: "2026-02-01T00:00:00.000Z" });
    await writeDecision("exact-hit", { files: ["src/auth.ts"], updatedAt: "2026-01-01T00:00:00.000Z" });
    await commitAll(tmpDir, "init");

    const context = contextOf(
      await runHook(stdinFor("src/auth.ts"), { stateDir })
    );
    expect(context).toContain("exact-hit");
    expect(context).toContain("dir-one");
    expect(context).toContain("dir-two");
    expect(context).not.toContain("dir-three");
  });

  it("stays silent on malformed stdin and unsupported tools", async () => {
    expect(await runHook("not json", { stateDir })).toBeNull();
    expect(await runHook("{}", { stateDir })).toBeNull();
    await write("src/auth.ts", "export const a = 1;\n");
    await writeDecision("auth-is-weird");
    await commitAll(tmpDir, "init");
    expect(
      await runHook(stdinFor("src/auth.ts", { tool_name: "Bash" }), {
        stateDir,
      })
    ).toBeNull();
  });
});

describe("runHookCli", () => {
  it("prints the settings config block", async () => {
    const out: string[] = [];
    const code = await runHookCli(["--print-config"], "", {
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("Read|Edit|Write");
  });

  it("always exits 0, silently, on hook input", async () => {
    const out: string[] = [];
    const code = await runHookCli([], "garbage", {
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });
});
