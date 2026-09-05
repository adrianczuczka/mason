import type { decisionProvenance } from "../decisions/provenance.js";

export type IssueType =
  | "deleted-reference"
  | "new-module"
  | "stale-count"
  | "dead-command";

export type AdvisoryType = "deps-changed" | "decision-anchor-drift";

export type CheckName = IssueType | AdvisoryType;

export const ALL_CHECKS: CheckName[] = [
  "deleted-reference",
  "new-module",
  "stale-count",
  "dead-command",
  "deps-changed",
  "decision-anchor-drift",
];

/**
 * "certain" — the claim is provably false (a tracked path is gone, a computed
 * count differs, a script exists in no manifest). "likely" — evidence-backed
 * but heuristic (an unmentioned directory; a never-tracked path whose parent
 * exists). Certain-class issues are safe to auto-fix; likely-class issues
 * deserve a look.
 */
export type Confidence = "certain" | "likely";

export interface CommitRef {
  hash: string;
  date: string;
  subject: string;
}

export interface DocAnchor {
  /** Repo-relative doc path, e.g. "CLAUDE.md" or ".claude/CLAUDE.md". */
  doc: string;
  /** 1-based line of the claim; null for doc-level issues (new-module). */
  line: number | null;
  /** The claim exactly as written, e.g. "src/utils/logger.ts". */
  excerpt: string | null;
}

export type Evidence =
  | {
      kind: "missing-path";
      claimed: string;
      renamedTo: string | null;
      deletedInCommit: CommitRef | null;
      everTracked: boolean;
      parentDirExists: boolean;
    }
  | {
      kind: "unmentioned-dir";
      dir: string;
      sourceFileCount: number;
      firstCommit: CommitRef | null;
      checkedDocs: string[];
    }
  | {
      kind: "count-mismatch";
      claimed: number;
      actual: number;
      unit: string;
      /** Where the actual count came from, e.g. "package.json workspaces". */
      countedFrom: string;
      members: string[];
    }
  | {
      kind: "missing-script";
      scriptName: string;
      invocation: string;
      manifestsChecked: string[];
      availableScripts: string[];
    }
  | {
      kind: "doc-behind-manifests";
      docLastCommit: CommitRef;
      manifestCommits: Array<CommitRef & { files: string[] }>;
      totalCommits: number;
    }
  | {
      kind: "decision-anchor";
      provenance?: ReturnType<typeof decisionProvenance>;
      decisionId: string;
      title: string;
      changedFiles: string[];
      refreshedHash: string;
    };

export interface AuditIssue {
  type: IssueType;
  message: string;
  anchor: DocAnchor;
  confidence: Confidence;
  evidence: Evidence;
}

/**
 * Advisories are facts the fixing agent cannot close by editing the doc (a
 * manifest commit after the doc's commit stays true forever; decision records
 * must be re-verified by humans). They NEVER affect the exit code — same
 * precedent as decision staleness in mason-drift.
 */
export interface AuditAdvisory {
  type: AdvisoryType;
  message: string;
  anchor: DocAnchor;
  evidence: Evidence;
}

export interface AuditDocInfo {
  path: string;
  lastCommit: CommitRef | null;
  /** Uncommitted edits present — deps-changed is suppressed for dirty docs. */
  dirty: boolean;
  lineCount: number;
}

export interface AuditReport {
  /** Additive-only schema — this output is a CI contract. */
  version: 1;
  root: string;
  gitAvailable: boolean;
  /** Commit and exact check scope used by this run. */
  headHash?: string;
  checksRun?: CheckName[];
  docs: AuditDocInfo[];
  /** Whether .mason/decisions/ existed and was checked. */
  decisionsChecked: boolean;
  /** Drive exit code 1. */
  issues: AuditIssue[];
  /** Never drive the exit code. */
  advisories: AuditAdvisory[];
  /** Original committed evidence retained while local doc edits suppress reporting. */
  suppressedAdvisories?: AuditAdvisory[];
  skippedChecks: Array<{ check: string; reason: string; doc?: string }>;
  clean: boolean;
}

export interface PathClaim {
  path: string;
  line: number;
  excerpt: string;
}

export interface CountClaim {
  count: number;
  unit: string;
  line: number;
  excerpt: string;
}

export interface CommandClaim {
  scriptName: string;
  invocation: string;
  line: number;
  excerpt: string;
}

export interface DocClaims {
  paths: PathClaim[];
  counts: CountClaim[];
  commands: CommandClaim[];
}
