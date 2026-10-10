import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initGitRepo, commitAll } from "./helpers.js";
import {
  upsertDecision,
  loadDecisions,
  loadDecisionStore,
  readDecisionInputs,
} from "../src/decisions/decisions.js";
import { reviewDecision } from "../src/decisions/review.js";
import { computeDecisionDrift } from "../src/decisions/drift.js";
import { decisionKnowledge } from "../src/decisions/provenance.js";
import * as anchorEvidence from "../src/decisions/anchors.js";
import { automate } from "../src/automation/runtime.js";
import { captureAnchorScopes } from "../src/decisions/anchors.js";
import { withRepositoryInspection } from "../src/audit/inspection.js";
import * as fileReads from "../src/utils/files.js";
import * as gitReads from "../src/utils/git-read.js";
import { readInputs } from "../src/automation/evidence.js";
import { prepareRepair, verifyRepair } from "../src/audit/repair.js";

describe("captured anchors and separate source inspections", () => {
  let root: string;
  const input = {
    title: "Keep retries bounded",
    body: "The retry count must remain bounded.",
    category: "decision" as const,
    files: ["src/client.ts"],
  };
  const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text);
  const get = async () => (await loadDecisions(root))[0];
  const create = async (extra = {}) => {
    await upsertDecision(root, { ...input, ...extra });
    return (await get()).id;
  };
  const inspect = async (id: string) => {
    const prepared = await reviewDecision(root, { id });
    return reviewDecision(root, {
      id,
      action: "inspect",
      inspector: "Codex",
      note: "Read the changed retry code; the limit still holds.",
      reviewToken: prepared.reviewToken,
    });
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-inspection-"));
    await initGitRepo(root);
    await fs.mkdir(path.join(root, "src"));
    await write("README.md", "# Client\n");
    await write("src/client.ts", "export const retries = 1;\n");
    await commitAll(root, "initial");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads decision bytes once per inspection, isolates callers and invalidates after writes", async () => {
    const id = await create();
    const observed = vi.spyOn(fileReads, "readBoundedFile");
    try {
      await withRepositoryInspection(root, async () => {
        const raw = await readDecisionInputs(root);
        const first = await loadDecisionStore(root);
        first.records[0].title = "Caller-local change";
        raw.inputs[0][1] = "Caller-local bytes";
        expect((await loadDecisionStore(root)).records[0].title).toBe(input.title);
        expect((await readDecisionInputs(root)).inputs[0][1]).not.toBe("Caller-local bytes");
        expect(observed.mock.calls.filter(([file]) => file.endsWith(`/${id}.json`))).toHaveLength(
          1,
        );
        await upsertDecision(root, { ...input, id, body: "Retry exactly twice." });
        expect((await loadDecisionStore(root)).records[0].body).toBe("Retry exactly twice.");
        expect(observed.mock.calls.filter(([file]) => file.endsWith(`/${id}.json`))).toHaveLength(
          2,
        );
      });
      await withRepositoryInspection(root, () => loadDecisionStore(root));
      expect(observed.mock.calls.filter(([file]) => file.endsWith(`/${id}.json`))).toHaveLength(3);
    } finally {
      observed.mockRestore();
    }
  });

  it("rejects decision record changes after the initial input observation", async () => {
    const id = await create();
    await commitAll(root, "proposal");
    await automate(root, { event: "session_start" });
    const original = anchorEvidence.captureAnchorScopes;
    let changed = false;
    const observed = vi
      .spyOn(anchorEvidence, "captureAnchorScopes")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        if (!changed) {
          changed = true;
          const file = path.join(root, `.mason/decisions/${id}.json`);
          await fs.writeFile(
            file,
            (await fs.readFile(file, "utf8")).replace(input.body, "Unexpected external revision."),
          );
        }
        return result;
      });
    try {
      await expect(automate(root, { event: "task_end" })).rejects.toMatchObject({
        failure: { code: "inputs-changed" },
      });
    } finally {
      observed.mockRestore();
    }
  });

  it("batches inventories across scopes but reads fresh evidence in final validation", async () => {
    const scopes = [];
    for (let i = 0; i < 10; i++) {
      await write(`src/part-${i}.ts`, `export const value = ${i};\n`);
      scopes.push([`src/part-${i}.ts`]);
    }
    const observed = vi.spyOn(gitReads, "execGit");
    try {
      const first = await withRepositoryInspection(root, async () => {
        const captured = await captureAnchorScopes(root, scopes);
        expect(await captureAnchorScopes(root, scopes)).toEqual(captured);
        return captured;
      });
      expect(first.every((capture) => capture.complete)).toBe(true);
      expect(observed.mock.calls.filter(([args]) => args[0] === "ls-files")).toHaveLength(2);
      await write("src/part-0.ts", "export const value = 42;\n");
      const final = await withRepositoryInspection(root, () => captureAnchorScopes(root, scopes));
      expect(final[0].files).not.toEqual(first[0].files);
      expect(observed.mock.calls.filter(([args]) => args[0] === "ls-files")).toHaveLength(4);
    } finally {
      observed.mockRestore();
    }
  });

  it("rejects a dirty anchor changing between initial capture and publication", async () => {
    await create();
    await commitAll(root, "proposal");
    await write("src/client.ts", "export const retries = 2;\n");
    await automate(root, { event: "session_start" });
    const original = anchorEvidence.captureAnchorScopes;
    let changed = false;
    const observed = vi
      .spyOn(anchorEvidence, "captureAnchorScopes")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        if (!changed) {
          changed = true;
          await write("src/client.ts", "export const retries = 3;\n");
        }
        return result;
      });
    try {
      await expect(automate(root, { event: "task_end" })).rejects.toMatchObject({
        failure: { code: "inputs-changed" },
      });
    } finally {
      observed.mockRestore();
    }
  });

  it("does not flag the commit that introduces an already captured implementation", async () => {
    await write("src/client.ts", "export const retries = 2;\n");
    const id = await create();
    const saved = await get();
    expect((await computeDecisionDrift(root)).freshness?.[id]).toBe("current");
    await commitAll(root, "decision and implementation together");
    expect(await computeDecisionDrift(root)).toMatchObject({
      staleDecisions: {},
      freshness: { [id]: "current" },
    });
    expect((await get()).refreshedHash).toBe(saved.refreshedHash);
    expect((await get()).approval).toBe("proposed");
  });

  it("detects implementation written after capture, including directory additions and deletions", async () => {
    const id = await create({ files: ["src"] });
    await write("src/queue.ts", "export const queue = 1;\n");
    await fs.unlink(path.join(root, "src/client.ts"));
    expect((await computeDecisionDrift(root)).staleDecisions[id]).toEqual([
      "src/client.ts",
      "src/queue.ts",
    ]);
    await commitAll(root, "changed anchors");
    expect((await computeDecisionDrift(root)).staleDecisions[id]).toEqual([
      "src/client.ts",
      "src/queue.ts",
    ]);
  });

  it("resolves retained drift through inspection without changing approval or review history", async () => {
    const id = await create();
    await commitAll(root, "proposal");
    await write("src/client.ts", "export const retries = 2;\n");
    await commitAll(root, "bounded implementation changed");
    const baseline = await prepareRepair(root, ["decision-anchor-drift"]);
    expect(baseline.report.advisories).toHaveLength(1);
    const before = await get();
    expect((await inspect(id)).status).toBe("inspected");
    const after = await get();
    expect(after.history).toEqual(before.history);
    expect(after.refreshedHash).toBe(before.refreshedHash);
    expect(after.approval).toBe("proposed");
    expect(decisionKnowledge(after, "current")).toMatchObject({
      lastReview: null,
      reviewRequired: true,
      inspection: { inspector: "Codex" },
    });
    expect((await verifyRepair(root, baseline.baselinePath)).findings[0]).toMatchObject({
      status: "resolved",
      review: { outcome: "no_contradiction_found" },
    });
    await commitAll(root, "record inspection");
    expect((await verifyRepair(root, baseline.baselinePath)).status).toBe("verified");
    await write("README.md", "# Unrelated change\n");
    await commitAll(root, "unrelated");
    expect((await verifyRepair(root, baseline.baselinePath)).status).toBe("verified");
    await write("src/client.ts", "export const retries = 3;\n");
    await commitAll(root, "later anchor edit");
    expect((await verifyRepair(root, baseline.baselinePath)).findings[0]).toMatchObject({
      status: "review-required",
      review: { status: "reopened" },
    });
  });

  it("invalidates tokens on a second edit while the dirty path and HEAD stay identical", async () => {
    const id = await create();
    await write("src/client.ts", "export const retries = 2;\n");
    const prepared = await reviewDecision(root, { id });
    const beforeInputs = await readInputs(root);
    await write("src/client.ts", "export const retries = 3;\n");
    expect((await readInputs(root)).fingerprint).not.toBe(beforeInputs.fingerprint);
    expect(
      (
        await reviewDecision(root, {
          id,
          action: "inspect",
          inspector: "Codex",
          note: "Read code",
          reviewToken: prepared.reviewToken,
        })
      ).status,
    ).toBe("conflict");
    expect((await get()).inspections).toBeUndefined();
  });

  it("reopens inspection when the proposal content is revised", async () => {
    const id = await create();
    expect((await inspect(id)).status).toBe("inspected");
    await upsertDecision(root, { ...input, id, body: "Retry exactly once." });
    expect(decisionKnowledge(await get()).inspection).toBeUndefined();
    expect((await get()).inspections).toHaveLength(1);
  });

  it("keeps the accepted baseline operative while a new proposal captures current code", async () => {
    const id = await create({
      owner: "Client team",
      sources: [{ kind: "document", reference: "README.md" }],
    });
    const prepared = await reviewDecision(root, { id });
    expect(
      (
        await reviewDecision(root, {
          id,
          action: "accept",
          reviewer: "Fixture reviewer",
          note: "Reviewed code",
          reviewToken: prepared.reviewToken,
        })
      ).status,
    ).toBe("accepted");
    await write("src/client.ts", "export const retries = 2;\n");
    await commitAll(root, "implementation update");
    await upsertDecision(root, { ...input, id, body: "The retry count is now two." });
    expect(await computeDecisionDrift(root)).toMatchObject({
      freshness: { [id]: "changed" },
      pendingProposals: { [id]: { freshness: "current" } },
    });
    const before = await get();
    expect((await inspect(id)).status).toBe("inspected");
    expect((await get()).history).toEqual(before.history);
    expect((await computeDecisionDrift(root)).freshness?.[id]).toBe("current");
    expect(decisionKnowledge(await get())).toMatchObject({
      approval: "accepted",
      pendingProposal: { approval: "proposed" },
      lastReview: { reviewer: "Fixture reviewer" },
    });
  });

  it("refuses inspection of excluded or symlink anchor evidence", async () => {
    await write(".gitignore", ".env\n");
    await write(".env", "SECRET=value\n");
    const id = await create({ files: [".env"] });
    expect((await computeDecisionDrift(root)).freshness?.[id]).toBe("unknown");
    expect((await inspect(id)).status).toBe("error");
    await fs.symlink("client.ts", path.join(root, "src/link.ts"));
    const result = await upsertDecision(root, { ...input, id, files: ["src/link.ts"] });
    expect(result.status).toBe("updated");
    expect((await inspect(id)).status).toBe("error");
  });
});
