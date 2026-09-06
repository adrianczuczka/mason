import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RangeCommits } from "./git.js";

const exec = promisify(execFile);
async function git(root: string, args: string[]) {
  return (await exec("git", args, { cwd: root, timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout;
}

/** A deliberately narrow recognizer, not a Gradle evaluator. Unknown syntax stays advisory. */
function withoutAndroidReleaseValues(text: string): string | null {
  if (/\/\*|"""|'''/.test(text) || !/id\s*\(?\s*["']com\.android\.(application|library)["']/.test(text)) return null;
  const scopes: string[] = [];
  const normalized: string[] = [];
  let assignments = 0;
  for (const line of text.split("\n")) {
    // Remove ordinary quoted strings and line comments solely for brace tracking.
    const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*$/g, token => token.startsWith("//") ? "" : '""');
    const assignment = line.match(/^(\s*)(versionName|versionCode)(\s*(?:=\s*|\s+))("[A-Za-z0-9._+-]+"|'[A-Za-z0-9._+-]+'|\d+)(\s*)$/);
    if (assignment && scopes.join("/") === "android/defaultConfig" &&
      (assignment[2] === "versionCode" ? /^\d+$/.test(assignment[4]) : /^["']/.test(assignment[4]))) {
      normalized.push(assignment[1] + assignment[2] + assignment[3] + "<release-value>" + assignment[5]);
      assignments++;
    } else {
      // References can feed dependency coordinates or other executable configuration.
      if (/\bversion(?:Name|Code)\b/.test(line)) return null;
      normalized.push(line);
    }
    const named = code.match(/^\s*(android|defaultConfig)\s*\{\s*$/)?.[1];
    for (const brace of code.matchAll(/[{}]/g)) {
      if (brace[0] === "{") scopes.push(named ?? "unknown");
      else if (!scopes.length) return null;
      else scopes.pop();
    }
  }
  return assignments && !scopes.length ? normalized.join("\n") : null;
}

/** Only omit single-parent commits whose every touched manifest is proven release metadata. */
export async function releaseMetadataOnly(root: string, commit: RangeCommits["commits"][number]): Promise<boolean> {
  if (!commit.files.length || !commit.files.every(file => /(^|\/)build\.gradle(?:\.kts)?$/.test(file))) return false;
  try {
    const parents = (await git(root, ["rev-list", "--parents", "-n", "1", commit.hash])).trim().split(/\s+/);
    if (parents.length !== 2) return false;
    for (const file of commit.files) {
      const raw = await git(root, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", parents[1], commit.hash, "--", file]);
      if (!/^:(100644|100755) \1 [a-f0-9]+ [a-f0-9]+ M\0/.test(raw)) return false;
      const [before, after] = await Promise.all([
        git(root, ["show", parents[1] + ":" + file]), git(root, ["show", commit.hash + ":" + file]),
      ]);
      const previous = withoutAndroidReleaseValues(before);
      if (previous === null || previous !== withoutAndroidReleaseValues(after)) return false;
    }
    return true;
  } catch { return false; }
}
