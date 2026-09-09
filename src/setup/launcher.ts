import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { Host } from "../automation/store.js";
import { git } from "../automation/evidence.js";
import { loadSetup } from "./model.js";

declare const PKG_VERSION: string;
export const executingVersion = () => typeof PKG_VERSION === "string" ? PKG_VERSION : "development";

// Windows needs cmd to launch both npm's and the standalone installer's .cmd shim.
export function globalCommand(args: string[], platform = process.platform) {
  return platform === "win32" ? { command: "cmd.exe", args: ["/d", "/s", "/c", "mason", ...args] }
    : { command: "mason", args };
}
export const mcpCommand = (host: Host) => globalCommand(["--setup-host", host, "mcp"]);
export const hookCommand = (host: Host) => `mason --setup-host ${host} auto`;

/** Probe the same PATH command the host will use; never download during setup. */
export async function installedCommand() {
  const invocation = globalCommand(["internal-integration-version"]);
  try {
    const { stdout } = await promisify(execFile)(invocation.command, invocation.args,
      { timeout: 5000, maxBuffer: 8192, windowsHide: true });
    const result = JSON.parse(stdout);
    if (result.protocol !== 1 || typeof result.version !== "string") throw new Error("Unsupported Mason integration protocol.");
    return { available: true, version: result.version as string, message: null };
  } catch {
    return { available: false, version: null, message: "An up-to-date mason command is not available on this process's PATH. Install or upgrade Mason, then reopen your terminal or desktop assistant and rerun mason setup." };
  }
}

/** Replaces the environment previously supplied by generated project launchers. */
export async function prepareLaunch(host: Host, options: { allowInactive?: boolean } = {}) {
  const root = await fs.realpath((await git(process.cwd(), "rev-parse", "--show-toplevel")).trim());
  const entry = (await loadSetup(root))?.hosts[host];
  if (!entry) {
    if (options.allowInactive) return false;
    throw new Error(`Mason is not configured locally for ${host}. Run mason setup --host ${host} in this checkout.`);
  }
  process.env.MASON_SETUP_ROOT = root;
  process.env.MASON_SETUP_HOST = host;
  process.env.MASON_SETUP_REVISION = entry.revision;
  return true;
}
