import { getWorkingTree } from "../drift/drift.js";
import { execGit } from "../utils/git-read.js";

/** A branch's own upstream is usually its remote copy, so attribute against the default branch. */
const TARGETS = [
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
];

export interface BranchAttribution {
  /** Short name of the default branch this checkout builds on, e.g. origin/main. */
  target: string;
  mergeBase: string;
  /** Files this branch changed since the merge-base, including uncommitted work. */
  branchFiles: Set<string>;
}

/**
 * Which changes belong to this branch rather than the default branch it builds on. Returns null
 * on the default branch itself, behind it, or without a resolvable target, so drift there is
 * reported as before. Deterministic and local: refs are not fetched.
 */
export async function branchAttribution(root: string): Promise<BranchAttribution | null> {
  const git = async (...args: string[]) =>
    (await execGit(args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  let target: string | null = null;
  for (const ref of TARGETS) {
    try {
      await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
      target =
        ref === "refs/remotes/origin/HEAD"
          ? await git("symbolic-ref", "--short", ref)
          : ref.replace(/^refs\/(remotes|heads)\//, "");
      break;
    } catch {
      /* Try the next conventional default branch. */
    }
  }
  if (!target) return null;
  const current = await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
  if (current && (target === current || target.endsWith("/" + current))) return null;
  let mergeBase: string, head: string;
  try {
    [mergeBase, head] = await Promise.all([
      git("merge-base", "HEAD", target),
      git("rev-parse", "HEAD"),
    ]);
  } catch {
    return null;
  }
  if (!mergeBase || mergeBase === head) return null;
  const [committed, workingTree] = await Promise.all([
    git("diff", "--name-only", "--no-renames", "-z", mergeBase, "HEAD"),
    getWorkingTree(root),
  ]);
  if (!workingTree.available) return null;
  return {
    target,
    mergeBase,
    branchFiles: new Set([...committed.split("\0").filter(Boolean), ...workingTree.changedFiles]),
  };
}
