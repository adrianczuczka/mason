import path from "node:path";
import { deletingCommitOf, lastCommitOf } from "../git.js";
import { optionalMasonPath, pathClaimScope, pathExists } from "../scope.js";
import type { Evidence } from "../types.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

/** Prove removed references only when their scope is resolved. */
export async function checkDeletedReferences(ctx: CheckContext): Promise<CheckResult> {
  const result = emptyResult();
  for (const doc of ctx.docs) {
    const changes = ctx.changesSinceDoc.get(doc.path);
    const renames = new Map((changes ?? []).filter(c => c.status === "renamed" && c.previousPath)
      .map(c => [c.previousPath!, c.path]));
    for (const claim of doc.claims.paths) {
      const scope = pathClaimScope(doc.path, claim);
      if (!scope) {
        result.skipped.push({ check: "deleted-reference", doc: doc.path,
          reason: `Reference ${claim.excerpt} is outside the repository or has an unsupported path.` });
        continue;
      }
      if (scope.candidates.some(optionalMasonPath)) continue;
      if ((await Promise.all(scope.candidates.map(file => pathExists(ctx.root, file)))).some(Boolean)) continue;

      const candidates = await Promise.all(scope.candidates.map(async file => ({ file,
        tracked: await lastCommitOf(ctx.root, file), parent: await pathExists(ctx.root, path.posix.dirname(file)) })));
      const candidate = candidates.find(c => c.tracked || renames.has(c.file)) ?? candidates.find(c => c.parent);
      // No history/parent for a bare path is usually an illustrative example.
      if (!candidate && claim.relativeTo !== "document") continue;
      const resolvedPath = candidate?.file ?? scope.candidates[0];
      const renamedTo = renames.get(resolvedPath) ?? null;
      const deletedInCommit = candidate?.tracked && !renamedTo ? await deletingCommitOf(ctx.root, resolvedPath) : null;
      const evidence: Evidence = { kind: "missing-path", claimed: claim.path, resolvedPath, scope,
        renamedTo, deletedInCommit, everTracked: !!candidate?.tracked || !!renamedTo, parentDirExists: candidate?.parent ?? false };
      const anchor = { doc: doc.path, line: claim.line, excerpt: claim.excerpt };
      const message = renamedTo ? `\`${resolvedPath}\` was renamed to \`${renamedTo}\``
        : `\`${resolvedPath}\` does not exist` + (deletedInCommit
          ? ` – deleted in ${deletedInCommit.hash.slice(0, 7)} "${deletedInCommit.subject}" (${deletedInCommit.date.slice(0, 10)})` : "");
      if (scope.basis !== "document" && (renamedTo || candidate?.tracked)) {
        result.issues.push({ type: "deleted-reference", message, anchor, confidence: "certain", evidence });
      } else {
        result.advisories.push({ resolution: "recheck", type: "deleted-reference", message: message + (scope.basis === "document"
          ? "; the bare path's document/repository scope needs review."
          : "; no tracked history establishes it as a required file. Review for a typo, generated output, or example."), anchor, evidence });
      }
    }
  }
  return result;
}
