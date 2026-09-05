import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initGitRepo, commitAll } from "./helpers.js";
import { getContext, getImpact, getSnapshot, masonInit, masonCompleteInit, saveDecision, saveSnapshotData, checkDrift, verifySnapshot, saveVerification } from "../src/mcp/tools.js";

describe("Mason without a concept map", () => {
  let repo: string;
  const knowledge = { title: "Delivery retry safety", body: "Unkeyed deliveries duplicated orders during the last incident. Retry only with an idempotency key.", category: "gotcha" as const, files: ["src/delivery.ts"] };

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "mason-adoption-"));
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "src"));
    await fs.mkdir(path.join(repo, "test"));
    await fs.writeFile(path.join(repo, "src/delivery.ts"), "export const deliver = () => true;\n");
    await fs.writeFile(path.join(repo, "src/worker.ts"), "import { deliver } from './delivery';\nexport const run = deliver;\n");
    await fs.writeFile(path.join(repo, "test/delivery.test.ts"), "// tests delivery\n");
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    await commitAll(repo, "initial source");
  });
  afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("records a lesson and returns it on the next task without initialization", async () => {
    const saved = JSON.parse(await saveDecision(repo, knowledge));
    expect(saved.status).toBe("created");
    const context = JSON.parse(await getContext(repo, "Make delivery retry safe"));
    expect(context.exists).toBe(false);
    expect(context.map.status).toBe("missing");
    expect(context.decisions[saved.id].body).toBe(knowledge.body);
    expect(context.decisions[saved.id].trust.freshness).toBe("current");
    expect(context.decisions[saved.id].trust.verification).toBe("unverified");
    expect(context.impact.targets).toContain("src/delivery.ts");
    expect(context.relatedTests).toContain("test/delivery.test.ts");
    expect(context.freshness.stale).toBeNull();
    expect(context.features).toEqual({});
    await expect(fs.access(path.join(repo, ".mason/project.json"))).rejects.toThrow();
    await expect(fs.access(path.join(repo, ".mason/snapshot.json"))).rejects.toThrow();
  });

  it("returns file impact and tests with no stores and does not create any", async () => {
    const context = JSON.parse(await getContext(repo, "Investigate this file", ["src/delivery.ts", "src/delivery.ts", "../outside.ts"]));
    expect(context.map.status).toBe("missing");
    expect(context.impact.targets).toEqual(["src/delivery.ts"]);
    expect(context.impact.references.map(r => r.file)).toContain("src/worker.ts");
    expect(context.relatedTests).toContain("test/delivery.test.ts");
    const impact = JSON.parse(await getImpact(repo, ["src/delivery.ts"]));
    expect(impact.targetFiles).toEqual(["src/delivery.ts"]);
    await expect(fs.access(path.join(repo, ".mason"))).rejects.toThrow();
  });

  it("expands a matched directory decision into source files for impact", async () => {
    await saveDecision(repo, { ...knowledge, files: ["src/"] });
    const context = JSON.parse(await getContext(repo, "Delivery retry safety"));
    expect(context.impact.targets).toContain("src/delivery.ts");
    expect(context.impact.targets).not.toContain("src");
    expect(context.relatedTests).toContain("test/delivery.test.ts");
  });

  it("reports an empty context honestly without starting a setup flow", async () => {
    const context = JSON.parse(await getContext(repo, "unrelated task"));
    expect(context.exists).toBe(false);
    expect(context.map.status).toBe("missing");
    expect(context.decisions).toEqual({});
    expect(context.impact).toBeNull();
    expect(context.freshness.stale).toBeNull();
    expect(context.hint).not.toMatch(/build one first|must.*init|up.to.date/i);
    await expect(fs.access(path.join(repo, ".mason"))).rejects.toThrow();
  });

  it("detects edited decision anchors on the next task without a map", async () => {
    const saved = JSON.parse(await saveDecision(repo, knowledge));
    await fs.writeFile(path.join(repo, "src/delivery.ts"), "export const deliver = () => false;\n");
    const context = JSON.parse(await getContext(repo, "Delivery retry safety"));
    expect(context.decisions[saved.id].trust.freshness).toBe("changed");
    expect(context.decisions[saved.id].stale).toBe(true);
    expect(context.freshness.stale).toBeNull();
  });

  it("retains decision impact when a valid map has no matching entries", async () => {
    await saveSnapshotData(repo, { "unrelated catalog": { description: "Unrelated", files: ["test/delivery.test.ts"] } }, {});
    const saved = JSON.parse(await saveDecision(repo, knowledge));
    const context = JSON.parse(await getContext(repo, "idempotency"));
    expect(context.features).toEqual({});
    expect(context.availableFeatures["unrelated catalog"]).toBeDefined();
    expect(context.decisions[saved.id]).toBeDefined();
    expect(context.impact.targets).toEqual(["src/delivery.ts"]);
    expect(context.relatedTests).toContain("test/delivery.test.ts");
  });

  it("keeps invalid-map diagnostics alongside usable decisions", async () => {
    const saved = JSON.parse(await saveDecision(repo, knowledge));
    await fs.writeFile(path.join(repo, ".mason/snapshot.json"), "{broken");
    const context = JSON.parse(await getContext(repo, "Delivery retry safety"));
    expect(context.map.status).toBe("invalid");
    expect(context.decisions[saved.id]).toBeDefined();
    expect(context.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ path: ".mason/snapshot.json" })]));
    expect(context.hint).toMatch(/repair/i);
    expect(await fs.readFile(path.join(repo, ".mason/snapshot.json"), "utf8")).toBe("{broken");
  });

  it("preserves malformed-record warnings and unknown decision history", async () => {
    const saved = JSON.parse(await saveDecision(repo, knowledge));
    const file = path.join(repo, ".mason/decisions", `${saved.id}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.refreshedHash = "0".repeat(40);
    record.history[0].refreshedHash = record.refreshedHash;
    await fs.writeFile(file, JSON.stringify(record));
    await fs.writeFile(path.join(repo, ".mason/decisions/broken.json"), "null");
    const context = JSON.parse(await getContext(repo, "Delivery retry safety"));
    expect(context.decisions[saved.id].trust.freshness).toBe("unknown");
    expect(context.diagnostics.some(d => d.path.endsWith("broken.json"))).toBe(true);
    expect(context.hint).toMatch(/unknown/i);
  });

  it("uses an existing map without requiring an initialization marker", async () => {
    await saveSnapshotData(repo, { delivery: { description: "Send deliveries", files: ["src/delivery.ts"] } }, {});
    const context = JSON.parse(await getContext(repo, "delivery"));
    expect(context.map.status).toBe("available");
    expect(context.features.delivery).toBeDefined();
    const snapshot = JSON.parse(await getSnapshot(repo));
    expect(snapshot.exists).toBe(true);
    expect(snapshot.features.delivery).toBeDefined();
    expect(JSON.parse(await checkDrift(repo)).exists).toBe(true);
    expect(JSON.parse(await verifySnapshot(repo)).entries.map(e => e.name)).toContain("delivery");
    expect(JSON.parse(await saveVerification(repo, { delivery: { ok: true } })).stamped).toContain("delivery");
    await expect(fs.access(path.join(repo, ".mason/project.json"))).rejects.toThrow();
  });

  it("does not couple decision tools to a malformed legacy marker", async () => {
    await fs.mkdir(path.join(repo, ".mason"));
    await fs.writeFile(path.join(repo, ".mason/project.json"), "null");
    const saved = JSON.parse(await saveDecision(repo, knowledge));
    expect(saved.status).toBe("created");
    const context = JSON.parse(await getContext(repo, "Delivery retry safety"));
    expect(context.decisions[saved.id]).toBeDefined();
  });

  it("starts with actionable audit findings and leaves the project untouched", async () => {
    await fs.writeFile(path.join(repo, "AGENTS.md"), "Run `npm run lint` before submitting changes.\n");
    await commitAll(repo, "document unavailable command");
    const started = JSON.parse(await masonInit(repo));
    expect(started.mode).toBe("quickstart");
    expect(started.map.status).toBe("missing");
    expect(started.audit.status).toBe("complete");
    expect(started.audit.issues.some(issue => issue.type === "dead-command")).toBe(true);
    expect(started.playbook).toMatch(/save_decision/);
    expect(started.playbook).not.toMatch(/PHASE 1 — Map/);
    await expect(fs.access(path.join(repo, ".mason"))).rejects.toThrow();
  });

  it("returns touched decisions in an initial committed-diff review", async () => {
    const saved = JSON.parse(await saveDecision(repo, knowledge));
    const base = await commitAll(repo, "record incident");
    await fs.writeFile(path.join(repo, "src/delivery.ts"), "export const deliver = () => false;\n");
    await commitAll(repo, "change delivery");
    const started = JSON.parse(await masonInit(repo, { base }));
    expect(started.review.status).toBe("complete");
    expect(started.review.scope).toBe("committed");
    expect(started.review.touchedDecisions.some(d => d.id === saved.id)).toBe(true);
  });

  it("distinguishes unavailable checks from clean results", async () => {
    const started = JSON.parse(await masonInit(repo, { base: "missing-ref" }));
    expect(started.audit.status).toBe("no-context-files");
    expect(started.review.status).toBe("unavailable");
    expect(started.review.reason).toBeTruthy();
  });

  it("does not present uncommitted edits as reviewed changes", async () => {
    await fs.writeFile(path.join(repo, "src/delivery.ts"), "export const deliver = () => false;\n");
    const started = JSON.parse(await masonInit(repo, { base: "HEAD" }));
    expect(started.review.status).toBe("no-changes");
    expect(started.review.scope).toBe("committed");
    expect(started.review.changedFiles).toEqual([]);
    expect(started.review.workingTree.changedFiles).toContain("src/delivery.ts");
  });

  it("does not report a successful audit when Git history is unavailable", async () => {
    const plain = path.join(repo, "plain-project");
    await fs.mkdir(plain);
    // A separate unborn repository prevents Git from discovering the parent.
    await initGitRepo(plain);
    await fs.writeFile(path.join(plain, "AGENTS.md"), "Run `npm run lint`.\n");
    const started = JSON.parse(await masonInit(plain));
    expect(started.audit.status).toBe("unavailable");
    expect(started.audit.clean).toBeUndefined();
    expect(started.review.status).toBe("unavailable");
  });

  it("still offers the full map build when explicitly requested", async () => {
    const started = JSON.parse(await masonInit(repo, { mode: "map" }));
    expect(started.mode).toBe("map");
    expect(started.playbook).toMatch(/generate_snapshot_batch/);
    expect(started.playbook).toMatch(/reduce_snapshot/);
    expect(started.playbook).not.toMatch(/Want to set.*Confluence/i);
  });

  it("preserves prior settings and initialization time on repeated setup", async () => {
    const first = JSON.parse(await masonCompleteInit(repo, { confluenceConfigured: true }));
    const second = JSON.parse(await masonCompleteInit(repo));
    expect(second.marker.initializedAt).toBe(first.marker.initializedAt);
    expect(second.marker.features.confluence).toBe(true);
  });
});
