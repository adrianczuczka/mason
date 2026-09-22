import { matchDependencyChanges } from "../dependency-claims.js";
import { documentScope } from "../docs.js";
import { releaseMetadataOnly } from "../release-metadata.js";
import { commitsTouchingSince } from "../git.js";
import { inspectionGit } from "../inspection.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

const MANIFEST_COMMITS_CAP = 10;

/** A relevance filter, not semantic validation of a dependency or its version. */
export function hasDependencyContent(content: string): boolean {
  const text = content.replace(/<!-- mason:start -->[\s\S]*?<!-- mason:end -->/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return /\b(?:dependenc(?:y|ies)|librar(?:y|ies)|frameworks?|tech(?:nology)? stack|prerequisites|requirements)\b/i.test(text)
    || /\b(?:package\.json|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|libs\.versions\.toml|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|Gemfile|composer\.json)\b/i.test(text)
    || /\b(?:node(?:\.js)?|npm|pnpm|yarn|bun|deno|python|ruby|rust|go|java|jdk|kotlin|gradle|swift|php|react|vue|angular|compose|ktor|room)\s*(?:version\s*)?[`*:=>~^v\s-]*\d+(?:\.\d+)*\b/i.test(text)
    || /\b(?:npm|pnpm|yarn|pip3?|cargo|gem|composer)\s+(?:install|add|require)\b/i.test(text);
}

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

/** Share exact dependency scope with persisted advisory assessments. */
export function manifestPathspecs(doc: string): string[] {
  const scope = documentScope(doc);
  if (scope === ".") return MANIFEST_PATHSPECS;
  const escaped = scope.replace(/[\\*?\[\]]/g, "\\$&");
  return MANIFEST_PATHSPECS.map(spec => spec.startsWith(":(glob)")
    ? ":(glob)" + escaped + "/" + spec.slice(":(glob)".length) : ":(literal)" + scope + "/" + spec);
}

/**
 * A matched declaration change is advisory, never proof of an incorrect claim.
 * Manifest recency without an affected passage is background information.
 */
export async function checkDepsChanged(
  ctx: CheckContext
): Promise<CheckResult> {
  const result = emptyResult();
  result.suppressedAdvisories = [];
  const releaseOnly = new Map<string, boolean>();

  for (const doc of ctx.docs) {
    if (!doc.lastCommit) {
      result.skipped.push({
        check: "deps-changed",
        doc: doc.path,
        reason: `${doc.path} has no commit history`,
      });
      continue;
    }

    // Local edits must not erase the dependency evidence we are preparing to
    // retain. Inspect the committed document for dirty inputs, including setup.
    let content = doc.content;
    if (doc.dirty) {
      try {
        content = (await inspectionGit(["show", `${doc.lastCommit.hash}:${doc.path}`],
          { cwd: ctx.root, maxBuffer: 10 * 1024 * 1024, timeout: 10000 })).stdout;
      } catch {
        result.skipped.push({ check: "deps-changed", doc: doc.path, reason: `${doc.path}: committed dependency content is unavailable` });
        continue;
      }
    }

    const range = await commitsTouchingSince(
      ctx.root,
      doc.lastCommit.hash,
      manifestPathspecs(doc.path)
    );
    if (range === null) {
      result.skipped.push({
        check: "deps-changed",
        doc: doc.path,
        reason: `${doc.path}: commit range unreachable (shallow clone?)`,
      });
      continue;
    }
    // Bound extra history reads. Older/ambiguous commits remain advisory.
    const relevant = [];
    for (const commit of range.commits) {
      if (!releaseOnly.has(commit.hash) && releaseOnly.size < 100) {
        releaseOnly.set(commit.hash, await releaseMetadataOnly(ctx.root, commit));
      }
      if (!releaseOnly.get(commit.hash)) relevant.push(commit);
    }
    range.commits = relevant;
    range.total = relevant.length;
    if (range.total === 0) continue;

    const relevance = await matchDependencyChanges(ctx.root, doc.lastCommit.hash, ctx.headHash,
      [...new Set(range.commits.flatMap(commit => commit.files))], content);
    // Documents without any dependency guidance or matched declaration stay quiet.
    if (!relevance.matches.length && !hasDependencyContent(content)) continue;
    const match = relevance.matches[0];
    if (doc.dirty && match) result.skipped.push({ check: "deps-changed", doc: doc.path,
      reason: `${doc.path} has uncommitted edits – suppressed while in flight` });
    (doc.dirty ? result.suppressedAdvisories : result.advisories).push({
      type: "deps-changed",
      ...(match ? {} : { resolution: "informational" as const }),
      message: match
        ? `${match.dependency} changed from ${match.before ?? "absent"} to ${match.after ?? "removed"} in ${match.manifest}; review ${doc.path}:${match.line}: ${match.excerpt}${relevance.matches.length > 1 ? ` (${relevance.matches.length - 1} more matches in evidence)` : ""}`
        : `Dependency manifests changed after the document baseline ${doc.lastCommit.hash.slice(0, 7)} (${doc.lastCommit.date.slice(0, 10)}); no specific affected passage was established. Informational only.${relevance.incomplete ? " Some manifest declarations could not be matched." : ""}`,
      anchor: { doc: doc.path, line: match?.line ?? null, excerpt: match?.excerpt ?? null },
      evidence: {
        kind: "doc-behind-manifests",
        docLastCommit: doc.lastCommit,
        manifestCommits: range.commits.slice(0, MANIFEST_COMMITS_CAP),
        totalCommits: range.total,
        matches: relevance.matches,
        matchingIncomplete: relevance.incomplete,
      },
    });
  }

  return result;
}
