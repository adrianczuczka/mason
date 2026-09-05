export type CheckOutcome = "passed" | "failed" | "skipped" | "unavailable";
export interface EvidenceLocation { file: string; line?: number; column?: number }
export interface RawFinding {
  id: string;
  message: string;
  severity: "error" | "warning" | "note";
  state: "active" | "suppressed" | "absent" | "informational";
  locations: EvidenceLocation[];
  ruleId?: string;
  truncated?: boolean;
}
export interface ParsedEvidence {
  outcome: CheckOutcome;
  findings: RawFinding[];
  counts: Record<string, number>;
  incomplete: boolean;
  diagnostics: string[];
  reportedCommits?: string[];
  reportedCommands?: string[];
  reportedTools?: string[];
  executed?: boolean;
}
export const MAX_FINDINGS = 200;
export function messagePreview(message: string) {
  return { message: message.slice(0, 4000), ...(message.length > 4000 ? { truncated: true } : {}) };
}
