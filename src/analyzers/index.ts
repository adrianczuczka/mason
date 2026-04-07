import type { AnalyzerContext, AnalyzerResult } from "../types.js";
import type { BaseAnalyzer } from "./base.js";
import { GitHistoryAnalyzer } from "./git-history.js";
import { ImportConventionsAnalyzer } from "./import-conventions.js";
import { TestConventionsAnalyzer } from "./test-conventions.js";

const analyzers: BaseAnalyzer[] = [
  new GitHistoryAnalyzer(),
  new ImportConventionsAnalyzer(),
  new TestConventionsAnalyzer(),
];

export async function runAll(
  context: AnalyzerContext
): Promise<AnalyzerResult[]> {
  return Promise.all(analyzers.map((a) => a.analyze(context)));
}
