import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { z } from "zod";
import { DOC_CANDIDATES } from "../audit/docs.js";
import { extractClaims } from "../audit/claims.js";
import { checkResultSchema } from "../audit/repair.js";
import { CHECKS, type CheckResult } from "../audit/checks/index.js";
import type { AuditOptions } from "../audit/audit.js";
import type { CheckName } from "../audit/types.js";
import { readBoundedFile, SOURCE_IGNORE } from "../utils/files.js";
import { moduleCandidates } from "../audit/checks/new-module.js";
import { resolveCountSource } from "../audit/checks/stale-count.js";
import { commandManifests } from "../audit/checks/dead-command.js";
import { storePath } from "../utils/storage.js";

const exec = promisify(execFile);
declare const PKG_VERSION: string;
const engineVersion = typeof PKG_VERSION === "string" ? PKG_VERSION : "development";
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 10000 })).stdout;
}

export async function workspace(dir: string) {
  const root = await fs.realpath((await git(dir, "rev-parse", "--show-toplevel")).trim());
  const gitDir = await fs.realpath((await git(root, "rev-parse", "--absolute-git-dir")).trim());
  let branch: string;
  try { branch = (await git(root, "symbolic-ref", "--quiet", "HEAD")).trim(); }
  catch { branch = "detached"; }
  return { root, gitDir, branch, directory: ".mason/reports/automation/" + hash([root, gitDir, branch]).slice(0, 24) };
}

async function content(root: string, file: string): Promise<string | null> {
  try {
    const value = await readBoundedFile(await storePath(root, file), 10 * 1024 * 1024);
    if (value === null) throw new Error("Unreadable or oversized audit input: " + file);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const internal = (file: string) => file === ".mason" || file === ".mason/reports" || file.startsWith(".mason/reports/");

export interface Inputs {
  fingerprint: string;
  head: string;
  docs: Record<string, string | null>;
  keys: Record<CheckName, string>;
}

export async function readInputs(root: string): Promise<Inputs> {
  const [headText, docStatus, inventory, shallowPath, replacements] = await Promise.all([
    git(root, "rev-parse", "HEAD"),
    git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...DOC_CANDIDATES),
    fg("**/*", { cwd: root, dot: true, onlyFiles: false, followSymbolicLinks: false, objectMode: true,
      ignore: SOURCE_IGNORE }),
    git(root, "rev-parse", "--git-path", "shallow"),
    git(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/replace"),
  ]);
  const entries = inventory.filter(f => !internal(f.path) && f.path !== ".git").sort((a, b) => a.path.localeCompare(b.path));
  const files = entries.map(f => f.path);
  if (files.length > 100000) throw new Error("Automation input inventory exceeds 100,000 paths; use an explicit scoped audit.");
  const head = headText.trim();
  let shallow: string | null = null;
  try { shallow = await fs.readFile(path.resolve(root, shallowPath.trim()), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const docs: Record<string, string | null> = {};
  const docContents: Array<[string, string | null]> = [];
  const claims: Array<[string, boolean, boolean]> = [];
  for (const file of DOC_CANDIDATES) {
    const text = await content(root, file);
    docs[file] = text === null ? null : hash(text);
    docContents.push([file, text]);
    for (const claim of text ? extractClaims(text).paths : []) {
      if (internal(claim.path) || claim.path.startsWith(".mason/")) continue;
      // Explicit claims can name ignored files, directories, or symlink targets.
      const exists = async (p: string) => fs.access(path.resolve(root, p)).then(() => true, () => false);
      claims.push([claim.path, await exists(claim.path), await exists(path.dirname(claim.path))]);
    }
  }
  // The existing audit follows some directory symlinks. Refuse to cache an
  // unbounded external dependency instead of claiming its targets were checked.
  if (entries.some(f => f.dirent.isSymbolicLink())) throw new Error("Automation inventory contains a symbolic link; use an explicit audit to inspect its scope. No cached verification was recorded.");
  const combinedDocs = docContents.map(([, text]) => text ?? "").join("\n");
  const countClaims = docContents.flatMap(([, text]) => text ? extractClaims(text).counts : []);
  const decisionDirectory = await storePath(root, ".mason/decisions");
  const decisionPresence = await fs.lstat(decisionDirectory).then(stat => stat.isDirectory() ? "directory" : "file", error => {
    if (error.code === "ENOENT") return "absent";
    throw error;
  });
  const [modules, counts, manifests, decisionFiles] = await Promise.all([
    combinedDocs ? moduleCandidates(root, combinedDocs) : [],
    Promise.all(countClaims.map(claim => resolveCountSource(root, claim))),
    commandManifests(root),
    fg(".mason/decisions/*.json", { cwd: root, dot: true, onlyFiles: false, followSymbolicLinks: false }),
  ]);
  const packages = await Promise.all(["package.json", ...manifests.sort()].map(async file => [file, await content(root, file)]));
  const decisions = await Promise.all(decisionFiles.sort().map(async file => [file, await content(root, file)]));
  // Decision freshness observes tracked and local anchor changes; other checks
  // do not need a repository-wide status or index scan.
  const [status, index] = decisions.length ? await Promise.all([
    git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude).mason/reports"),
    git(root, "ls-files", "--stage", "-z", "--", ".", ":(exclude).mason/reports"),
  ]) : ["", ""];
  const common = [2, engineVersion, head, shallow, replacements, docContents];
  const keys: Record<CheckName, string> = {
    "deleted-reference": hash([common, claims, docStatus]),
    "new-module": hash([common, modules]),
    "stale-count": hash([common, counts]),
    "dead-command": hash([common, packages]),
    "deps-changed": hash([common, docStatus]),
    "decision-anchor-drift": hash([common, decisionPresence, decisions, status, index]),
  };
  return { fingerprint: hash(keys), head, docs, keys };
}

const cacheSchema = z.object({ version: z.literal(1), entries: z.record(z.object({ key: z.string(), result: checkResultSchema })), digest: z.string() });
export function checkCache(raw: unknown, inputs: Inputs) {
  let entries: Record<string, { key: string; result: CheckResult }> = {};
  let diagnostic: string | null = null;
  if (raw !== null) {
    const parsed = cacheSchema.safeParse(raw);
    if (parsed.success && parsed.data.digest === hash(parsed.data.entries)) entries = parsed.data.entries as Record<string, { key: string; result: CheckResult }>;
    else diagnostic = "Discarded an invalid automation cache; checks are being recomputed.";
  }
  const ran = new Set<CheckName>(), reused = new Set<CheckName>();
  const options: AuditOptions = { runCheck: async (name, ctx) => {
    if (entries[name]?.key === inputs.keys[name]) {
      reused.add(name);
      return structuredClone(entries[name].result);
    }
    const result = await CHECKS[name](ctx);
    ran.add(name);
    // An unavailable check must be retried even if the file inputs match.
    if (!result.skipped.length) entries[name] = { key: inputs.keys[name], result };
    else delete entries[name];
    return result;
  } };
  return { options, ran, reused, diagnostic, serialize: () => {
    const canonical = cacheSchema.shape.entries.parse(entries);
    return { version: 1, entries: canonical, digest: hash(canonical) };
  } };
}
