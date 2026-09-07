import fs from "node:fs/promises";
import * as nativeFs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import fg from "fast-glob";
import { readBoundedFile, SOURCE_EXTENSIONS } from "../utils/files.js";
import { storePath } from "../utils/storage.js";

const execute = promisify(execFile);
const MAX_INPUTS = 100_000;

/** Check the paths a particular audit actually reads, including their parents. */
export async function auditInputPath(root: string, file: string): Promise<string> {
  if (file === ".") return fs.realpath(root);
  try { return await storePath(root, file); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Symlink")) {
      throw new Error(`Audit input contains a symbolic link: ${file}. Its evidence could not be verified.`, { cause: error });
    }
    throw error;
  }
}

export async function readAuditInput(root: string, file: string): Promise<string | null> {
  try {
    const value = await readBoundedFile(await auditInputPath(root, file), 10 * 1024 * 1024);
    if (value === null) throw new Error(`Unreadable or oversized audit input: ${file}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Bound relevant results and directory traversal, without counting unrelated files. */
export async function auditGlob(root: string, patterns: string | string[], options: {
  ignore?: string[]; onlyDirectories?: boolean; followSymbolicLinks?: boolean; label: string; select?: (file: string) => boolean;
}): Promise<string[]> {
  if (Array.isArray(patterns) && !patterns.length) return [];
  const directories = new Set<string>();
  // fast-glob may stat a link, but must never enumerate a linked directory.
  // Validate each traversal and each selected result instead of scanning the
  // entire repository just to reject unrelated symlinks.
  const readdir = ((directory: string, opts: unknown, callback: (error: unknown, entries?: unknown) => void) => {
    const relative = path.relative(root, directory).split(path.sep).join("/") || ".";
    directories.add(relative);
    if (directories.size > MAX_INPUTS) {
      callback(new Error(`${options.label} exceeds ${MAX_INPUTS.toLocaleString("en-US")} directories while inspecting ${relative}. Narrow this check's inputs.`));
      return;
    }
    auditInputPath(root, relative).then(() => {
      nativeFs.readdir(directory, opts as { withFileTypes: true }, callback as (error: NodeJS.ErrnoException | null, entries: nativeFs.Dirent[]) => void);
    }, callback);
  }) as typeof nativeFs.readdir;
  // Literal workspace patterns use lstat instead of readdir. Validate them
  // before fast-glob can silently discard a dangling link as a missing file.
  const lstat = ((file: string, callback: (error: unknown, stat?: nativeFs.Stats) => void) => {
    const relative = path.relative(root, file).split(path.sep).join("/") || ".";
    auditInputPath(root, relative).then(() => nativeFs.lstat(file, callback), callback);
  }) as typeof nativeFs.lstat;
  const stream = fg.stream(patterns, { cwd: root, ignore: options.ignore,
    onlyFiles: false, onlyDirectories: options.onlyDirectories, objectMode: true,
    followSymbolicLinks: options.followSymbolicLinks ?? true, fs: { readdir, lstat }, concurrency: 16 }) as Readable;
  const matches: string[] = [];
  try {
    for await (const value of stream) {
      const entry = value as fg.Entry;
      const file = entry.path;
      if (options.select && !options.select(file)) continue;
      await auditInputPath(root, file);
      if (!options.onlyDirectories && !entry.dirent.isFile()) continue;
      matches.push(file);
      if (matches.length > MAX_INPUTS) {
        const largest = [...matches.reduce((counts, item) => {
          const dir = item.split("/")[0]; counts.set(dir, (counts.get(dir) ?? 0) + 1); return counts;
        }, new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 3);
        throw new Error(`${options.label} exceeds ${MAX_INPUTS.toLocaleString("en-US")} relevant paths. Largest directories: ${largest.map(([dir, count]) => `${dir} (${count})`).join(", ")}. Narrow this check's inputs.`);
      }
    }
  } finally { stream.destroy(); }
  return matches.sort();
}

/** Git prunes ignored trees before discovery; tracked source remains visible. */
export async function gitSourcePaths(root: string): Promise<string[]> {
  const { stdout } = await execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    ...SOURCE_EXTENSIONS.map(extension => `:(glob)**/*.${extension}`)],
  { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 });
  return [...new Set(stdout.split("\0").filter(Boolean))].sort();
}

/** Small directory batches, never a repository-wide inventory of ignored files. */
export async function gitIgnoredPaths(root: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  const operation = execute("git", ["check-ignore", "-z", "--stdin"],
    { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 });
  operation.child.stdin!.on("error", () => { /* The child exit reports a failed query. */ });
  operation.child.stdin!.end(files.join("\0") + "\0");
  try { return new Set((await operation).stdout.split("\0").filter(Boolean)); }
  catch (error) {
    if ((error as { code?: number }).code === 1) return new Set(); // No ignored paths.
    throw error;
  }
}
