import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { profilePhase } from "./profile.js";

const execute = promisify(execFile);
const commands = new Set(["rev-parse", "symbolic-ref", "for-each-ref", "ls-files", "check-ignore", "status", "log", "diff", "ls-tree", "show", "merge-base"]);
export interface GitReadOptions { cwd: string; maxBuffer?: number; timeout?: number; input?: string }

/** Fixed command labels only: profiling never includes arguments or repository paths. */
export function execGit(args: string[], options: GitReadOptions) {
  const command = args.find(arg => !arg.startsWith("-")) ?? "other";
  return profilePhase("git." + (commands.has(command) ? command : "other"), async () => {
    const { input, ...processOptions } = options;
    const operation = execute("git", args, processOptions);
    if (input !== undefined) {
      operation.child.stdin!.on("error", () => { /* The child exit reports a failed query. */ });
      operation.child.stdin!.end(input);
    }
    return operation;
  });
}
