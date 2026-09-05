import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeRepoPath } from "./paths.js";
import { readBoundedFile } from "./files.js";

export interface StoreDiagnostic { path: string; message: string }

/** Metadata paths may not contain symlinks, including their parent directories. */
export async function storePath(root: string, relative: string, createParents = false): Promise<string> {
  const normalized = normalizeRepoPath(relative);
  if (!normalized) throw new Error(`Invalid store path: ${relative}`);
  let current = await fs.realpath(root);
  const parts = normalized.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (createParents && i < parts.length - 1) {
        try { await fs.mkdir(current); } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        stat = await fs.lstat(current);
      }
    }
    if (stat?.isSymbolicLink()) throw new Error(`Symlink in store path: ${relative}`);
  }
  return current;
}

export async function readStoreJson(root: string, relative: string): Promise<unknown | null> {
  try {
    const file = await storePath(root, relative);
    const raw = await readBoundedFile(file, 10 * 1024 * 1024);
    if (raw === null) throw new Error("file is not regular or exceeds 10 MiB");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null) throw new Error("expected a JSON object, received null");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Invalid Mason store ${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeStoreJson(root: string, relative: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(payload) > 10 * 1024 * 1024) {
    throw new Error(`Mason store ${relative} exceeds 10 MiB`);
  }
  const file = await storePath(root, relative, true);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(payload, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
