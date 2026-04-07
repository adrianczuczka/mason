import type { AnalyzerContext, AnalyzerResult } from "../types.js";
import type { BaseAnalyzer } from "./base.js";
import { GitHistoryAnalyzer } from "./git-history.js";

const analyzers: BaseAnalyzer[] = [new GitHistoryAnalyzer()];

export async function runAll(
  context: AnalyzerContext
): Promise<AnalyzerResult[]> {
  return Promise.all(analyzers.map((a) => a.analyze(context)));
}
