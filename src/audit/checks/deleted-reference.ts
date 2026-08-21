import fs from "node:fs/promises";
import path from "node:path";
import { deletingCommitOf, lastCommitOf } from "../git.js";
import type { AuditIssue } from "../types.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A claimed path that is missing on disk is only flagged when the repo can
 * prove it was ever real: a rename since the doc's last commit, or git
 * history for the path, or at least an existing parent directory. Paths with
 * none of those are illustrative examples and are dropped silently.
 */
export async function checkDeletedReferences(
  ctx: CheckContext
): Promise<CheckResult> {
  const result = emptyResult();

  for (const doc of ctx.docs) {
    const changes = ctx.changesSinceDoc.get(doc.path);
    const renames = new Map<string, string>();
    for (const change of changes ?? []) {
      if (change.status === "renamed" && change.previousPath) {
        renames.set(change.previousPath, change.path);
      }
    }

    for (const claim of doc.claims.paths) {
      // Mason's own metadata is optional state, not repo structure — docs
      // legitimately describe .mason/ files that a given repo doesn't have.
      if (claim.path === ".mason" || claim.path.startsWith(".mason/")) {
        continue;
      }
      if (await exists(path.join(ctx.root, claim.path))) continue;

      const anchor = { doc: doc.path, line: claim.line, excerpt: claim.excerpt };
      const renamedTo = renames.get(claim.path) ?? null;

      if (renamedTo) {
        result.issues.push({
          type: "deleted-reference",
          message: `\`${claim.path}\` was renamed to \`${renamedTo}\``,
          anchor,
          confidence: "certain",
          evidence: {
            kind: "missing-path",
            claimed: claim.path,
            renamedTo,
            deletedInCommit: null,
            everTracked: true,
            parentDirExists: true,
          },
        });
        continue;
      }

      const tracked = await lastCommitOf(ctx.root, claim.path);
      if (tracked) {
        const deleted = await deletingCommitOf(ctx.root, claim.path);
        const detail = deleted
          ? ` – deleted in ${deleted.hash.slice(0, 7)} "${deleted.subject}" (${deleted.date.slice(0, 10)})`
          : "";
        result.issues.push({
          type: "deleted-reference",
          message: `\`${claim.path}\` no longer exists${detail}`,
          anchor,
          confidence: "certain",
          evidence: {
            kind: "missing-path",
            claimed: claim.path,
            renamedTo: null,
            deletedInCommit: deleted,
            everTracked: true,
            parentDirExists: await exists(
              path.join(ctx.root, path.dirname(claim.path))
            ),
          },
        });
        continue;
      }

      const parentDirExists = await exists(
        path.join(ctx.root, path.dirname(claim.path))
      );
      if (!parentDirExists) continue;

      const issue: AuditIssue = {
        type: "deleted-reference",
        message: `\`${claim.path}\` does not exist (never tracked in git – possible typo or invented path)`,
        anchor,
        confidence: "likely",
        evidence: {
          kind: "missing-path",
          claimed: claim.path,
          renamedTo: null,
          deletedInCommit: null,
          everTracked: false,
          parentDirExists: true,
        },
      };
      result.issues.push(issue);
    }
  }

  return result;
}
