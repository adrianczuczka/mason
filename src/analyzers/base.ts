import fs from "node:fs/promises";
import fg from "fast-glob";
import type {
  AnalyzerContext,
  AnalyzerResult,
  Finding,
  FindingCategory,
} from "../types.js";

export abstract class BaseAnalyzer {
  abstract name: string;
  abstract analyze(context: AnalyzerContext): Promise<AnalyzerResult>;

  protected async findFiles(
    patterns: string[],
    root: string
  ): Promise<string[]> {
    return fg(patterns, {
      cwd: root,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      absolute: true,
    });
  }

  protected async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf-8");
  }

  protected createFinding(partial: {
    category: FindingCategory;
    confidence: number;
    summary: string;
    evidence?: Finding["evidence"];
    ruleCandidate?: string | null;
  }): Finding {
    return {
      analyzer: this.name,
      category: partial.category,
      confidence: partial.confidence,
      summary: partial.summary,
      evidence: partial.evidence ?? [],
      ruleCandidate: partial.ruleCandidate ?? null,
    };
  }

  protected createResult(
    findings: Finding[],
    gaps: AnalyzerResult["gaps"],
    startTime: number
  ): AnalyzerResult {
    return {
      analyzer: this.name,
      findings,
      gaps,
      durationMs: Date.now() - startTime,
    };
  }
}
