import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadDecisions,
  saveDecisionRecord,
  decisionIdFor,
  upsertDecision,
  MAX_ACTIVE_DECISIONS,
} from "../src/decisions/decisions.js";
import type { DecisionRecord } from "../src/decisions/decisions.js";
import { computeDecisionDrift } from "../src/decisions/drift.js";
import { assembleContext } from "../src/context/assemble.js";
import type { ContextBundle, NoMatchBundle } from "../src/context/assemble.js";
import { getSnapshot } from "../src/mcp/tools.js";
import { runDriftCli } from "../src/drift/cli.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runHook } from "../src/hook/hook.js";

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(["add", "."], dir);
  await git(["commit", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

function record(overrides: Partial<DecisionRecord>): DecisionRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: "some-decision",
    title: "Some decision",
    body: "Some body",
    category: "decision",
    files: [],
    createdAt: now,
    updatedAt: now,
    refreshedHash: "unknown",
    status: "active",
    ...overrides,
  };
}

describe("decisions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-decisions-test-"));
    await git(["init"], tmpDir);
    await git(["config", "user.email", "test@test.com"], tmpDir);
    await git(["config", "user.name", "Test"], tmpDir);
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export const auth = 1;\n");
    await fs.writeFile(path.join(tmpDir, "src", "api.ts"), "export const api = 1;\n");
    await commitAll(tmpDir, "initial");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("loadDecisions / saveDecisionRecord", () => {
    it("returns [] when no decisions directory exists", async () => {
      expect(await loadDecisions(tmpDir)).toEqual([]);
    });

    it("skips malformed and unknown-version records without failing the load", async () => {
      await saveDecisionRecord(tmpDir, record({ id: "good" }));
      const dir = path.join(tmpDir, ".mason", "decisions");
      await fs.writeFile(path.join(dir, "broken.json"), "{not json");
      await fs.writeFile(
        path.join(dir, "future.json"),
        JSON.stringify({ version: 99, id: "future", title: "t", body: "b" })
      );

      const loaded = await loadDecisions(tmpDir);
      expect(loaded.map((r) => r.id)).toEqual(["good"]);
    });
  });

  describe("decisionIdFor", () => {
    it("slugs the title", () => {
      expect(
        decisionIdFor("Auth token refresh must NOT auto-retry!", "body", new Set())
      ).toBe("auth-token-refresh-must-not-auto-retry");
    });

    it("appends a content suffix on collision", () => {
      const id = decisionIdFor("Auth rule", "different body", new Set(["auth-rule"]));
      expect(id).toMatch(/^auth-rule-[0-9a-f]{6}$/);
    });

    it("ends a shortened slug at a complete word and retains collision handling", () => {
      const title = "Binding requirement is cacheable only; the device limit is account scoped";
      const expected = "binding-requirement-is-cacheable-only-the-device-limit-is";
      expect(decisionIdFor(title, "body", new Set())).toBe(expected);
      expect(decisionIdFor(title, "other body", new Set([expected]))).toMatch(new RegExp(`^${expected}-[0-9a-f]{6}$`));
    });

    it.each([59, 60])("retains a complete %i-character word at the cutoff", length => {
      expect(decisionIdFor(`${"a".repeat(length)} suffix`, "body", new Set())).toBe("a".repeat(length));
    });

    it("bounds a single long word and handles titles with no slug characters", () => {
      expect(decisionIdFor("a".repeat(80), "body", new Set())).toBe("a".repeat(60));
      expect(decisionIdFor("約束", "body", new Set())).toBe("decision");
      expect(decisionIdFor("約束", "body", new Set(["decision"]))).toMatch(/^decision-[0-9a-f]{6}$/);
    });
  });

  describe("upsertDecision", () => {
    it("creates a record pinned to HEAD with sanitized anchors", async () => {
      const head = await git(["rev-parse", "HEAD"], tmpDir);
      const result = await upsertDecision(tmpDir, {
        title: "Auth retries stay at the caller",
        body: "Refresh storms locked accounts when 401s were retried automatically.",
        category: "gotcha",
        files: ["src/auth.ts", "../outside.ts", "/etc/passwd"],
      });

      expect(result.status).toBe("created");
      if (result.status !== "created") throw new Error("unreachable");
      const [saved] = await loadDecisions(tmpDir);
      expect(saved.id).toBe("auth-retries-stay-at-the-caller");
      expect(saved.refreshedHash).toBe(head);
      expect(saved.files).toEqual(["src/auth.ts"]);
      expect(result.warnings.join(" ")).toMatch(/outside the repo/);
    });

    it("warns on nonexistent anchor files but still saves", async () => {
      const result = await upsertDecision(tmpDir, {
        title: "Old module is deprecated",
        body: "The legacy sync module was removed; never reintroduce it.",
        category: "deprecation",
        files: ["src/legacy-sync.ts"],
      });
      expect(result.status).toBe("created");
      if (result.status !== "created") throw new Error("unreachable");
      expect(result.warnings.join(" ")).toMatch(/does not exist on disk/);
      const [saved] = await loadDecisions(tmpDir);
      expect(saved.files).toEqual(["src/legacy-sync.ts"]);
    });

    it("rejects near-duplicates with the existing record, saves with force", async () => {
      await upsertDecision(tmpDir, {
        title: "Auth token refresh must not auto-retry",
        body: "Retrying 401s with a refreshed token caused refresh storms that locked accounts.",
        category: "gotcha",
        files: ["src/auth.ts"],
      });

      const dup = await upsertDecision(tmpDir, {
        title: "Auth token refresh should not retry",
        body: "Retrying 401s with refreshed tokens causes refresh storms locking accounts.",
        category: "gotcha",
        files: ["src/auth.ts"],
      });
      expect(dup.status).toBe("duplicate_suspected");
      if (dup.status !== "duplicate_suspected") throw new Error("unreachable");
      expect(dup.existing.id).toBe("auth-token-refresh-must-not-auto-retry");
      expect(dup.hint).toMatch(/force:true/);

      const forced = await upsertDecision(tmpDir, {
        title: "Auth token refresh should not retry",
        body: "Retrying 401s with refreshed tokens causes refresh storms locking accounts.",
        category: "gotcha",
        files: ["src/auth.ts"],
        force: true,
      });
      expect(forced.status).toBe("created");
      expect((await loadDecisions(tmpDir)).length).toBe(2);
    });

    it("revises by id preserving createdAt and the last review baseline", async () => {
      await upsertDecision(tmpDir, {
        title: "API client owns serialization",
        body: "Serialization lives in the client, not call sites.",
        category: "convention",
      });
      const [before] = await loadDecisions(tmpDir);

      await fs.writeFile(path.join(tmpDir, "src", "api.ts"), "export const api = 2;\n");
      const newHead = await commitAll(tmpDir, "change api");

      const result = await upsertDecision(tmpDir, {
        id: before.id,
        title: "API client owns serialization",
        body: "Serialization lives in the ApiClient, never at call sites — enforced in review.",
        category: "convention",
      });
      expect(result.status).toBe("updated");
      const [after] = await loadDecisions(tmpDir);
      expect(after.createdAt).toBe(before.createdAt);
      expect(after.refreshedHash).toBe(before.refreshedHash);
      expect(after.body).toMatch(/enforced in review/);
    });

    it("leaves review evidence unchanged on same id and content", async () => {
      await upsertDecision(tmpDir, {
        title: "API client owns serialization",
        body: "Serialization lives in the client, not call sites.",
        category: "convention",
      });
      const [before] = await loadDecisions(tmpDir);
      await fs.writeFile(path.join(tmpDir, "src", "api.ts"), "export const api = 3;\n");
      const newHead = await commitAll(tmpDir, "change api again");

      const result = await upsertDecision(tmpDir, {
        id: before.id,
        title: before.title,
        body: before.body,
        category: before.category,
      });
      expect(result.status).toBe("unchanged");
      const [after] = await loadDecisions(tmpDir);
      expect(after.refreshedHash).toBe(before.refreshedHash);
    });

    it("supersedes: old record kept, marked superseded, linked to the new one", async () => {
      await upsertDecision(tmpDir, {
        title: "Cache TTL is five minutes",
        body: "Weather data caches for five minutes to balance freshness and rate limits.",
        category: "decision",
      });

      const result = await upsertDecision(tmpDir, {
        title: "Cache TTL is one minute",
        body: "Rate limits were raised; one-minute TTL now wins on freshness.",
        category: "decision",
        supersedes: "cache-ttl-is-five-minutes",
        force: true,
      });
      expect(result.status).toBe("superseded_and_created");

      const all = await loadDecisions(tmpDir);
      const old = all.find((r) => r.id === "cache-ttl-is-five-minutes")!;
      expect(old.status).toBe("superseded");
      expect(old.supersededBy).toBe("cache-ttl-is-one-minute");
    });

    it.each([
      { field: "title", length: 81, max: 80 },
      { field: "body", length: 2501, max: 2500 },
    ])("rejects an oversized $field with its actual count and no writes", async ({ field, length, max }) => {
      const result = await upsertDecision(tmpDir, {
        title: "Too long",
        body: "A useful constraint.",
        category: "decision",
        [field]: `  ${"x".repeat(length)}  `,
      });
      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("unreachable");
      expect(result.error).toContain(`${field} has ${length} characters; maximum is ${max} (1 over)`);
      await expect(fs.access(path.join(tmpDir, ".mason"))).rejects.toThrow();
    });

    it("warns on long creates, revisions and unchanged saves without losing content or history", async () => {
      const input = { title: "Auth retry exceptions", body: "x".repeat(2000), category: "gotcha" as const };
      const created = await upsertDecision(tmpDir, input);
      expect(created).toMatchObject({ status: "created", warnings: [expect.stringContaining("2000")] });
      if (created.status !== "created") throw new Error("unreachable");
      const updatedInput = { ...input, id: created.id, body: "y".repeat(2500) };
      const updated = await upsertDecision(tmpDir, updatedInput);
      expect(updated).toMatchObject({ status: "updated", warnings: [expect.stringContaining("2500")] });
      const file = path.join(tmpDir, ".mason/decisions", `${created.id}.json`);
      const before = await fs.readFile(file, "utf8");
      expect(await upsertDecision(tmpDir, updatedInput)).toMatchObject({ status: "unchanged", warnings: [expect.stringContaining("2500")] });
      expect(await fs.readFile(file, "utf8")).toBe(before);
      const saved = JSON.parse(before);
      expect(saved.body).toBe(updatedInput.body);
      expect(saved.history.map((event: { content: { body: string } }) => event.content.body)).toEqual([input.body, updatedInput.body]);
      expect(await upsertDecision(tmpDir, { ...updatedInput, body: "z".repeat(1500) })).toMatchObject({ status: "updated", warnings: [] });
    });

    it("keeps a previously truncated id when reading and revising its title", async () => {
      const id = "binding-requirement-is-cacheable-only-the-device-limit-is-ac";
      await saveDecisionRecord(tmpDir, record({ id, title: "Binding requirement is cacheable only; the device limit is account scoped" }));
      const file = path.join(tmpDir, ".mason/decisions", `${id}.json`);
      const before = await fs.readFile(file, "utf8");
      expect((await loadDecisions(tmpDir))[0].id).toBe(id);
      expect(await fs.readFile(file, "utf8")).toBe(before);
      expect(await upsertDecision(tmpDir, { id, title: "Binding cache scope", body: "Retain account scope.", category: "decision" })).toMatchObject({ status: "updated", id });
      expect((await loadDecisions(tmpDir)).map(r => r.id)).toEqual([id]);
    });

    it("warns with pruneCandidates over the soft cap, never auto-evicts", async () => {
      for (let i = 0; i < MAX_ACTIVE_DECISIONS; i++) {
        await saveDecisionRecord(
          tmpDir,
          record({ id: `d-${i}`, title: `Decision ${i}`, body: `Body ${i}` })
        );
      }
      await saveDecisionRecord(
        tmpDir,
        record({ id: "old-superseded", status: "superseded" })
      );

      const result = await upsertDecision(tmpDir, {
        title: "One more entirely unrelated topic",
        body: "Completely novel content about deployment windows on Fridays.",
        category: "decision",
      });
      expect(result.status).toBe("created");
      if (result.status !== "created") throw new Error("unreachable");
      expect(result.warnings.join(" ")).toMatch(/soft cap/);
      expect(result.pruneCandidates).toContain("old-superseded");
      expect((await loadDecisions(tmpDir)).length).toBe(MAX_ACTIVE_DECISIONS + 2);
    });
  });

  it("exposes matching MCP limits and preserves the full body through retrieval and hooks", async () => {
    vi.stubGlobal("PKG_VERSION", "test");
    const server = createMcpServer();
    const client = new Client({ name: "decision-limits-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as { text: string }[])[0].text;
    try {
      await server.connect(a); await client.connect(b);
      const tool = (await client.listTools()).tools.find(t => t.name === "save_decision")!;
      const manifest = JSON.parse(await fs.readFile(new URL("../manifest.json", import.meta.url), "utf8"));
      const declared = manifest.tools.find((t: { name: string }) => t.name === "save_decision").inputSchema.properties;
      for (const [field, max] of [["title", 80], ["body", 2500]] as const) {
        expect(tool.inputSchema.properties![field]).toMatchObject({ type: "string", minLength: 1, maxLength: max });
        expect(declared[field]).toMatchObject(tool.inputSchema.properties![field]);
      }
      const input = { dir: tmpDir, title: "Auth retry rationale", body: "Valid body", category: "gotcha", files: ["src/auth.ts"], force: true };
      for (const [field, length] of [["title", 81], ["body", 2501]] as const) {
        const rejected = await client.callTool({ name: "save_decision", arguments: { ...input, [field]: `  ${"x".repeat(length)}  ` } });
        expect(rejected.isError).toBe(true);
        expect(text(rejected)).toContain(`${field} has ${length} characters`);
        expect(text(rejected)).toContain("(1 over)");
      }
      await expect(fs.access(path.join(tmpDir, ".mason"))).rejects.toThrow();
      for (const length of [1500, 1501, 2500]) {
        const exception = " Never retry without the key.";
        const body = "x".repeat(length - exception.length) + exception;
        const result = await client.callTool({ name: "save_decision", arguments: { ...input, title: `Auth ${length}`.padEnd(80, "!"), body: `  ${body}  ` } });
        expect(result.isError).not.toBe(true);
        const saved = JSON.parse(text(result));
        expect(saved.status).toBe("created");
        expect(saved.warnings).toHaveLength(length > 1500 ? 1 : 0);
        if (length > 1500) expect(saved.warnings[0]).toContain("include it in full");
        const context = JSON.parse(text(await client.callTool({ name: "get_context", arguments: { dir: tmpDir, task: "Auth retries", files: ["src/auth.ts"] } })));
        expect(context.decisions[saved.id].body).toBe(body);
        expect(context.decisions[saved.id].approval).toBe("proposed");
        const hook = await runHook(JSON.stringify({ session_id: `length-${length}`, cwd: tmpDir, tool_name: "Read", tool_input: { file_path: path.join(tmpDir, "src/auth.ts") } }), { stateDir: tmpDir });
        expect(JSON.parse(hook!).hookSpecificOutput.additionalContext).toContain(body);
      }
    } finally { await client.close(); await server.close(); }
  }, 15000);

  describe("computeDecisionDrift", () => {
    it("flags decisions whose anchor files changed, not untouched ones", async () => {
      const head = await git(["rev-parse", "HEAD"], tmpDir);
      await saveDecisionRecord(
        tmpDir,
        record({ id: "auth-note", files: ["src/auth.ts"], refreshedHash: head })
      );
      await saveDecisionRecord(
        tmpDir,
        record({ id: "api-note", files: ["src/api.ts"], refreshedHash: head })
      );

      await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export const auth = 2;\n");
      await commitAll(tmpDir, "change auth");

      const report = await computeDecisionDrift(tmpDir);
      expect(report.staleDecisions).toEqual({ "auth-note": ["src/auth.ts"] });
      expect(report.totalDecisions).toBe(2);
    });

    it("flags renames of anchor files", async () => {
      const head = await git(["rev-parse", "HEAD"], tmpDir);
      await saveDecisionRecord(
        tmpDir,
        record({ id: "auth-note", files: ["src/auth.ts"], refreshedHash: head })
      );
      await git(["mv", "src/auth.ts", "src/authn.ts"], tmpDir);
      await commitAll(tmpDir, "rename auth");

      const report = await computeDecisionDrift(tmpDir);
      expect(report.staleDecisions["auth-note"]).toEqual(["src/auth.ts"]);
    });

    it("anchorless decisions never go stale", async () => {
      await saveDecisionRecord(
        tmpDir,
        record({ id: "prose-only", files: [], refreshedHash: "0".repeat(40) })
      );
      await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export const auth = 9;\n");
      await commitAll(tmpDir, "change");

      const report = await computeDecisionDrift(tmpDir);
      expect(report.staleDecisions).toEqual({});
      expect(report.historyAvailable).toBe(true);
    });

    it("unreachable refreshedHash surfaces historyAvailable: false", async () => {
      await saveDecisionRecord(
        tmpDir,
        record({
          id: "orphaned",
          files: ["src/auth.ts"],
          refreshedHash: "deadbeef".repeat(5),
        })
      );
      const report = await computeDecisionDrift(tmpDir);
      expect(report.historyAvailable).toBe(false);
      expect(report.staleDecisions).toEqual({});
    });
  });

  describe("integration", () => {
    async function seedSnapshot(): Promise<string> {
      const head = await git(["rev-parse", "HEAD"], tmpDir);
      await fs.mkdir(path.join(tmpDir, ".mason"), { recursive: true });
      const now = new Date().toISOString();
      await fs.writeFile(
        path.join(tmpDir, ".mason", "snapshot.json"),
        JSON.stringify({
          version: 2,
          createdAt: now,
          updatedAt: now,
          gitHash: head,
          features: {
            "user authentication": {
              description: "Login handling",
              files: ["src/auth.ts"],
            },
          },
          flows: {},
        })
      );
      return head;
    }

    it("assembleContext surfaces matching decisions with full bodies and excludes superseded", async () => {
      const head = await seedSnapshot();
      await saveDecisionRecord(
        tmpDir,
        record({
          id: "auth-retry-gotcha",
          title: "Authentication retries are forbidden",
          body: "Retrying 401s caused refresh storms — surface the error instead.",
          category: "gotcha",
          files: ["src/auth.ts"],
          refreshedHash: head,
        })
      );
      await saveDecisionRecord(
        tmpDir,
        record({
          id: "old-auth-rule",
          title: "Authentication retry allowed once",
          body: "Superseded rule.",
          status: "superseded",
          refreshedHash: head,
        })
      );

      const bundle = (await assembleContext(
        tmpDir,
        "fix the authentication bug"
      )) as ContextBundle;

      expect(Object.keys(bundle.decisions)).toEqual(["auth-retry-gotcha"]);
      expect(bundle.decisions["auth-retry-gotcha"].body).toMatch(/refresh storms/);
      expect(bundle.decisions["auth-retry-gotcha"].stale).toBe(false);
    });

    it("feature-overlap boost surfaces zero-lexical-score decisions; stale flag set", async () => {
      const head = await seedSnapshot();
      await saveDecisionRecord(
        tmpDir,
        record({
          id: "session-quirk",
          title: "Session cookies are httpOnly for a reason",
          body: "XSS incident in 2024 — never expose the session cookie to JS.",
          category: "gotcha",
          files: ["src/auth.ts"],
          refreshedHash: head,
        })
      );
      await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export const auth = 5;\n");
      await commitAll(tmpDir, "change auth");

      // Task shares no tokens with the decision, but the decision anchors to
      // the matched feature's file.
      const bundle = (await assembleContext(
        tmpDir,
        "fix the authentication bug"
      )) as ContextBundle;

      expect(Object.keys(bundle.decisions)).toContain("session-quirk");
      expect(bundle.decisions["session-quirk"].stale).toBe(true);
      expect(bundle.decisions["session-quirk"].trust.freshness).toBe("changed");
    });

    it("decisions appear in NoMatchBundle when no feature matches", async () => {
      const head = await seedSnapshot();
      await saveDecisionRecord(
        tmpDir,
        record({
          id: "deploy-window",
          title: "No deployments on Fridays",
          body: "Pager history says weekend incidents cluster after Friday deploys.",
          category: "convention",
          refreshedHash: head,
        })
      );

      const bundle = (await assembleContext(
        tmpDir,
        "when can I run the deployment"
      )) as NoMatchBundle;

      expect(bundle.features).toEqual({});
      expect(Object.keys(bundle.decisions)).toContain("deploy-window");
    });

    it("get_snapshot lists compact decisions without bodies; absent when none", async () => {
      const head = await seedSnapshot();
      await fs.writeFile(
        path.join(tmpDir, ".mason", "project.json"),
        JSON.stringify({ version: 1, initializedAt: new Date().toISOString() })
      );

      const before = JSON.parse(await getSnapshot(tmpDir));
      expect(before.decisions).toBeUndefined();

      await saveDecisionRecord(
        tmpDir,
        record({
          id: "auth-retry-gotcha",
          title: "Authentication retries are forbidden",
          body: "Long body that must not appear in the orientation call.",
          category: "gotcha",
          files: ["src/auth.ts"],
          refreshedHash: head,
        })
      );

      const after = JSON.parse(await getSnapshot(tmpDir));
      expect(after.decisions["auth-retry-gotcha"].title).toBe(
        "Authentication retries are forbidden"
      );
      expect(after.decisions["auth-retry-gotcha"].body).toBeUndefined();
    });

    it("drift CLI: stale decisions never change the exit code, appear additively", async () => {
      const head = await seedSnapshot();
      await saveDecisionRecord(
        tmpDir,
        record({ id: "auth-note", files: ["src/auth.ts"], refreshedHash: head })
      );
      await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export const auth = 7;\n");
      await commitAll(tmpDir, "change auth");
      // Re-pin the MAP to HEAD so only the decision is stale
      const newHead = await git(["rev-parse", "HEAD"], tmpDir);
      const snapshotPath = path.join(tmpDir, ".mason", "snapshot.json");
      const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));
      snapshot.gitHash = newHead;
      snapshot.features["user authentication"].refreshedHash = newHead;
      snapshot.features.api = { description: "API", files: ["src/api.ts"], refreshedHash: newHead };
      await fs.writeFile(snapshotPath, JSON.stringify(snapshot));

      const out: string[] = [];
      const code = await runDriftCli(["--dir", tmpDir], {
        out: (l) => out.push(l),
        err: (l) => out.push(l),
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(/Decisions needing verification \(1\/1\): auth-note/);

      const jsonOut: string[] = [];
      await runDriftCli(["--dir", tmpDir, "--json"], {
        out: (l) => jsonOut.push(l),
        err: (l) => jsonOut.push(l),
      });
      const parsed = JSON.parse(jsonOut.join("\n"));
      expect(parsed.stale).toBe(false);
      expect(parsed.decisions.staleDecisions).toEqual({
        "auth-note": ["src/auth.ts"],
      });
    });
  });
});
