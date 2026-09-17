import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { git } from "../automation/evidence.js";
import { readStoreJson } from "../utils/storage.js";

export const setupHostSchema = z.object({
  configuredVersion: z.string(), revision: z.string().uuid(), fingerprint: z.string(), mcpFingerprint: z.string(),
  instructions: z.array(z.string()),
});
export const setupSchema = z.object({ version: z.literal(2), hosts: z.object({
  codex: setupHostSchema.optional(), claude: setupHostSchema.optional(),
}) });
export const SETUP_PATH = ".mason/local/setup.json";
export const INACTIVE_HOSTS_PATH = ".mason/local/inactive-hosts.json";
export const inactiveHostsSchema = z.object({ version: z.literal(1), hosts: z.array(z.enum(["claude", "codex"])) });
export type SetupConfig = z.infer<typeof setupSchema>;
export async function loadSetup(root: string): Promise<SetupConfig | null> {
  const raw = await readStoreJson(root, SETUP_PATH);
  if (raw === null) return null;
  return setupSchema.parse(raw);
}

/** Share activation with linked worktrees, never their audit evidence or ownership. */
export async function effectiveSetup(root: string): Promise<{ root: string; setup: SetupConfig | null }> {
  const local = await loadSetup(root);
  // Even an empty local record is authoritative (including after teardown).
  if (local) return { root, setup: local };
  const common = await fs.realpath(path.resolve(root, (await git(root, "rev-parse", "--git-common-dir")).trim()));
  const own = await fs.realpath((await git(root, "rev-parse", "--absolute-git-dir")).trim());
  if (common === own) return { root, setup: null };
  // Git's first worktree identifies the primary checkout. Bare repositories
  // have no primary checkout from which to inherit activation.
  const primary = (await git(root, "worktree", "list", "--porcelain", "-z")).split("\0\0")[0].split("\0");
  const candidate = primary.find(field => field.startsWith("worktree "))?.slice(9);
  if (!candidate || primary.includes("bare")) return { root, setup: null };
  let inheritedRoot: string;
  try { inheritedRoot = await fs.realpath((await git(candidate, "rev-parse", "--show-toplevel")).trim()); }
  catch (error) {
    // --separate-git-dir may list only the metadata directory, with no recorded
    // checkout location. Do not infer a sibling or search unrelated directories.
    if (/must be run in a work tree/.test(String((error as { stderr?: string }).stderr))) return { root, setup: null };
    throw error;
  }
  const inheritedCommon = await fs.realpath(path.resolve(inheritedRoot,
    (await git(inheritedRoot, "rev-parse", "--git-common-dir")).trim()));
  if (inheritedCommon !== common) throw new Error("Linked worktree setup does not belong to the same Git repository.");
  const setup = await loadSetup(inheritedRoot);
  const inactive = await readStoreJson(root, INACTIVE_HOSTS_PATH);
  if (inactive && setup) for (const host of inactiveHostsSchema.parse(inactive).hosts) delete setup.hosts[host];
  return { root: inheritedRoot, setup };
}

const receiptSchema = z.object({ version: z.literal(1), host: z.enum(["codex", "claude"]),
  status: z.enum(["installing", "configured"]), initialReportPath: z.string(), initialBaselinePaths: z.array(z.string()),
  root: z.string(), revision: z.string().uuid(), configuredAt: z.string().optional() });
export async function loadSetupReceipt(root: string, directory: string, host: "codex" | "claude") {
  const raw = await readStoreJson(root, directory + "/setup-" + host + ".json");
  if (raw === null) return null;
  const receipt = receiptSchema.parse(raw);
  if (receipt.root !== root || receipt.host !== host) throw new Error("Setup receipt belongs to another installation.");
  return receipt;
}
