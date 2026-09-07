import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { storePath } from "../utils/storage.js";

export const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const bundleSchema = z.object({
  format: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  target: z.enum(targets), nodeVersion: z.string(), files: z.record(digest),
}).strict();
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export async function readBundle(root: string) {
  const bytes = await fs.readFile(await storePath(root, "bundle.json"));
  const manifest = bundleSchema.parse(JSON.parse(bytes.toString("utf8")));
  const windows = manifest.target.startsWith("win32-");
  for (const file of Object.keys(manifest.files)) {
    if (file.includes("\\") || file.split("/").some(p => !p || p === "." || p === "..") || path.isAbsolute(file)) {
      throw new Error("Unsafe path in Mason bundle: " + file);
    }
  }
  for (const required of [windows ? "node.exe" : "node", "app/package.json", "app/dist/mason.js", "app/dist/mason-auto.js", "app/dist/mason-mcp.js"]) {
    if (!manifest.files[required]) throw new Error("Incomplete Mason bundle: " + required);
  }
  return { manifest, manifestHash: sha256(bytes) };
}

/** Verify every shipped file before copying or selecting a standalone distribution. */
export async function verifyBundle(root: string, expectedHash?: string) {
  const bundle = await readBundle(root);
  if (expectedHash && bundle.manifestHash !== expectedHash) throw new Error("Mason bundle manifest changed.");
  if (bundle.manifest.target !== `${process.platform}-${process.arch}`) throw new Error("Mason bundle is for another platform. Install this platform's bundle and rerun setup.");
  const files = Object.keys(bundle.manifest.files);
  // Bound concurrent reads; Node itself is a large file.
  for (let i = 0; i < files.length; i += 8) await Promise.all(files.slice(i, i + 8).map(async file => {
    if (sha256(await fs.readFile(await storePath(root, file))) !== bundle.manifest.files[file]) throw new Error("Mason bundle checksum mismatch: " + file);
  }));
  return bundle;
}
