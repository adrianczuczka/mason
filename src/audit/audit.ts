import fs from "node:fs/promises";
import path from "node:path";
import { getChangesWithStatus } from "../drift/drift.js";
import type { FileChange } from "../drift/drift.js";
import { getCurrentGitHash } from "../snapshot/snapshot.js";
import { discoverDocs } from "./docs.js";
import { ALL_CHECKS } from "./types.js";
import type { AuditReport, CheckName } from "./types.js";
import { CHECKS } from "./checks/index.js";
import type { CheckContext, CheckResult } from "./checks/index.js";

export interface AuditOptions {
  /** Subset of checks to run; defaults to all. */
  checks?: CheckName[];
  /** Internal execution boundary used by the automation dependency cache. */
  runCheck?: (name: CheckName, context: CheckContext) => Promise<CheckResult>;
}

/**
 * Audit the repo's context files (CLAUDE.md, .claude/CLAUDE.md, AGENTS.md)
 * against repo reality. Fully deterministic — git, filesystem, and lexical
 * extraction only; no LLM, no network. Returns null when no context file
 * exists.
 */
export async function computeAudit(
  rootDir: string,
  options: AuditOptions = {}
): Promise<AuditReport | null> {
  const resolvedRoot = path.resolve(rootDir);
  const docs = await discoverDocs(resolvedRoot);
  if (docs.length === 0) return null;

  const headHash = await getCurrentGitHash(resolvedRoot);
  const report: AuditReport = {
    version: 1,
    root: resolvedRoot,
    gitAvailable: headHash !== "unknown",
    headHash,
    checksRun: [],
    docs: docs.map((d) => ({
      path: d.path,
      lastCommit: d.lastCommit,
      dirty: d.dirty,
      lineCount: d.lineCount,
    })),
    decisionsChecked: false,
    issues: [],
    advisories: [],
    suppressedAdvisories: [],
    skippedChecks: [],
    clean: true,
  };

  // Without git the provability gates cannot run — the caller treats this
  // as an error rather than silently degrading precision.
  if (!report.gitAvailable) return report;

  const changesSinceDoc = new Map<string, FileChange[] | null>();
  for (const doc of docs) {
    changesSinceDoc.set(
      doc.path,
      doc.lastCommit
        ? await getChangesWithStatus(resolvedRoot, doc.lastCommit.hash)
        : null
    );
  }

  let decisionsPresent = false;
  try {
    await fs.access(path.join(resolvedRoot, ".mason", "decisions"));
    decisionsPresent = true;
  } catch {
    // No decision store — the check stays dark (zero-setup path).
  }
  report.decisionsChecked = decisionsPresent;

  const ctx: CheckContext = {
    root: resolvedRoot,
    docs,
    headHash,
    changesSinceDoc,
    decisionsPresent,
  };

  const selected = options.checks ?? ALL_CHECKS;
  for (const name of ALL_CHECKS) {
    if (!selected.includes(name)) continue;
    const { issues, advisories, suppressedAdvisories, skipped } = await (options.runCheck
      ? options.runCheck(name, ctx) : CHECKS[name](ctx));
    report.checksRun!.push(name);
    report.issues.push(...issues);
    report.advisories.push(...advisories);
    report.suppressedAdvisories!.push(...(suppressedAdvisories ?? []));
    report.skippedChecks.push(...skipped);
  }

  report.clean = report.issues.length === 0;
  return report;
}
