import { inspectionRead } from "../inspection.js";
import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, SOURCE_IGNORE } from "../../utils/files.js";
import { auditGlob, auditInputPath, gitIgnoredPaths, gitSourcePaths } from "../inputs.js";
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

export async function checkNewModules(ctx: CheckContext): Promise<CheckResult> {
  const result = emptyResult();
  if (ctx.docs.length === 0) return result;

  const combinedDocs = moduleDocumentation(ctx.docs);
  const primaryDoc = ctx.docs[0].path;
  const checkedDocs = ctx.docs.map((d) => d.path);

  const flag = async (dir: string, sourceFileCount: number): Promise<void> => {
    result.advisories.push({
      resolution: "recheck",
      type: "new-module",
      message: `directory \`${dir}/\` contains ${sourceFileCount} source file${sourceFileCount === 1 ? "" : "s"} but is not mentioned in the discovered documentation; review whether it needs documenting`,
      anchor: { doc: primaryDoc, line: null, excerpt: dir },
      evidence: {
        kind: "unmentioned-dir",
        dir,
        sourceFileCount,
        firstCommit: await firstCommitOf(ctx.root, dir),
        checkedDocs,
      },
    });
  };

  for (const candidate of await moduleCandidates(ctx.root, combinedDocs)) {
    await flag(candidate.dir, candidate.sourceFileCount);
  }

  return result;
}

/** Nested documentation establishes a directory is documented without requiring
 * every package README to repeat its full repository path. */
export function moduleDocumentation(docs: Array<{ path: string; content: string }>): string {
  return docs.map(doc => doc.content + "\n" + (path.posix.dirname(doc.path) === "." ? "" : path.posix.dirname(doc.path) + "/")).join("\n");
}

/** Shared dependency witness: cache exactly the module candidates the audit observes. */
export function moduleCandidates(root: string, combinedDocs: string) {
  return inspectionRead(root, "modules:" + combinedDocs, () => collectModuleCandidates(root, combinedDocs));
}

async function collectModuleCandidates(root: string, combinedDocs: string) {
  const [config, sourcePaths] = await Promise.all([loadProjectConfig(root), gitSourcePaths(root)]);
  const ignore = [...SOURCE_IGNORE, ...(config.ignore ?? [])];
  const sources = sourcePaths.filter(file => !file.split("/").some(part => part.startsWith(".")));
  const listSubdirs = async (parents: string[]): Promise<Map<string, string[]>> => {
    const byParent = new Map<string, string[]>();
    // Gather one level before asking Git about ignores, with bounded directory reads.
    for (let offset = 0; offset < parents.length; offset += 16) {
      await Promise.all(parents.slice(offset, offset + 16).map(async dir => {
        const entries = await fs.readdir(await auditInputPath(root, dir), { withFileTypes: true });
        // An unrelated directory alias is not a source module. Selected links
        // still pass through auditGlob's path and parent validation.
        const dirs = entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()
          && sources.some(file => file.startsWith(path.posix.join(dir, entry.name) + "/")))
          && !entry.name.startsWith(".") && !DIR_DENYLIST.has(entry.name))
          .map(entry => path.posix.join(dir, entry.name));
        byParent.set(dir, dirs);
      }));
    }
    const ignored = await gitIgnoredPaths(root, [...byParent.values()].flat());
    const result = new Map<string, string[]>();
    for (const dir of parents) {
      // An ignore rule does not remove already tracked source from the audit.
      const visible = new Set(byParent.get(dir)!.filter(candidate => !ignored.has(candidate)
        || sources.some(file => file.startsWith(candidate + "/"))));
      result.set(dir, (await auditGlob(root, dir === "." ? "*" : `${fg.escapePath(dir)}/*`, {
        ignore, onlyDirectories: true, label: "Module directory discovery", select: file => visible.has(file),
      })).map(file => path.posix.basename(file)));
    }
    return result;
  };
  const countSourceFiles = async (dir: string): Promise<number> => {
    const files = sources.filter(file => file.startsWith(dir + "/"));
    let count = 0;
    // Literal path batches avoid compiling one enormous glob pattern set in a
    // genuinely large source module. Apply exclusions before counting results.
    for (let offset = 0; offset < files.length; offset += 256) {
      count += (await auditGlob(root, files.slice(offset, offset + 256).map(file => fg.escapePath(file)), {
        ignore, followSymbolicLinks: false, label: `Source discovery in ${dir}`,
      })).length;
      if (count > 100000) throw new Error(`Source discovery in ${dir} exceeds 100,000 relevant files. Exclude generated source with .mason/config.json ignore patterns or narrow this audit's checks.`);
    }
    return count;
  };
  const candidates: Array<{ dir: string; sourceFileCount: number }> = [];
  const topDirs = (await listSubdirs(["."])).get(".")!;
  const nested = await listSubdirs(topDirs.filter(dir => isMentioned(combinedDocs, dir)));
  for (const topDir of topDirs) {
    const topMentioned = isMentioned(combinedDocs, topDir);

    if (!topMentioned) {
      const count = await countSourceFiles(topDir);
      if (count >= 1) candidates.push({ dir: topDir, sourceFileCount: count });
      continue;
    }

    // The docs know this dir. If they enumerate its children (several
    // subdirs already mentioned), an unmentioned sibling is drift — this is
    // how a freshly added module under src/ gets caught.
    const subdirs = nested.get(topDir)!;
    const mentioned = subdirs.filter((s) => isMentioned(combinedDocs, s));
    if (mentioned.length < ENUMERATION_THRESHOLD) continue;

    for (const sub of subdirs) {
      if (isMentioned(combinedDocs, sub)) continue;
      const count = await countSourceFiles(`${topDir}/${sub}`);
      if (count >= SECOND_LEVEL_MIN_SOURCE_FILES) {
        candidates.push({ dir: `${topDir}/${sub}`, sourceFileCount: count });
      }
    }
  }

  return candidates;
}
