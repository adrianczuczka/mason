import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import fg from "fast-glob";
import { inspectionGit, inspectionRead } from "../audit/inspection.js";
import { createFileAccess, MAX_SOURCE_BYTES } from "../utils/files.js";
import { indexMatchingPaths, matchingPaths, normalizeRepoPath } from "../utils/paths.js";
import { storePath } from "../utils/storage.js";

const repoPath = z.string().refine(p => normalizeRepoPath(p) === p);
export const anchorCaptureSchema = z.object({
  anchors: z.array(repoPath),
  files: z.record(repoPath, z.string().regex(/^[a-f0-9]{64}$/)),
  complete: z.boolean(),
}).refine(capture => JSON.stringify(capture.anchors) === JSON.stringify([...new Set(capture.anchors)].sort())
  && matchingPaths(capture.anchors, Object.keys(capture.files)).length === Object.keys(capture.files).length,
  "Capture paths must belong to its normalized, sorted anchor scope");
export type AnchorCapture = z.infer<typeof anchorCaptureSchema>;

/** Content evidence, not approval. Unreadable/excluded scopes never become current.
 * Batch independent scopes and share observations only inside one repository inspection.
 * Final validation creates a fresh inspection; standalone callers always read again.
 */
export async function captureAnchorScopes(root: string, scopes: string[][]): Promise<AnchorCapture[]> {
  const union = [...new Set(scopes.flat())].sort();
  let context: ReturnType<typeof prepareContext> | undefined;
  const prepareContext = async () => {
    const access = await inspectionRead(root, "decision-anchor-access", () => createFileAccess(root));
    const inventory = access.inventory();
    if (!inventory) throw new Error("Git anchor inventory unavailable");
    const ignored = await inspectionGit(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--",
      ...union.map(anchor => `:(literal)${anchor}`)], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const files = [...new Set([...inventory, ...ignored.stdout.split("\0").filter(Boolean)])].sort();
    // Apply file policy in one glob walk rather than one walk per anchor file.
    // storePath still rejects symlinked parents at each bounded byte read.
    const patterns = await Promise.all(union.map(async anchor => {
      const literal = fg.escapePath(anchor);
      try { return (await fs.lstat(await storePath(root, anchor))).isDirectory() ? `${literal}/**/*` : literal; }
      catch { return literal; }
    }));
    const eligible = new Set(await access.list(patterns, { dot: true }));
    const indexed = indexMatchingPaths(scopes, files);
    const filesByScope = new Map(scopes.map((scope, index) => [JSON.stringify([...new Set(scope)].sort()), indexed[index]]));
    return { filesByScope, eligible };
  };
  return Promise.all(scopes.map(scope => {
    const anchors = [...new Set(scope)].sort();
    return inspectionRead(root, "decision-anchor-capture:" + JSON.stringify(anchors), async () => {
      const capture: AnchorCapture = { anchors, files: {}, complete: true };
      if (!anchors.length) return capture;
      try {
        const { eligible, filesByScope } = await (context ??= prepareContext());
        const files = filesByScope.get(JSON.stringify(anchors))!;
        if (files.length > 2000) return { ...capture, complete: false };
        for (const file of files) {
          const evidence = await inspectionRead(root, "decision-anchor-file:" + file, async () => {
            try {
              const absolute = await storePath(root, file);
              await fs.lstat(absolute); // Missing indexed files are deletions, not unreadable evidence.
              if (!eligible.has(file)) return { complete: false };
              const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
              try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return { complete: false };
                const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_SOURCE_BYTES + 1));
                let size = 0;
                while (size < bytes.length) {
                  const read = await handle.read(bytes, size, bytes.length - size, null);
                  if (!read.bytesRead) break;
                  size += read.bytesRead;
                }
                if (size === bytes.length) return { complete: false }; // Grew during capture.
                return { complete: true, hash: createHash("sha256").update(bytes.subarray(0, size)).digest("hex") };
              } finally { await handle.close(); }
            } catch (error) { return { complete: (error as NodeJS.ErrnoException).code === "ENOENT" }; }
          });
          if (!evidence.complete) capture.complete = false;
          if (evidence.hash) capture.files[file] = evidence.hash;
        }
      } catch { capture.complete = false; }
      return capture;
    });
  }));
}

export async function captureAnchors(root: string, anchors: string[]): Promise<AnchorCapture> {
  return (await captureAnchorScopes(root, [anchors]))[0];
}

export function changedCaptureFiles(before: AnchorCapture, after: AnchorCapture): string[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(file => before.files[file] !== after.files[file]).sort();
}
