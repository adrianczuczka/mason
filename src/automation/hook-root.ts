import fs from "node:fs/promises";
import path from "node:path";
import { git } from "./evidence.js";
import type { Host } from "./store.js";

async function repositoryRoot(dir: string): Promise<string | null> {
  if (!path.isAbsolute(dir)) throw new Error("Hook input working directory must be absolute.");
  try { return await fs.realpath((await git(dir, "rev-parse", "--show-toplevel")).trim()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        /not a git repository/.test(String((error as { stderr?: string }).stderr))) return null;
    throw error;
  }
}

/** The host payload follows directory/worktree changes; the launch directory may not. */
export async function resolveHookRoot(host: Host, cwd: string, options: {
  launchCwd?: string; projectDir?: string;
} = {}): Promise<string> {
  const current = await repositoryRoot(cwd);
  if (current) return current;
  const projectDir = options.projectDir ?? (host === "claude" ? process.env.CLAUDE_PROJECT_DIR : undefined);
  const projectRoot = projectDir ? await repositoryRoot(projectDir) : null;
  if (projectDir && !projectRoot) throw new Error("Hook input is outside Git and the host project is no longer a Git repository. Restore its history before running mason check.");
  const launchRoot = await repositoryRoot(options.launchCwd ?? process.cwd());
  const roots = [...new Set([launchRoot, projectRoot].filter((root): root is string => root !== null))];
  if (!roots.length) throw new Error("Hook input is outside a Git repository and no project root is available. Return to the project and run mason check.");
  if (roots.length > 1) throw new Error("Hook input is outside a Git repository and project roots disagree. Return to the intended checkout and run mason check; verification was not established.");
  // CLAUDE_PROJECT_DIR stays at the original checkout after EnterWorktree.
  // Without a current repository, it cannot distinguish those checkouts.
  const worktrees = (await git(roots[0], "worktree", "list", "--porcelain", "-z"))
    .split("\0").filter(field => field.startsWith("worktree "));
  if (worktrees.length !== 1) throw new Error("Hook input is outside a Git repository with multiple worktrees. Return to the intended worktree and run mason check; the active checkout is unknown.");
  return roots[0];
}
