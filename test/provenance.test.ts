import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initGitRepo, commitAll } from "./helpers.js";
import { upsertDecision, loadDecisionStore, loadDecisions, saveDecisionRecord } from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { getContext, getSnapshot, saveSnapshotData } from "../src/mcp/tools.js";
import { computeReview } from "../src/review/review.js";
import { formatReviewSummary } from "../src/review/cli.js";
import { runHook } from "../src/hook/hook.js";
import { computeAudit } from "../src/audit/audit.js";

describe("decision provenance and reviews", () => {
  let repo: string;
  const lesson = { title: "Delivery retries need keys", body: "An incident duplicated orders. Only retry a delivery with an idempotency key.", category: "gotcha" as const, files: ["src/delivery.ts"] };
  const attribution = { owner: "Delivery team", sources: [{ kind: "incident" as const, reference: "incidents/42", note: "Incident review settled retry behavior" }], actor: "Incident recorder" };
  const write = (file: string, value: string) => fs.writeFile(path.join(repo, file), value);
  const get = async () => (await loadDecisions(repo))[0];
  const create = async () => { const result = await upsertDecision(repo, { ...lesson, ...attribution }); expect(result.status).toBe("created"); return get(); };
  const verdict = async (id: string, action: "accept" | "reaffirm" | "retire", extra = {}) => {
    const prepared = await reviewDecision(repo, { id });
    expect(prepared.status).toBe("prepared");
    return reviewDecision(repo, { id, action, reviewer: "Adrian", note: "Reviewed the incident rationale and current delivery behavior.", reviewToken: prepared.reviewToken, ...extra });
  };
  const context = async () => JSON.parse(await getContext(repo, "delivery retries"));
  const hook = async () => {
    const result = await runHook(JSON.stringify({ session_id: "review-session", cwd: repo, tool_name: "Read", tool_input: { file_path: path.join(repo, "src/delivery.ts") } }), { stateDir: repo });
    return result ? JSON.parse(result).hookSpecificOutput.additionalContext : null;
  };

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "mason-provenance-"));
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "src"));
    await write("src/delivery.ts", "export const retries = 1;\n");
    await commitAll(repo, "initial delivery");
  });
  afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("captures proposals immediately without inventing an owner or approval", async () => {
    await upsertDecision(repo, lesson);
    const record = await get();
    expect(record.version).toBe(2);
    expect(record.approval).toBe("proposed");
    expect(record.owner).toBeUndefined();
    expect(record.sources).toEqual([]);
    expect(record.history[0].actor).toBeUndefined();
    expect((await context()).decisions[record.id]).toMatchObject({ approval: "proposed", guidance: "proposal", reviewRequired: true, trust: { verification: "unverified" } });
  });

  it("keeps legacy knowledge unreviewed and leaves its bytes untouched on read", async () => {
    const now = new Date().toISOString();
    await saveDecisionRecord(repo, { ...lesson, version: 1, id: "legacy", createdAt: now, updatedAt: now, refreshedHash: "unknown", status: "active", approval: "accepted", owner: "not evidence" });
    const file = path.join(repo, ".mason/decisions/legacy.json");
    const before = await fs.readFile(file, "utf8");
    expect((await context()).decisions.legacy).toMatchObject({ approval: "unreviewed", owner: null, sources: [], lastReview: null });
    await reviewDecision(repo, { id: "legacy" });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("requires owner, sources, reviewer and reason for acceptance", async () => {
    await upsertDecision(repo, lesson);
    const record = await get();
    expect((await reviewDecision(repo, { id: record.id, action: "accept" })).status).toBe("error");
    expect((await verdict(record.id, "accept")).status).toBe("error");
    expect((await get()).history).toHaveLength(1);
  });

  it("records acceptance against the prepared code and exposes provenance without a map", async () => {
    const record = await create();
    const accepted = await verdict(record.id, "accept");
    expect(accepted.status).toBe("accepted");
    const saved = await get();
    expect(saved.history.map(e => e.kind)).toEqual(["created", "accepted"]);
    expect(saved.history[1]).toMatchObject({ actor: "Adrian", content: { owner: attribution.owner, sources: attribution.sources }, evidence: { localChanges: [], historyAvailable: true } });
    const result = (await context()).decisions[record.id];
    expect(result).toMatchObject({ approval: "accepted", guidance: "constraint", reviewRequired: false, owner: attribution.owner, trust: { verification: "passed", freshness: "current" }, lastReview: { reviewer: "Adrian" } });
  });

  it("saving identical content neither reaffirms nor hides changed anchors", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    const before = await get();
    await write("src/delivery.ts", "export const retries = 2;\n");
    await commitAll(repo, "change retry behavior");
    expect((await upsertDecision(repo, { ...lesson, id: record.id })).status).toBe("unchanged");
    expect(await get()).toEqual(before);
    expect((await context()).decisions[record.id]).toMatchObject({ approval: "accepted", reviewRequired: true, trust: { freshness: "changed" } });
  });

  it("content changes become a new proposal and retain the old accepted content", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    await upsertDecision(repo, { ...lesson, id: record.id, body: "Retries now use a persistent deduplication record.", actor: "Editor" });
    const updated = await get();
    expect(updated).toMatchObject({ approval: "proposed", revision: 2 });
    expect(updated.history.map(e => e.kind)).toEqual(["created", "accepted", "revised"]);
    expect(updated.history[1].content.body).toBe(lesson.body);
    expect(updated.history[2].actor).toBe("Editor");
    expect((await context()).decisions[record.id]).toMatchObject({ lastReview: null, trust: { verification: "unverified" } });
    expect((await verdict(record.id, "reaffirm")).status).toBe("error");
  });

  it("owner and source changes also require a new acceptance", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    await upsertDecision(repo, { ...lesson, id: record.id, owner: "New team", sources: [{ kind: "pull_request", reference: "PR-123" }] });
    expect(await get()).toMatchObject({ approval: "proposed", owner: "New team", revision: 2 });
    expect((await get()).history[1].content.sources).toEqual(attribution.sources);
  });

  it("rejects a review prepared before a code commit", async () => {
    const record = await create();
    const prepared = await reviewDecision(repo, { id: record.id });
    await write("src/delivery.ts", "export const retries = 3;\n");
    await commitAll(repo, "new source");
    const result = await reviewDecision(repo, { id: record.id, action: "accept", reviewer: "Adrian", note: "Reviewed", reviewToken: prepared.reviewToken });
    expect(result.status).toBe("conflict");
    expect((await get()).approval).toBe("proposed");
  });

  it("rejects a review prepared before a decision edit", async () => {
    const record = await create();
    const prepared = await reviewDecision(repo, { id: record.id });
    await upsertDecision(repo, { ...lesson, id: record.id, body: "A revised constraint." });
    expect((await reviewDecision(repo, { id: record.id, action: "accept", reviewer: "Adrian", note: "Reviewed", reviewToken: prepared.reviewToken })).status).toBe("conflict");
  });

  it("requires committed anchor changes but allows unrelated local work", async () => {
    const record = await create();
    await write("src/delivery.ts", "export const retries = 4;\n");
    expect((await verdict(record.id, "accept")).status).toBe("error");
    await commitAll(repo, "commit reviewed source");
    await write("unrelated.txt", "unfinished work\n");
    expect((await verdict(record.id, "accept")).status).toBe("accepted");
  });

  it("shows the diff and preserves reaffirmation through the final metadata commit", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    await write("src/delivery.ts", "export const retries = 5;\n");
    const changed = await commitAll(repo, "change source after acceptance");
    const prepared = await reviewDecision(repo, { id: record.id });
    expect(prepared.evidence.changedFiles).toContain("src/delivery.ts");
    expect(prepared.previews.diff).toContain("+export const retries = 5;");
    expect((await verdict(record.id, "reaffirm")).status).toBe("reaffirmed");
    const reviewed = await get();
    expect(reviewed.refreshedHash).toBe(changed);
    expect(reviewed.history.map(e => e.kind)).toEqual(["created", "accepted", "reaffirmed"]);
    await commitAll(repo, "commit review metadata");
    expect((await context()).decisions[record.id]).toMatchObject({ reviewRequired: false, trust: { freshness: "current", verification: "passed" } });
  });

  it("imports legacy history explicitly and retains an unavailable old baseline", async () => {
    const now = new Date().toISOString();
    await saveDecisionRecord(repo, { ...lesson, id: "legacy", version: 1, createdAt: now, updatedAt: now, refreshedHash: "unknown", status: "active" });
    await upsertDecision(repo, { ...lesson, ...attribution, id: "legacy" });
    expect((await verdict("legacy", "accept")).status).toBe("accepted");
    const record = await get();
    expect(record.history.map(e => e.kind)).toEqual(["imported", "revised", "accepted"]);
    expect(record.history[0]).toMatchObject({ approval: "unreviewed", refreshedHash: "unknown" });
    expect(record.history[2].evidence.historyAvailable).toBe(false);
  });

  it("withdraws a retired decision from retrieval and an existing hook session", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    expect(await hook()).toContain("[accepted]");
    expect((await verdict(record.id, "retire")).status).toBe("retired");
    expect((await context()).decisions).toEqual({});
    expect(await hook()).toContain("[retired]");
    expect(await hook()).toBeNull();
    expect((await upsertDecision(repo, { ...lesson, id: record.id })).status).toBe("error");
  });

  it("reinforces acceptance changes in a hook session without repeating unchanged records", async () => {
    const record = await create();
    expect(await hook()).toContain("[proposed]");
    expect(await hook()).toBeNull();
    await verdict(record.id, "accept");
    const accepted = await hook();
    expect(accepted).toContain("[accepted]");
    expect(accepted).toContain(attribution.sources[0].reference);
    expect(await hook()).toBeNull();
  });

  it("does not let a new proposal supersede an accepted constraint", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    const result = await upsertDecision(repo, { ...lesson, title: "Replacement", supersedes: record.id, force: true });
    expect(result.status).toBe("error");
    expect(await get()).toMatchObject({ status: "active", approval: "accepted" });
    expect((await loadDecisions(repo))).toHaveLength(1);
  });

  it("keeps provenance in map indexes and committed-diff reviews", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    await saveSnapshotData(repo, { delivery: { description: "Delivery", files: lesson.files } }, {});
    expect(JSON.parse(await getSnapshot(repo)).decisions[record.id]).toMatchObject({ approval: "accepted", owner: attribution.owner });
    const base = await commitAll(repo, "save knowledge");
    await write("src/delivery.ts", "export const retries = 6;\n");
    await commitAll(repo, "change source");
    const review = await computeReview(repo, base);
    expect(review.touchedDecisions[0]).toMatchObject({ approval: "accepted", sources: attribution.sources, reviewRequired: true });
    expect(formatReviewSummary(review)).toContain("accepted; owner Delivery team");
    expect(formatReviewSummary(review)).toContain("incidents/42");
    await write("AGENTS.md", "Delivery behavior lives in `src/delivery.ts`.\n");
    const audit = await computeAudit(repo, { checks: ["decision-anchor-drift"] });
    expect(audit.advisories[0].evidence.provenance).toMatchObject({ approval: "accepted", owner: attribution.owner, reviewRequired: true });
  });

  it("diagnoses content changed outside its revision history", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    const tampered = { ...await get(), body: "Unexpected content with inherited approval" };
    await write(`.mason/decisions/${record.id}.json`, JSON.stringify(tampered));
    const store = await loadDecisionStore(repo);
    expect(store.records).toEqual([]);
    expect(store.diagnostics[0].message).toMatch(/final history event/);
    expect((await context()).diagnostics).toHaveLength(1);
  });

  it("does not lose review events when the same prepared review is submitted concurrently", async () => {
    const record = await create();
    const prepared = await reviewDecision(repo, { id: record.id });
    const request = { id: record.id, action: "accept" as const, reviewer: "Adrian", note: "Reviewed", reviewToken: prepared.reviewToken };
    const results = await Promise.all([reviewDecision(repo, request), reviewDecision(repo, request)]);
    expect(results.filter(r => r.status === "accepted")).toHaveLength(1);
    expect((await get()).history.map(e => e.kind)).toEqual(["created", "accepted"]);
  });
});
