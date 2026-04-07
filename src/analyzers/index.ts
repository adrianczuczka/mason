import type { AnalyzerContext, AnalyzerResult } from "../types.js";
import type { BaseAnalyzer } from "./base.js";
import { GitHistoryAnalyzer } from "./git-history.js";
import { ImportConventionsAnalyzer } from "./import-conventions.js";
import { TestConventionsAnalyzer } from "./test-conventions.js";
import { PatternDetectionAnalyzer } from "./pattern-detection.js";
import { DependencyGraphAnalyzer } from "./dependency-graph.js";

const analyzers: BaseAnalyzer[] = [
  new GitHistoryAnalyzer(),
  new ImportConventionsAnalyzer(),
  new TestConventionsAnalyzer(),
  new PatternDetectionAnalyzer(),
  new DependencyGraphAnalyzer(),
];

export async function runAll(
  context: AnalyzerContext
): Promise<AnalyzerResult[]> {
  return Promise.all(analyzers.map((a) => a.analyze(context)));
}
