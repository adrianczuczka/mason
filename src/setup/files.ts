import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readBoundedFile } from "../utils/files.js";
import { storePath } from "../utils/storage.js";

export interface FileEdit { path: string; before: string | null; after: string }
export async function readText(root: string, file: string): Promise<string | null> {
  try {
    const text = await readBoundedFile(await storePath(root, file), 2 * 1024 * 1024);
    if (text === null) throw new Error("Setup input is not a regular file or exceeds 2 MiB: " + file);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Preserve all bytes outside one unambiguous managed block. */
export function managedBlock(text: string, start: string, end: string, body: string): string {
  const starts = text.split(start).length - 1, ends = text.split(end).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && text.indexOf(end) < text.indexOf(start)) {
    throw new Error("Ambiguous Mason instruction/configuration markers; repair the marked block before setup.");
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = [start, body.replace(/\r?\n/g, eol), end].join(eol);
  if (starts) return text.slice(0, text.indexOf(start)) + block + text.slice(text.indexOf(end) + end.length);
  return text + (text.length && !text.endsWith("\n") ? eol : "") + (text.length ? eol : "") + block + eol;
}

/** Compare before replacing: a resumed setup cannot overwrite a user's concurrent edit. */
export async function applyEdit(root: string, edit: FileEdit): Promise<boolean> {
  const current = await readText(root, edit.path);
  if (current === edit.after) return false;
  if (current !== edit.before) throw new Error("Setup input changed during installation: " + edit.path + ". Rerun setup to resume.");
  const file = await storePath(root, edit.path, true);
  const temporary = path.join(path.dirname(file), ".mason-setup-" + randomUUID() + ".tmp");
  try {
    const mode = await fs.stat(file).then(s => s.mode & 0o777, () => 0o600);
    const handle = await fs.open(temporary, "wx", mode);
    try { await handle.writeFile(edit.after, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    if (await readText(root, edit.path) !== edit.before) throw new Error("Setup input changed during installation: " + edit.path);
    await fs.rename(temporary, file);
    return true;
  } finally { await fs.rm(temporary, { force: true }); }
}
