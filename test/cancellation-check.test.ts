import { expect, it } from "vitest";
import {
  checkOperation,
  referenceOperation,
} from "../bench/harness/knowledge/cancellation-check.mjs";

it("rejects once-only cleanup after successful and failed work", async () => {
  const result = await checkOperation(referenceOperation("once-only"));
  expect(result.pass).toBe(false);
  expect(result.failures).toContain("normal-11: listener retained");
  expect(result.failures).toContain("error: listener retained");
  expect(result.observations.find((o: { case: string }) => o.case === "normal-11").listeners).toBe(
    12,
  );
});

it.each(["finally-cleanup", "managed-dispose"])(
  "accepts %s while preserving results, errors and cancellation",
  async (mode) => {
    const result = await checkOperation(referenceOperation(mode));
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  },
);

it("rejects a superficially leak-free implementation that ignores cancellation", async () => {
  const result = await checkOperation((_signal: AbortSignal, work: () => unknown) =>
    Promise.resolve().then(work),
  );
  expect(result.pass).toBe(false);
  expect(result.failures).toContain("abort: cancellation swallowed");
  expect(result.failures).toContain("work started despite prior abort");
});

it("reports a nonsettling operation as a checker failure", async () => {
  const result = await checkOperation(() => new Promise(() => {}), { timeoutMs: 20 });
  expect(result.pass).toBe(false);
  expect(result.failures).toEqual(["checker execution failed: Checker operation did not settle"]);
});
