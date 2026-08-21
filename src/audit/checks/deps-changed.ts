import { commitsTouchingSince } from "../git.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

const MANIFEST_COMMITS_CAP = 10;

/**
 * Tracked manifest files at any depth. Lockfiles are pure churn and are
 * deliberately not matched.
 */
const MANIFEST_PATHSPECS = [
  ":(glob)**/package.json",
  ":(glob)**/build.gradle.kts",
  ":(glob)**/build.gradle",
  "settings.gradle.kts",
  "settings.gradle",
  "gradle/libs.versions.toml",
  ":(glob)**/Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "composer.json",
];

/**
 * Advisory, never an issue: a manifest commit after the doc's last commit
 * proves recency ordering, not that any specific claim is false — and it can
 * never be closed by editing the doc within the same run.
 */
export async function checkDepsChanged(
  ctx: CheckContext
): Promise<CheckResult> {
  const result = emptyResult();

  for (const doc of ctx.docs) {
    if (!doc.lastCommit) {
      result.skipped.push({
        check: "deps-changed",
        reason: `${doc.path} has no commit history`,
      });
      continue;
    }
    if (doc.dirty) {
      result.skipped.push({
        check: "deps-changed",
        reason: `${doc.path} has uncommitted edits – suppressed while in flight`,
      });
      continue;
    }

    const range = await commitsTouchingSince(
      ctx.root,
      doc.lastCommit.hash,
      MANIFEST_PATHSPECS
    );
    if (range === null) {
      result.skipped.push({
        check: "deps-changed",
        reason: `${doc.path}: commit range unreachable (shallow clone?)`,
      });
      continue;
    }
    if (range.total === 0) continue;

    const latest = range.commits[0];
    result.advisories.push({
      type: "deps-changed",
      message: `dependency manifests touched by ${range.total} commit${range.total === 1 ? "" : "s"} since ${doc.path} was last committed (latest: ${latest.hash.slice(0, 7)} "${latest.subject}")`,
      anchor: { doc: doc.path, line: null, excerpt: null },
      evidence: {
        kind: "doc-behind-manifests",
        docLastCommit: doc.lastCommit,
        manifestCommits: range.commits.slice(0, MANIFEST_COMMITS_CAP),
        totalCommits: range.total,
      },
    });
  }

  return result;
}
