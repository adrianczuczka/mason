import { execGit } from "./git-read.js";


export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execGit(["rev-parse", "--git-dir"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}
