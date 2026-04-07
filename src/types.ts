export type FindingCategory = "convention" | "boundary" | "risk" | "pattern";

export interface Evidence {
  filePath: string;
  detail: string;
}

export interface Finding {
  analyzer: string;
  category: FindingCategory;
  confidence: number;
  summary: string;
  evidence: Evidence[];
  ruleCandidate: string | null;
}

export interface Gap {
  analyzer: string;
  question: string;
  context: string;
  answerKey: string;
}

export interface AnalyzerResult {
  analyzer: string;
  findings: Finding[];
  gaps: Gap[];
  durationMs: number;
}

export interface AnalyzerContext {
  rootDir: string;
  packageJson: Record<string, unknown> | null;
  gitAvailable: boolean;
  previousAnswers: Map<string, string>;
}

export interface Rule {
  section: string;
  text: string;
  source: string;
  priority: number;
}
