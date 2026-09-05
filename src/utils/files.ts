import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { isWithinRoot, normalizeRepoPath } from "./paths.js";

const exec = promisify(execFile);
export const SOURCE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "vue", "svelte", "kt", "kts", "java", "py", "go", "rs", "swift", "rb", "cs", "cpp", "c", "h", "hpp", "dart", "php"];
export const SOURCE_GLOB = `**/*.{${SOURCE_EXTENSIONS.join(",")}}`;
export const SOURCE_IGNORE = [
  "**/node_modules/**", "**/dist/**", "**/build/**", "**/.gradle/**",
  "**/target/**", "**/.git/**", "**/.mason/**", "**/vendor/**", "**/__pycache__/**",
  "**/venv/**", "**/.venv/**", "**/*.min.*", "**/*.map", "**/*.lock",
  "**/generated/**", "**/*.generated.*", "**/R.java", "**/BuildConfig.java",
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml",
];
export const MAX_SOURCE_BYTES = 1024 * 1024;
export interface ProjectConfig { patterns?: string[]; alwaysInclude?: string[]; ignore?: string[] }
export interface SourceFile { path: string; content: string; totalLines: number }

export function isSensitiveFile(file: string): boolean {
  return file.split(/[\\/]/).some(part =>
    /^(?:\.env(?:\..*)?|id_rsa.*|id_ed25519.*)$|\.(?:pem|key|p12|pfx|jks|keystore)$|credentials\.|secret|^local\.properties$/i.test(part)
  );
}

/** Bound reads even if a file grows after stat. Only read regular files. */
export async function readBoundedFile(file: string, maxBytes: number): Promise<string | null> {
  // Do not block on a FIFO or follow a symlink substituted after resolution.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    return bytes === buffer.length ? null : buffer.subarray(0, bytes).toString("utf8");
  } finally { await handle.close(); }
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  try {
    const canonicalRoot = await fs.realpath(root);
    const configPath = await fs.realpath(path.join(root, ".mason/config.json"));
    if (!isWithinRoot(canonicalRoot, configPath)) throw new Error("Project configuration resolves outside the repository");
    const raw = await readBoundedFile(configPath, 64 * 1024);
    if (raw === null) throw new Error("Project configuration is not a regular file or exceeds 64 KiB");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration object");
    const config: ProjectConfig = {};
    for (const key of ["patterns", "alwaysInclude", "ignore"] as const) {
      if (value[key] === undefined) continue;
      if (!Array.isArray(value[key]) || !value[key].every((s: unknown) => typeof s === "string")) {
        throw new Error(`Configuration ${key} must be an array of strings`);
      }
      config[key] = value[key];
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot apply project file policy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Scoped to one operation, so a later tool call sees newly edited files/ignores. */
export async function createFileAccess(rootDir: string) {
  const root = path.resolve(rootDir);
  const canonicalRoot = await fs.realpath(root).catch(() => root);
  const config = await loadProjectConfig(root);
  const ignore = [...SOURCE_IGNORE, ...(config.ignore ?? [])];
  let gitFiles: Set<string> | null = null;
  try {
    const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 50 * 1024 * 1024 });
    gitFiles = new Set(stdout.split("\0").filter(Boolean));
  } catch {
    // File-system projects are supported. Fail closed if this IS a Git repo.
    let inGit = false;
    try { await exec("git", ["rev-parse", "--git-dir"], { cwd: root }); inGit = true; } catch { /* no Git */ }
    if (inGit) throw new Error("Cannot enumerate Git files safely");
  }

  async function resolve(file: string): Promise<string | null> {
    const relative = normalizeRepoPath(file);
    if (!relative || isSensitiveFile(relative) || (gitFiles && !gitFiles.has(relative))) return null;
    const candidate = path.join(root, relative);
    try {
      const real = await fs.realpath(candidate);
      if (!isWithinRoot(canonicalRoot, real) || isSensitiveFile(path.relative(canonicalRoot, real))) return null;
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
      // A symlink must not bypass the target's ignore policy either.
      if (gitFiles && !gitFiles.has(path.relative(canonicalRoot, real).split(path.sep).join("/"))) return null;
      return real;
    } catch { return null; }
  }

  async function list(patterns: string | string[] = SOURCE_GLOB, options: { deep?: number; dot?: boolean } = {}): Promise<string[]> {
    const found = await fg(patterns, { cwd: root, ignore, followSymbolicLinks: false, ...options });
    const safe = await Promise.all(found.map(async f => (await resolve(f)) ? f : null));
    return safe.filter((f): f is string => f !== null).sort();
  }

  async function read(file: string): Promise<SourceFile | null> {
    const relative = normalizeRepoPath(file);
    if (!relative) return null;
    const real = await resolve(relative);
    if (!real) return null;
    // Apply the same glob exclusions to explicit reads and symlink targets.
    for (const rel of new Set([relative, path.relative(canonicalRoot, real).split(path.sep).join("/")])) {
      if (!(await fg(fg.escapePath(rel), { cwd: root, ignore, dot: true })).length) return null;
    }
    try {
      const content = await readBoundedFile(real, MAX_SOURCE_BYTES);
      return content === null ? null : { path: relative, content, totalLines: content.split("\n").length };
    } catch { return null; }
  }
  return { root, config, list, read };
}
