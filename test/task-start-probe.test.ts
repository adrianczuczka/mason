import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { select } from "../bench/harness/knowledge/task-start-probe.mjs";

const decision = (overrides = {}) => ({
  title: "Scheduler startup protection",
  body: "Preserve the constructor when scheduling is required.",
  revision: 1,
  approval: "accepted",
  score: 5,
  category: "gotcha",
  files: ["app.json"],
  sources: [{ kind: "document", reference: "policy.md" }],
  trust: { freshness: "current" },
  ...overrides,
});

it("keeps unsupported events, missing prompts and foreign checkouts quiet before loading context", () => {
  const cwd = process.cwd();
  for (const input of [
    { hook_event_name: "SessionStart", cwd, prompt: "Background scheduler" },
    { hook_event_name: "UserPromptSubmit", cwd },
    { hook_event_name: "UserPromptSubmit", cwd: path.dirname(cwd), prompt: "Background scheduler" },
  ]) {
    const output = execFileSync(
      process.execPath,
      [
        path.join(cwd, "bench/harness/knowledge/task-start-probe.mjs"),
        "missing-context-module.mjs",
        cwd,
        "must-not-create-receipt.jsonl",
        "must-not-deliver-marker",
      ],
      { input: JSON.stringify(input), encoding: "utf8" },
    );
    expect(output).toBe("");
  }
});

it("never promotes a proposal and keeps the accepted body distinct from a pending replacement", () => {
  const result = select({
    decisions: {
      draft: decision({ approval: "proposed", score: 9 }),
      operative: decision({
        pendingProposal: { approval: "proposed", body: "Remove the scheduler." },
      }),
    },
  });
  expect(result.selected.map((d: { id: string }) => d.id)).toEqual(["operative"]);
  expect(result.omitted).toEqual([{ id: "draft", score: 9, reason: "not accepted" }]);
  const payload = JSON.parse(result.context.split("\n")[1]);
  expect(payload.body).toBe(decision().body);
  expect(payload.pendingProposal.approval).toBe("proposed");
});

it("omits an oversized whole constraint without spending dedupe state or starving smaller records", () => {
  const seen = new Set();
  const result = select(
    { decisions: { large: decision({ body: "é".repeat(6000), score: 10 }), small: decision() } },
    { seen, maxBytes: 1000 },
  );
  expect(result.selected.map((d: { id: string }) => d.id)).toEqual(["small"]);
  expect(result.bytes).toBeLessThanOrEqual(1000);
  expect(result.context).toContain(decision().body);
  expect(result.omitted[0].reason).toBe("byte limit; whole record omitted");
  expect(seen.size).toBe(1);
});

it("dedupes equivalent content while allowing changed evidence, accepted revisions and proposal notices", () => {
  const seen = new Set();
  const fire = (value: ReturnType<typeof decision>) =>
    select({ decisions: { lesson: value } }, { seen });
  expect(fire(decision()).selected).toHaveLength(1);
  expect(fire(decision({ score: 99 })).context).toBeNull();
  expect(fire(decision({ trust: { freshness: "changed" } })).selected).toHaveLength(1);
  expect(
    fire(decision({ revision: 2, body: "Use a validated alternative." })).selected,
  ).toHaveLength(1);
  expect(
    fire(decision({ pendingProposal: { approval: "proposed", body: "New draft." } })).selected,
  ).toHaveLength(1);
});

it("bounds count and payload bytes, keeps diagnostics, and does not infer safety from empty matches", () => {
  const result = select({
    decisions: Object.fromEntries(["d", "c", "b", "a"].map((id) => [id, decision()])),
    diagnostics: [{ message: "Invalid record omitted" }],
  });
  expect(result.selected.map((d: { id: string }) => d.id)).toEqual(["a", "b", "c"]);
  expect(result.omitted[0]).toEqual({ id: "d", score: 5, reason: "decision limit" });
  expect(result.bytes).toBe(Buffer.byteLength(result.context));
  expect(result.diagnostics).toHaveLength(1);
  expect(select({ decisions: {} }).context).toBeNull();
});
