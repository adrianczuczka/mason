import fg from "fast-glob";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { execGit, type GitReadOptions } from "../utils/git-read.js";
import { loadProjectConfig, SOURCE_EXTENSIONS } from "../utils/files.js";

interface Inspection {
  root: string;
  reads: Map<string, Promise<unknown>>;
}
const inspections = new AsyncLocalStorage<Inspection>();

/** Always start fresh. In particular, final validation must not reuse initial reads. */
export function withRepositoryInspection<T>(root: string, run: () => Promise<T>): Promise<T> {
  return inspections.run({ root: path.resolve(root), reads: new Map() }, run);
}

/** Read observations are shared only inside an explicit inspection, never across hooks. */
export function inspectionRead<T>(root: string, key: string, read: () => Promise<T>): Promise<T> {
  const inspection = inspections.getStore();
  if (!inspection || inspection.root !== path.resolve(root)) return read();
  if (!inspection.reads.has(key)) {
    const pending = read();
    inspection.reads.set(key, pending);
    // A failed query must be retried, not turned into a reusable unavailable result.
    void pending.catch(() => {
      if (inspection.reads.get(key) === pending) inspection.reads.delete(key);
    });
  }
  return inspection.reads.get(key)! as Promise<T>;
}

/** Tool writes invalidate their cached observations within the active inspection. */
export function invalidateInspectionReads(root: string, prefix: string): void {
  const inspection = inspections.getStore();
  if (!inspection || inspection.root !== path.resolve(root)) return;
  for (const key of inspection.reads.keys())
    if (key.startsWith(prefix)) inspection.reads.delete(key);
}

/** Exact arguments and limits preserve each history query's semantics. */
export function inspectionGit(args: string[], options: GitReadOptions) {
  return inspectionRead(options.cwd, "git:" + JSON.stringify([args, options]), () =>
    execGit(args, options),
  );
}

const sourceSpecs = SOURCE_EXTENSIONS.map((extension) => `:(glob)**/*.${extension}`);
const docSpecs = [
  ":(icase,glob)**/readme.md",
  ":(icase,glob)**/agents.md",
  ":(icase,glob)**/claude.md",
];
const sourceSuffixes = new Set(SOURCE_EXTENSIONS.map((extension) => "." + extension));

/** Git still prunes ignored trees; unrelated generated files are never inventoried. */
export async function auditGitPaths(
  root: string,
  kind: "documents" | "sources",
): Promise<string[]> {
  const custom = (await loadProjectConfig(root)).audit?.include ?? [];
  const shared = inspections.getStore()?.root === path.resolve(root) && !custom.length;
  const expanded = fg.generateTasks(custom).flatMap((task) => task.positive);
  if (expanded.length > 1000)
    throw new Error("Audit include patterns expand to more than 1,000 globs");
  const documentSpecs = [...docSpecs, ...expanded.map((pattern) => `:(glob)${pattern}`)];
  const specs = shared
    ? [...documentSpecs, ...sourceSpecs]
    : kind === "documents"
      ? documentSpecs
      : sourceSpecs;
  const limit = kind === "documents" ? 16 * 1024 * 1024 : 32 * 1024 * 1024;
  const { stdout } = await inspectionGit(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...specs],
    { cwd: root, maxBuffer: shared ? 48 * 1024 * 1024 : limit, timeout: 10000 },
  );
  const paths = [...new Set(stdout.split("\0").filter(Boolean))].filter((file) =>
    kind === "documents"
      ? custom.length > 0 || /^(readme|agents|claude)\.md$/i.test(path.posix.basename(file))
      : // Git's *.ts also matches a file named .ts, unlike path.extname().
        sourceSuffixes.has(file.slice(file.lastIndexOf("."))),
  );
  if (Buffer.byteLength(paths.join("\0")) > limit)
    throw new Error("Git " + kind + " inventory exceeds its bounded read limit.");
  return paths.sort();
}
