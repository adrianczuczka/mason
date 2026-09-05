import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initGitRepo, commitAll, git } from "./helpers.js";
import { prepareSnapshotBatch } from "../src/snapshot/snapshot.js";
import { readFullFile } from "../src/mcp/sampler.js";
import { getContext, getSnapshot, saveSnapshotData, saveVerification } from "../src/mcp/tools.js";
import { computeDrift } from "../src/drift/drift.js";
import { computeDecisionDrift } from "../src/decisions/drift.js";
import { upsertDecision, loadDecisionStore } from "../src/decisions/decisions.js";
import { computeReview } from "../src/review/review.js";
import { writeStoreJson, readStoreJson } from "../src/utils/storage.js";
import { MAX_SOURCE_BYTES } from "../src/utils/files.js";
import { runHook } from "../src/hook/hook.js";
import { runDriftCli } from "../src/drift/cli.js";
import { savePartial } from "../src/snapshot/partials.js";

describe("reliability across tools", () => {
  let tmp: string;
  let repo: string;
  const features = { auth: { description: "Authentication", files: ["src/auth.ts"] } };
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mason-reliability-"));
    repo = path.join(tmp, "repo");
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await initGitRepo(repo);
    await fs.writeFile(path.join(repo, "src/auth.ts"), "export const auth = true;\n");
    await commitAll(repo, "initial");
    await saveSnapshotData(repo, structuredClone(features), {});
    await fs.writeFile(path.join(repo, ".mason/project.json"), JSON.stringify({ version: 1, initializedAt: new Date().toISOString() }));
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it("keeps ignored files and escaping symlinks out of batches and direct reads", async () => {
    await fs.mkdir(path.join(tmp, "repo-extra"));
    await fs.writeFile(path.join(tmp, "repo-extra/private.ts"), "synthetic outside marker");
    await fs.writeFile(path.join(repo, ".gitignore"), "local/\n");
    await fs.mkdir(path.join(repo, "local"));
    await fs.writeFile(path.join(repo, "local/private.ts"), "synthetic ignored marker");
    await fs.symlink(path.join(tmp, "repo-extra/private.ts"), path.join(repo, "src/link.ts"));
    const batch = await prepareSnapshotBatch(repo, 0);
    expect(batch.skeletons.map(f => f.path)).toEqual(["src/auth.ts"]);
    expect(await readFullFile(repo, "../repo-extra/private.ts")).toBeNull();
    expect(await readFullFile(repo, "local/private.ts")).toBeNull();
    expect(await readFullFile(repo, "src/link.ts")).toBeNull();
  });

  it("carries failed verification through both primary reading tools", async () => {
    await saveVerification(repo, { auth: { ok: false, note: "Wrong implementation" } });
    const context = JSON.parse(await getContext(repo, "auth"));
    const snapshot = JSON.parse(await getSnapshot(repo));
    expect(context.features.auth.trust.verification).toBe("failed");
    expect(snapshot.trust.features.auth.verification).toBe("failed");
    expect(context.hint).toMatch(/failed/i);
    expect(snapshot.hint).toMatch(/failed/i);
  });

  it("does not claim certainty when history is unavailable", async () => {
    const file = path.join(repo, ".mason/snapshot.json");
    const snapshot = JSON.parse(await fs.readFile(file, "utf8"));
    snapshot.gitHash = "0".repeat(40);
    await fs.writeFile(file, JSON.stringify(snapshot));
    const result = JSON.parse(await getContext(repo, "auth"));
    expect(result.features.auth.trust.freshness).toBe("unknown");
    expect(result.hint).not.toMatch(/entries are current|map is current/i);
  });

  it("reports unknown freshness for an entry without anchors", async () => {
    await saveSnapshotData(repo, { policy: { description: "Access policy", files: [] } }, {});
    const result = JSON.parse(await getContext(repo, "policy"));
    expect(result.features.policy.trust.freshness).toBe("unknown");
  });

  it("returns structured omissions even when the snapshot is pinned to HEAD", async () => {
    await fs.writeFile(path.join(repo, "src/unmapped.ts"), "export const missing = true;\n");
    await commitAll(repo, "unmapped source");
    await saveSnapshotData(repo, structuredClone(features), {});
    const result = JSON.parse(await getSnapshot(repo));
    expect(result.stale).toBe(true);
    expect(result.drift.unmappedFiles).toEqual(["src/unmapped.ts"]);
    expect(result.drift.historyAvailable).toBe(true);
  });

  it("stays current after a refresh is committed and after an unrelated commit", async () => {
    await commitAll(repo, "save map");
    expect((await computeDrift(repo))!.stale).toBe(false);
    await fs.writeFile(path.join(repo, "README.md"), "unrelated documentation");
    await commitAll(repo, "docs");
    await saveSnapshotData(repo, {}, {});
    expect((await computeDrift(repo))!.stale).toBe(false);
    await commitAll(repo, "repin");
    expect((await computeDrift(repo))!.stale).toBe(false);
  });

  it("reports live edits separately from committed drift", async () => {
    await fs.writeFile(path.join(repo, "src/auth.ts"), "export const auth = false;\n");
    const drift = await computeDrift(repo);
    expect(drift!.stale).toBe(false);
    expect(drift!.workingTree?.changedFiles).toContain("src/auth.ts");
    const context = JSON.parse(await getContext(repo, "auth"));
    expect(context.features.auth.trust.freshness).toBe("changed");
  });

  it("uses directory anchors consistently for retrieval and drift", async () => {
    const result = await upsertDecision(repo, { title: "Platform rule", body: "Retain legacy compatibility.", category: "decision", files: ["src/"] });
    if (!("id" in result)) throw new Error("decision not saved");
    await fs.writeFile(path.join(repo, "src/auth.ts"), "export const auth = false;\n");
    await commitAll(repo, "change auth");
    expect((await computeDecisionDrift(repo)).staleDecisions[result.id]).toContain("src/auth.ts");
    const context = JSON.parse(await getContext(repo, "auth", ["src/auth.ts"]));
    expect(context.decisions[result.id].trust.freshness).toBe("changed");
  });

  it.each(["delete", "rename"])("keeps old decision anchors visible after a %s", async operation => {
    await upsertDecision(repo, { title: "Platform rule", body: "Retain legacy compatibility.", category: "decision", files: ["src/auth.ts"] });
    const base = await commitAll(repo, "decision");
    if (operation === "delete") await fs.unlink(path.join(repo, "src/auth.ts"));
    else await git(["mv", "src/auth.ts", "src/login.ts"], repo);
    await commitAll(repo, operation);
    const review = await computeReview(repo, base);
    expect(review!.touchedDecisions).toHaveLength(1);
    expect(review!.touchedDecisions[0].touchedFiles).toContain("src/auth.ts");
  });

  it("respects configured exclusions and bounds explicit reads", async () => {
    await fs.writeFile(path.join(repo, ".mason/config.json"), JSON.stringify({ ignore: ["src/auth.ts"] }));
    expect((await prepareSnapshotBatch(repo, 0)).skeletons).toEqual([]);
    expect(await readFullFile(repo, "src/auth.ts")).toBeNull();
    await fs.writeFile(path.join(repo, "large.ts"), "x".repeat(MAX_SOURCE_BYTES + 1));
    expect(await readFullFile(repo, "large.ts")).toBeNull();
    await fs.writeFile(path.join(repo, "credentials.ts"), "synthetic secret");
    expect(await readFullFile(repo, "credentials.ts")).toBeNull();
  });

  it("does not erase a failed verdict when a scoped refresh copies an entry", async () => {
    await saveVerification(repo, { auth: { ok: false, note: "Wrong implementation" } });
    await savePartial(repo, { batchId: "batch-0", offset: 0, features: {}, flows: {}, savedAt: new Date().toISOString() });
    await saveSnapshotData(repo, structuredClone(features), {});
    const result = JSON.parse(await getSnapshot(repo));
    expect(result.trust.features.auth.verification).toBe("failed");
  });

  it("reports malformed records while retaining valid decisions", async () => {
    await upsertDecision(repo, { title: "Auth rule", body: "Retain compatibility.", category: "decision", files: ["src/auth.ts"] });
    await fs.writeFile(path.join(repo, ".mason/decisions/broken.json"), JSON.stringify({ version: 1, id: "broken", title: "Broken", body: "Missing required arrays" }));
    const store = await loadDecisionStore(repo);
    expect(store.records).toHaveLength(1);
    expect(store.diagnostics).toHaveLength(1);
    const context = JSON.parse(await getContext(repo, "auth"));
    expect(context.diagnostics[0].path).toBe(".mason/decisions/broken.json");
    expect(Object.keys(context.decisions)).toHaveLength(1);
  });

  it("reports invalid snapshot structure as a CLI error", async () => {
    await fs.writeFile(path.join(repo, ".mason/snapshot.json"), JSON.stringify({ version: 2, features: null }));
    const errors: string[] = [];
    expect(await runDriftCli(["--dir", repo], { out: () => {}, err: line => errors.push(line) })).toBe(2);
    expect(errors.join(" ")).toContain("Invalid Mason snapshot");
  });

  it("rejects symlinked metadata before reading or writing outside the repository", async () => {
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(repo, ".mason/decisions"));
    await expect(writeStoreJson(repo, ".mason/decisions/rule.json", { value: 1 })).rejects.toThrow(/Symlink/);
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await loadDecisionStore(repo)).diagnostics).toHaveLength(1);
  });

  it("readers see complete documents during atomic replacement", async () => {
    const relative = ".mason/atomic.json";
    await writeStoreJson(repo, relative, { revision: 0, content: "x".repeat(50000) });
    const writer = (async () => {
      for (let revision = 1; revision <= 12; revision++) await writeStoreJson(repo, relative, { revision, content: "x".repeat(50000) });
    })();
    const reader = (async () => {
      for (let i = 0; i < 30; i++) {
        const result = await readStoreJson(repo, relative) as { revision: number; content: string };
        expect(result.content).toHaveLength(50000);
        expect(result.revision).toBeGreaterThanOrEqual(0);
      }
    })();
    await Promise.all([writer, reader]);
    expect((await fs.readdir(path.join(repo, ".mason"))).some(file => file.endsWith(".tmp"))).toBe(false);
  });

  it("warns hooks about unavailable decision history and avoids prefix collisions", async () => {
    const saved = await upsertDecision(repo, { title: "Platform rule", body: "Retain compatibility.", category: "decision", files: ["src/"] });
    if (!("id" in saved)) throw new Error("decision not saved");
    const file = path.join(repo, `.mason/decisions/${saved.id}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.refreshedHash = "0".repeat(40);
    record.history[0].refreshedHash = record.refreshedHash;
    await fs.writeFile(file, JSON.stringify(record));
    const input = (file: string) => JSON.stringify({ session_id: "unknown", cwd: repo, tool_name: "Read", tool_input: { file_path: path.join(repo, file) } });
    expect(await runHook(input("src-other/auth.ts"), { stateDir: tmp })).toBeNull();
    const output = JSON.parse((await runHook(input("src/auth.ts"), { stateDir: tmp }))!);
    expect(output.hookSpecificOutput.additionalContext).toContain("freshness unknown");
  });

  it("detects source files omitted from a map even when its base is HEAD", async () => {
    await fs.writeFile(path.join(repo, "src/new.ts"), "export const added = true;\n");
    await commitAll(repo, "new module");
    await saveSnapshotData(repo, structuredClone(features), {});
    const drift = await computeDrift(repo);
    expect(drift!.unmappedFiles).toContain("src/new.ts");
    expect(drift!.stale).toBe(true);
  });

  it("does not call an included partner missing when analysis truncates a large diff", async () => {
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(repo, "a.ts"), `export const a = ${i};\n`);
      await fs.writeFile(path.join(repo, "z.ts"), `export const z = ${i};\n`);
      await commitAll(repo, `paired ${i}`);
    }
    const base = await git(["rev-parse", "HEAD"], repo);
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(repo, `b${i}.ts`), "export {};\n");
    await fs.writeFile(path.join(repo, "a.ts"), "export const a = 99;\n");
    await fs.writeFile(path.join(repo, "z.ts"), "export const z = 99;\n");
    await commitAll(repo, "large diff includes both partners");
    const report = await computeReview(repo, base);
    expect(report!.truncated).toBe(true);
    expect(report!.missingPartners.some(f => f.missingPartner === "z.ts")).toBe(false);
  });

  it("retains exact paths containing tabs and Unicode in decision review", async () => {
    const file = "src/café\tfile.ts";
    await fs.writeFile(path.join(repo, file), "export const value = 1;\n");
    await upsertDecision(repo, { title: "Odd filename", body: "Keep compatibility.", category: "decision", files: [file] });
    const base = await commitAll(repo, "add unusual path");
    await fs.writeFile(path.join(repo, file), "export const value = 2;\n");
    await commitAll(repo, "change unusual path");
    expect((await computeReview(repo, base))!.touchedDecisions[0].touchedFiles).toEqual([file]);
  });

  it("fails closed when configured file exclusions are malformed", async () => {
    await fs.writeFile(path.join(repo, ".mason/config.json"), '{"ignore":"src/**"}');
    await expect(prepareSnapshotBatch(repo, 0)).rejects.toThrow(/file policy/);
  });
});
