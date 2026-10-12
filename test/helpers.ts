import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);

export function fixturePath(name: string): string {
  return path.join(__dirname, "fixtures", name);
}

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await git(["add", "."], dir);
  await git(["commit", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

export async function initGitRepo(dir: string): Promise<void> {
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "test@test.com"], dir);
  await git(["config", "user.name", "Test"], dir);
}

/** Fixture convenience: exercise the two explicit initialization and activation commands. */
export async function configureProject(
  dir: string,
  options: Parameters<typeof import("../src/setup/setup.js").setupProject>[1] = {},
) {
  const { initializeProject, setupProject } = await import("../src/setup/setup.js");
  const initialized = await initializeProject(dir, options);
  const result = await setupProject(dir, options);
  return {
    ...result,
    changedFiles: [...initialized.changes.map((change) => change.path), ...result.changedFiles],
  };
}
