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
import { computeDecisionDrift } from "../src/decisions/drift.js";
import { inspectOnboarding } from "../src/mcp/onboarding.js";

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
    expect((await context()).decisions[record.id]).toMatchObject({
      body: lesson.body, approval: "accepted", revision: 1, lastReview: { reviewer: "Adrian" }, trust: { verification: "passed" },
      pendingProposal: { body: updated.body, approval: "proposed", revision: 2, lastReview: null, trust: { verification: "unverified" } },
    });
    expect((await verdict(record.id, "reaffirm")).status).toBe("error");
  });

  it("owner and source changes also require a new acceptance", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    await upsertDecision(repo, { ...lesson, id: record.id, owner: "New team", sources: [{ kind: "pull_request", reference: "PR-123" }] });
    expect(await get()).toMatchObject({ approval: "proposed", owner: "New team", revision: 2 });
    expect((await get()).history[1].content.sources).toEqual(attribution.sources);
    expect((await context()).decisions[record.id]).toMatchObject({ owner: attribution.owner, sources: attribution.sources,
      pendingProposal: { owner: "New team", sources: [{ kind: "pull_request", reference: "PR-123" }], approval: "proposed" } });
  });

  it.each(["missing", "available", "invalid"])("retrieves accepted and proposed anchors with a %s map without rewriting the record", async map => {
    await write("src/queue.ts", "export const schedule = true;\n");
    await commitAll(repo, "queue implementation");
    const record = await create();
    await verdict(record.id, "accept");
    await upsertDecision(repo, { ...lesson, id: record.id, title: "Queue scheduling", body: "Schedule using the new queue.", files: ["src/queue.ts"] });
    if (map === "available") await saveSnapshotData(repo, { unrelated: { description: "Unrelated capability", files: [] } }, {});
    if (map === "invalid") await write(".mason/snapshot.json", "invalid JSON");
    const recordPath = `.mason/decisions/${record.id}.json`;
    const before = await fs.readFile(path.join(repo, recordPath), "utf8");
    for (const task of ["delivery retries", "queue scheduling"]) {
      const result = JSON.parse(await getContext(repo, task));
      expect(result.decisions[record.id]).toMatchObject({ title: lesson.title, body: lesson.body, files: lesson.files, approval: "accepted",
        pendingProposal: { title: "Queue scheduling", files: ["src/queue.ts"], approval: "proposed" } });
      expect(result.impact.targets).toEqual(expect.arrayContaining(["src/delivery.ts", "src/queue.ts"]));
    }
    expect(await fs.readFile(path.join(repo, recordPath), "utf8")).toBe(before);
    expect((await inspectOnboarding(repo)).decisions).toMatchObject({ active: 1, accepted: 1, proposed: 0, pendingProposals: 1 });
  });

  it("keeps accepted and proposed freshness separate when draft anchors move", async () => {
    await write("src/queue.ts", "export const schedule = true;\n");
    await commitAll(repo, "queue implementation");
    const record = await create();
    await verdict(record.id, "accept");
    await upsertDecision(repo, { ...lesson, id: record.id, files: ["src/queue.ts"] });
    await write("src/queue.ts", "export const schedule = false;\n");
    expect((await context()).decisions[record.id]).toMatchObject({ trust: { freshness: "current" }, pendingProposal: { trust: { freshness: "changed" } } });
    await commitAll(repo, "change draft anchor");
    const drift = await computeDecisionDrift(repo);
    expect(drift.staleDecisions).toEqual({});
    expect(drift.pendingProposals[record.id]).toMatchObject({ freshness: "changed", changedFiles: ["src/queue.ts"] });
    await upsertDecision(repo, { ...lesson, id: record.id, files: [] });
    await fs.unlink(path.join(repo, "src/delivery.ts"));
    await commitAll(repo, "remove accepted anchor");
    expect((await context()).decisions[record.id]).toMatchObject({ files: lesson.files, trust: { freshness: "changed" },
      pendingProposal: { files: [], trust: { freshness: "unknown" } } });
    expect((await computeDecisionDrift(repo)).staleDecisions[record.id]).toContain("src/delivery.ts");
  });

  it("preserves unavailable accepted history while showing an unverified proposal", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    const accepted = await get();
    const unreachable = "f".repeat(40);
    accepted.refreshedHash = unreachable;
    accepted.history[1].refreshedHash = unreachable;
    accepted.history[1].evidence.headHash = unreachable;
    await saveDecisionRecord(repo, accepted);
    await upsertDecision(repo, { ...lesson, id: record.id, body: "A revised delivery constraint." });
    expect((await context()).decisions[record.id]).toMatchObject({ approval: "accepted", body: lesson.body,
      trust: { freshness: "unknown" }, pendingProposal: { approval: "proposed", trust: { freshness: "unknown", verification: "unverified" } } });
  });

  it("keeps the latest accepted baseline across multiple drafts and the final metadata commit", async () => {
    await write("src/queue.ts", "export const schedule = true;\n");
    await commitAll(repo, "queue implementation");
    const record = await create();
    await verdict(record.id, "accept");
    await upsertDecision(repo, { ...lesson, id: record.id, title: "Queue scheduling", body: "Schedule using the new queue.", files: ["src/queue.ts"] });
    const prepared = await reviewDecision(repo, { id: record.id });
    expect(prepared.operativeDecision).toMatchObject({ approval: "accepted", body: lesson.body });
    expect(prepared.record).toMatchObject({ approval: "proposed", files: ["src/queue.ts"] });
    expect(prepared.previews.files.map(f => f.path)).toEqual(expect.arrayContaining(["src/delivery.ts", "src/queue.ts"]));
    await write("src/delivery.ts", "export const retries = 2;\n");
    expect((await reviewDecision(repo, { id: record.id, action: "accept", reviewer: "Adrian", note: "Review", reviewToken: prepared.reviewToken })).status).toBe("conflict");
    expect((await verdict(record.id, "accept")).status).toBe("error");
    await commitAll(repo, "commit accepted anchor changes");
    expect((await verdict(record.id, "accept")).status).toBe("accepted");
    await commitAll(repo, "commit replacement acceptance");
    const replacement = JSON.parse(await getContext(repo, "queue scheduling")).decisions[record.id];
    expect(replacement).toMatchObject({ title: "Queue scheduling", revision: 2, approval: "accepted", trust: { freshness: "current" } });
    expect(replacement.pendingProposal).toBeUndefined();
    await upsertDecision(repo, { ...lesson, id: record.id, body: "Third revision." });
    await upsertDecision(repo, { ...lesson, id: record.id, body: "Fourth revision." });
    expect((await context()).decisions[record.id]).toMatchObject({ title: "Queue scheduling", revision: 2, approval: "accepted",
      pendingProposal: { body: "Fourth revision.", revision: 4, approval: "proposed" } });
  });

  it.each(["accept", "retire"] as const)("updates hook sessions on %s even when draft anchors have moved", async action => {
    await write("src/queue.ts", "export const schedule = true;\n");
    await commitAll(repo, "queue implementation");
    const record = await create();
    await verdict(record.id, "accept");
    expect(await hook()).toContain(lesson.body);
    const draft = { ...lesson, id: record.id, title: "Queue scheduling", body: "Schedule using the new queue.", files: ["src/queue.ts"] };
    await upsertDecision(repo, draft);
    const injection = await hook();
    expect(injection).toContain("[accepted]");
    expect(injection).toContain(lesson.body);
    expect(injection).toContain("[proposed]");
    expect(injection).toContain(draft.body);
    expect(await hook()).toBeNull();
    expect((await verdict(record.id, action)).status).toBe(action === "accept" ? "accepted" : "retired");
    const changed = await hook();
    expect(changed).toContain(action === "accept" ? "[accepted]" : "[retired]");
    expect(changed).toContain(record.id);
    expect(changed).not.toContain(lesson.body);
    expect(changed).not.toContain("[proposed]");
    expect(await hook()).toBeNull();
    const result = JSON.parse(await getContext(repo, "queue scheduling"));
    if (action === "retire") expect(result.decisions).toEqual({});
    else expect(result.decisions[record.id].pendingProposal).toBeUndefined();
    const newSession = await runHook(JSON.stringify({ session_id: "fresh-session", cwd: repo, tool_name: "Read", tool_input: { file_path: path.join(repo, "src/delivery.ts") } }), { stateDir: repo });
    expect(newSession).toBeNull();
  });

  it("does not let superseding a draft archive its operative accepted constraint", async () => {
    const record = await create();
    await verdict(record.id, "accept");
    await upsertDecision(repo, { ...lesson, id: record.id, body: "Proposed replacement." });
    expect((await upsertDecision(repo, { ...lesson, title: "Another replacement", supersedes: record.id, force: true })).status).toBe("error");
    expect((await context()).decisions[record.id]).toMatchObject({ approval: "accepted", body: lesson.body });
    expect(await loadDecisions(repo)).toHaveLength(1);
  });

  it("keeps revision content and anchors distinct in map indexes, audits, and diff reviews", async () => {
    await write("src/queue.ts", "export const schedule = true;\n");
    await write("AGENTS.md", "Delivery behavior lives in `src/delivery.ts`.\n");
    await commitAll(repo, "queue implementation and docs");
    const record = await create();
    await verdict(record.id, "accept");
    await upsertDecision(repo, { ...lesson, id: record.id, title: "Queue scheduling", body: "Schedule using the new queue.", files: ["src/queue.ts"] });
    await saveSnapshotData(repo, { delivery: { description: "Delivery", files: lesson.files } }, {});
    const base = await commitAll(repo, "save knowledge");
    await write("src/queue.ts", "export const schedule = false;\n");
    await commitAll(repo, "change proposal anchor");
    const draftReview = await computeReview(repo, base);
    expect(draftReview.touchedDecisions[0]).toMatchObject({ approval: "accepted", touchedFiles: [], freshness: "current",
      pendingProposal: { approval: "proposed", touchedFiles: ["src/queue.ts"], trust: { freshness: "changed" } } });
    await write("src/delivery.ts", "export const retries = 6;\n");
    await commitAll(repo, "change accepted anchor");
    const index = JSON.parse(await getSnapshot(repo)).decisions[record.id];
    expect(index).toMatchObject({ title: lesson.title, approval: "accepted", pendingProposal: { title: "Queue scheduling", approval: "proposed" } });
    expect(index.body).toBeUndefined();
    expect(index.pendingProposal.body).toBeUndefined();
    const review = await computeReview(repo, base);
    expect(review.touchedDecisions[0]).toMatchObject({ body: lesson.body, approval: "accepted", anchors: lesson.files, touchedFiles: lesson.files,
      pendingProposal: { body: "Schedule using the new queue.", files: ["src/queue.ts"], touchedFiles: ["src/queue.ts"] } });
    expect(formatReviewSummary(review)).toContain("accepted revision 1 remains operative");
    const audit = await computeAudit(repo, { checks: ["decision-anchor-drift"] });
    expect(audit.advisories.map(a => a.evidence)).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: lesson.title, changedFiles: lesson.files, provenance: expect.objectContaining({ approval: "accepted" }) }),
      expect.objectContaining({ title: "Queue scheduling", changedFiles: ["src/queue.ts"], provenance: expect.objectContaining({ approval: "proposed" }) }),
    ]));
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
