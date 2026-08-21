import type { FileChange } from "../../drift/drift.js";
import type { AuditAdvisory, AuditIssue, CheckName } from "../types.js";
import type { AuditDoc } from "../docs.js";
import { checkDeletedReferences } from "./deleted-reference.js";
import { checkNewModules } from "./new-module.js";
import { checkStaleCounts } from "./stale-count.js";
import { checkDeadCommands } from "./dead-command.js";
import { checkDepsChanged } from "./deps-changed.js";
import { checkDecisionAnchors } from "./decision-anchor.js";

export interface CheckContext {
  root: string;
  docs: AuditDoc[];
  headHash: string;
  /** Doc path → changes since the doc's last commit; null when uncomputable. */
  changesSinceDoc: Map<string, FileChange[] | null>;
  /** Whether .mason/decisions/ exists. */
  decisionsPresent: boolean;
}

export interface CheckResult {
  issues: AuditIssue[];
  advisories: AuditAdvisory[];
  skipped: Array<{ check: string; reason: string }>;
}

export type CheckFn = (ctx: CheckContext) => Promise<CheckResult>;

export const CHECKS: Record<CheckName, CheckFn> = {
  "deleted-reference": checkDeletedReferences,
  "new-module": checkNewModules,
  "stale-count": checkStaleCounts,
  "dead-command": checkDeadCommands,
  "deps-changed": checkDepsChanged,
  "decision-anchor-drift": checkDecisionAnchors,
};

export function emptyResult(): CheckResult {
  return { issues: [], advisories: [], skipped: [] };
}
