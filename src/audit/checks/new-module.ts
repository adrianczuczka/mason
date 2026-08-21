import fg from "fast-glob";
import path from "node:path";
import { SOURCE_GLOB, SOURCE_IGNORE } from "../../snapshot/snapshot.js";
import { firstCommitOf } from "../git.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

/** Directories that are never "modules" worth documenting. */
const DIR_DENYLIST = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  "venv",
  ".venv",
  ".git",
  ".gradle",
  ".mason",
  ".claude",
  ".github",
  ".vscode",
  ".idea",
]);

/** Second-level dirs need a bit more substance before they count. */
const SECOND_LEVEL_MIN_SOURCE_FILES = 2;
/**
 * Descend into a top-level dir only when the docs evidently enumerate its
 * children — at least this many of its subdirs already mentioned.
 */
const ENUMERATION_THRESHOLD = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary mention check across the union of all docs — `app` must not
 * match "application", and a dir mentioned only in AGENTS.md must not be
 * flagged against CLAUDE.md.
 */
function isMentioned(combinedDocs: string, name: string): boolean {
  const re = new RegExp(
    `(^|[^A-Za-z0-9_-])${escapeRegExp(name)}(/|[^A-Za-z0-9_-]|$)`,
    "im"
  );
  return re.test(combinedDocs);
}

async function listSubdirs(absDir: string): Promise<string[]> {
  const dirs = await fg("*", {
    cwd: absDir,
    onlyDirectories: true,
    suppressErrors: true,
  });
  return dirs.filter((d) => !DIR_DENYLIST.has(d)).sort();
}

async function countSourceFiles(absDir: string): Promise<number> {
  const files = await fg(SOURCE_GLOB, {
    cwd: absDir,
    ignore: SOURCE_IGNORE,
    suppressErrors: true,
  });
  return files.length;
}

export async function checkNewModules(ctx: CheckContext): Promise<CheckResult> {
  const result = emptyResult();
  if (ctx.docs.length === 0) return result;

  const combinedDocs = ctx.docs.map((d) => d.content).join("\n");
  const primaryDoc = ctx.docs[0].path;
  const checkedDocs = ctx.docs.map((d) => d.path);

  const flag = async (dir: string, sourceFileCount: number): Promise<void> => {
    result.issues.push({
      type: "new-module",
      message: `directory \`${dir}/\` contains ${sourceFileCount} source file${sourceFileCount === 1 ? "" : "s"} but is not mentioned in any context file`,
      anchor: { doc: primaryDoc, line: null, excerpt: dir },
      confidence: "likely",
      evidence: {
        kind: "unmentioned-dir",
        dir,
        sourceFileCount,
        firstCommit: await firstCommitOf(ctx.root, dir),
        checkedDocs,
      },
    });
  };

  for (const topDir of await listSubdirs(ctx.root)) {
    const absTop = path.join(ctx.root, topDir);
    const topMentioned = isMentioned(combinedDocs, topDir);

    if (!topMentioned) {
      const count = await countSourceFiles(absTop);
      if (count >= 1) await flag(topDir, count);
      continue;
    }

    // The docs know this dir. If they enumerate its children (several
    // subdirs already mentioned), an unmentioned sibling is drift — this is
    // how a freshly added module under src/ gets caught.
    const subdirs = await listSubdirs(absTop);
    const mentioned = subdirs.filter((s) => isMentioned(combinedDocs, s));
    if (mentioned.length < ENUMERATION_THRESHOLD) continue;

    for (const sub of subdirs) {
      if (isMentioned(combinedDocs, sub)) continue;
      const count = await countSourceFiles(path.join(absTop, sub));
      if (count >= SECOND_LEVEL_MIN_SOURCE_FILES) {
        await flag(`${topDir}/${sub}`, count);
      }
    }
  }

  return result;
}
