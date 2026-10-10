import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  observations,
  cases,
  arms,
  fixture,
  knowledgePreserved,
} from "../bench/harness/knowledge/prevention-fixture.mjs";
import { digest } from "../bench/harness/knowledge/fixture.mjs";

const initial = {
  files: { "app.json": "before", "keep.pro": "rules" },
  knowledge: [{ id: "seeded-startup-1", revision: 1 }],
};
const context = (witness: Record<string, string>, revision = 1) => ({
  event: "result",
  name: "get_context",
  witness,
  result: {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          decisions: { "seeded-startup-1": { approval: "accepted", revision } },
        }),
      },
    ],
  },
});
const witness = { "app.json": digest("before"), "keep.pro": digest("rules") };

it("does not count late or wrong-revision retrieval as pre-edit delivery", () => {
  expect(observations(initial, [], [context(witness)]).mcpBeforeEdit).toBe(true);
  expect(
    observations(initial, [], [context({ ...witness, "app.json": digest("edited") })])
      .mcpBeforeEdit,
  ).toBe(false);
  expect(observations(initial, [], [context(witness, 2)]).mcpBeforeEdit).toBe(false);
});

it("requires both seeded conflicting records rather than accepting partial context", () => {
  const conflicting = {
    ...initial,
    knowledge: [...initial.knowledge, { id: "seeded-startup-2", revision: 1 }],
  };
  expect(observations(conflicting, [], [context(witness)]).mcpBeforeEdit).toBe(false);
});

it("distinguishes repeated unchanged notices from post-edit notices and hook errors", () => {
  const receipt = {
    event: "PostToolUse",
    before: witness,
    code: 0,
    output: { hookSpecificOutput: { additionalContext: "Inspect the startup decision" } },
  };
  const result = observations(
    initial,
    [
      receipt,
      receipt,
      { ...receipt, before: { ...witness, "app.json": digest("edited") } },
      { event: "Stop", code: 1, error: "observer failure", output: null },
    ],
    [],
  );
  expect(result.repeatedUnchangedNotices).toBe(1);
  expect(result.notices.map((n: { beforeEdit: boolean }) => n.beforeEdit)).toEqual([
    true,
    true,
    false,
  ]);
  expect(result.hookErrors).toBe(1);
  expect(result.mcpBeforeEdit).toBe(false);
  expect(cases).toContain("conflict");
  expect(arms).toEqual(["notes", "mcp", "hooks"]);
});

it("seeds both conflicting lessons through actual creation and review APIs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-prevention-seed-test-"));
  try {
    const seeded = await fixture(path.join(dir, "fixture"), {
      arm: "mcp",
      scenario: "conflict",
      guidance: "",
      toolchain: {},
      binary: path.resolve("dist/mason.js"),
      mcp: path.resolve("dist/mason-mcp.js"),
    });
    expect(seeded.knowledge).toHaveLength(2);
    expect(seeded.knowledge.every((d: { approval: string }) => d.approval === "accepted")).toBe(
      true,
    );
    expect(seeded.files["app.json"]).toContain('"requestedBackground": true');
    expect(seeded.files["policy.md"]).toContain("No such revision has been recorded");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("allows witnessed appended source inspections but rejects approval changes and forged inspections", () => {
  const old = {
    id: "lesson",
    body: "Preserve startup",
    approval: "accepted",
    history: [],
    inspections: [],
  };
  const inspection = { outcome: "no_contradiction_found", note: "Source inspected" };
  const updated = { ...old, inspections: [inspection] };
  const events = [
    {
      event: "result",
      name: "review_decision",
      result: {
        content: [
          { type: "text", text: JSON.stringify({ status: "inspected", id: old.id, inspection }) },
        ],
      },
    },
  ];
  expect(knowledgePreserved([old], [updated], events)).toBe(true);
  expect(knowledgePreserved([old], [updated], [])).toBe(false);
  expect(knowledgePreserved([old], [{ ...updated, body: "New policy" }], events)).toBe(false);
  expect(knowledgePreserved([old], [{ ...updated, approval: "proposed" }], events)).toBe(false);
});
