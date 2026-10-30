import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assembleContext } from "../src/context/assemble.js";
import { saveDecisionRecord } from "../src/decisions/decisions.js";
import type { DecisionRecord } from "../src/decisions/decisions.js";
import { commitAll, initGitRepo } from "./helpers.js";

const SHARED_VOCABULARY = [
  "settings",
  "screen",
  "network",
  "server",
  "request",
  "client",
  "cache",
  "error",
  "release",
  "build",
  "module",
  "config",
  "layout",
  "theme",
  "token",
  "session",
];

const UNRELATED_TOPICS = [
  "Payment sheet keeps its legacy layout",
  "Analytics events batch every thirty seconds",
  "Login tokens refresh before expiry",
  "Release builds strip debug logging",
  "Feature flags load before the first frame",
  "Push notification channels stay versioned",
  "Image cache evicts by byte size",
  "Database migrations never drop columns",
  "Deep links resolve through one router",
  "Crash reports omit user identifiers",
  "Locale fallback prefers the region language",
  "Accessibility labels come from string resources",
  "Background sync honours battery saver",
  "Video player releases its surface on pause",
  "Search results debounce keystrokes",
  "Map tiles prefetch one ring ahead",
  "Onboarding skips on returning installs",
  "Biometric prompt falls back to passcode",
  "Clipboard access requires user action",
  "Dark mode reads the system setting once",
  "Widget refresh caps at fifteen minutes",
  "Webview bridge allows a fixed method list",
  "Font scaling clamps headline sizes",
  "Rate limiter shares one bucket per host",
  "Gradle modules expose api sparingly",
];

function record(overrides: Partial<DecisionRecord>): DecisionRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: "decision",
    title: "Decision",
    body: "Body",
    category: "decision",
    files: [],
    createdAt: now,
    updatedAt: now,
    refreshedHash: "unknown",
    status: "active",
    ...overrides,
  };
}

/** Bodies that each repeat a few common project words, as real records do. */
function sharedBody(index: number): string {
  const words = SHARED_VOCABULARY.filter((_, n) => (n + index) % 3 === 0);
  return `This constraint came from an incident review. It mentions ${words.join(", ")} because the original change touched them.`;
}

describe("get_context decision relevance floor", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-relevance-"));
    await initGitRepo(root);
    await fs.mkdir(path.join(root, "src/upload"), { recursive: true });
    await fs.writeFile(path.join(root, "src/upload/queue.ts"), "export const queue = [];\n");
    await commitAll(root, "fixture");
    for (const [index, title] of UNRELATED_TOPICS.entries())
      await saveDecisionRecord(
        root,
        record({ id: `unrelated-${index}`, title, body: sharedBody(index) }),
      );
    await saveDecisionRecord(
      root,
      record({
        id: "long-network-notes",
        title: "Networking stack overview",
        body: Array.from(
          { length: 12 },
          () =>
            "Upload retries, server outage handling, network request timeouts, settings screen theme caches and client tokens all pass through this layer.",
        ).join(" "),
      }),
    );
    await saveDecisionRecord(
      root,
      record({
        id: "upload-backoff",
        title: "Upload retries must back off exponentially",
        body: "Immediate retries after an outage overloaded the server; keep the jittered backoff.",
        files: ["src/upload/queue.ts"],
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns no decisions for an unrelated task and says so", async () => {
    const bundle = await assembleContext(
      root,
      "rename the theme colour constants on the settings screen",
    );
    expect(bundle.decisions).toEqual({});
    expect(bundle.omittedBelowFloor).toBeGreaterThan(0);
    expect(bundle.hint).toContain("No saved decision matched");
  });

  it("keeps the top related record and drops a long body that merely shares words", async () => {
    const bundle = await assembleContext(
      root,
      "upload retries hammer the server after a network outage",
    );
    expect(Object.keys(bundle.decisions)[0]).toBe("upload-backoff");
    expect(Object.keys(bundle.decisions)).not.toContain("long-network-notes");
    expect(Object.keys(bundle.decisions).some((id) => id.startsWith("unrelated-"))).toBe(false);
  });

  it("does not let one long body win on word count alone", async () => {
    const bundle = await assembleContext(
      root,
      "network request timeouts on the settings screen with client tokens and theme caches",
    );
    expect(Object.keys(bundle.decisions)).not.toContain("long-network-notes");
  });

  it("keeps a decision anchored to a requested file without lexical overlap", async () => {
    const bundle = await assembleContext(root, "tidy imports", ["src/upload/queue.ts"]);
    expect(Object.keys(bundle.decisions)).toEqual(["upload-backoff"]);
  });
});
