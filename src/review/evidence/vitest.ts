import { z } from "zod";
import { evidencePath } from "./paths.js";
import { messagePreview, type ParsedEvidence, type RawFinding } from "./types.js";

const count = z.number().int().nonnegative();
const schema = z.object({
  success: z.boolean(), numTotalTests: count, numPassedTests: count, numFailedTests: count,
  numPendingTests: count, numTodoTests: count, numFailedTestSuites: count,
  testResults: z.array(z.object({
    name: z.string().min(1), status: z.enum(["passed", "failed"]), message: z.string().optional(),
    assertionResults: z.array(z.object({
      fullName: z.string(), status: z.enum(["passed", "failed", "pending", "skipped", "todo", "disabled"]),
      failureMessages: z.array(z.string()).nullable().optional(),
      location: z.object({ line: count, column: count }).nullable().optional(),
    })),
  })),
});

/** Vitest JSON reporter output; summary and assertion counts must agree. */
export function parseVitest(raw: unknown, sourceRoot: string): ParsedEvidence {
  const report = schema.parse(raw);
  const findings: RawFinding[] = [], diagnostics: string[] = [];
  let passed = 0, failed = 0, skipped = 0;
  for (const [index, suite] of report.testResults.entries()) {
    const file = evidencePath(suite.name, sourceRoot);
    if (!file) diagnostics.push(`Test path is outside the declared checkout or invalid: ${suite.name}`);
    let suiteFailures = 0;
    for (const [testIndex, test] of suite.assertionResults.entries()) {
      if (test.status === "passed") passed++;
      else if (test.status === "failed") {
        failed++; suiteFailures++;
        findings.push({ id: `${index}:${testIndex}`, ...messagePreview([test.fullName, ...(test.failureMessages ?? [])].join("\n")),
          severity: "error", state: "active", locations: file ? [{ file, ...(test.location ? { line: test.location.line, column: test.location.column } : {}) }] : [] });
      } else skipped++;
    }
    if (suite.status === "failed" && !suiteFailures) {
      findings.push({ id: `${index}:suite`, ...messagePreview(suite.message || `Test suite failed: ${suite.name}`), severity: "error", state: "active", locations: file ? [{ file }] : [] });
    }
  }
  if (passed !== report.numPassedTests || failed !== report.numFailedTests || skipped !== report.numPendingTests + report.numTodoTests || passed + failed + skipped !== report.numTotalTests) {
    throw new Error("Vitest summary counts disagree with its assertion results");
  }
  const hasFailures = failed > 0 || report.numFailedTestSuites > 0 || report.testResults.some(s => s.status === "failed");
  if (report.success && hasFailures) throw new Error("Vitest success conflicts with failed tests or suites");
  const outcome = hasFailures || !report.success ? "failed" : !report.numTotalTests ? "unavailable" : !passed ? "skipped" : "passed";
  if (!report.numTotalTests) diagnostics.push("No tests executed; an empty report is not passing test evidence.");
  if (skipped) diagnostics.push(`${skipped} tests were skipped, pending, disabled, or todo.`);
  return { outcome, findings, counts: { total: report.numTotalTests, passed, failed, skipped, failedSuites: report.numFailedTestSuites },
    incomplete: skipped > 0 || diagnostics.length > 0, diagnostics };
}
