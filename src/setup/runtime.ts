import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeSchema, type Runtime } from "./model.js";
import { readStoreJson, storePath } from "../utils/storage.js";
import { hash } from "../automation/evidence.js";
import { verifyBundle } from "../distribution/bundle.js";

const exec = promisify(execFile);
const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const BINARIES = ["dist/mason-auto.js", "dist/mason-mcp.js"];
async function packageRoot() {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      if (pkg.name === "mason-context") return directory;
    } catch { /* Locate the executing distribution, never the target project's package. */ }
    directory = path.dirname(directory);
  }
  throw new Error("Cannot locate the executing Mason distribution. Reinstall Mason and rerun setup.");
}
export async function sourceRuntime(): Promise<{ source: string; runtime: Runtime; bundleRoot?: string }> {
  const source = await packageRoot();
  const pkg = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  const hashes = Object.fromEntries(await Promise.all(BINARIES.map(async file => [file, checksum(await fs.readFile(path.join(source, file)))])));
  const bundleRoot = path.dirname(source);
  const bundleExists = await fs.lstat(path.join(bundleRoot, "bundle.json")).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (bundleExists) {
    const { manifest, manifestHash } = await verifyBundle(bundleRoot);
    if (manifest.version !== pkg.version) throw new Error("Mason package and bundle versions differ.");
    return { source, bundleRoot, runtime: runtimeSchema.parse({ id: manifestHash.slice(0, 24), version: pkg.version, hashes,
      bundle: { target: manifest.target, manifestHash } }) };
  }
  return { source, runtime: runtimeSchema.parse({ id: hash([pkg.version, pkg.dependencies, hashes]).slice(0, 24), version: pkg.version, hashes }) };
}
export async function verifyRuntime(root: string, runtime: Runtime): Promise<boolean> {
  try {
    const saved = await readStoreJson(root, `.mason/runtime/${runtime.id}/receipt.json`);
    if (JSON.stringify(saved) !== JSON.stringify(runtime)) return false;
    if (runtime.bundle) {
      const base = await storePath(root, `.mason/runtime/${runtime.id}`);
      const { manifest } = await verifyBundle(base, runtime.bundle.manifestHash);
      if (manifest.version !== runtime.version || manifest.target !== runtime.bundle.target) return false;
      for (const file of BINARIES) if (manifest.files["app/" + file] !== runtime.hashes[file]) return false;
      return true;
    }
    const base = `.mason/runtime/${runtime.id}/node_modules/mason-context/`;
    const pkg = await readStoreJson(root, base + "package.json") as { name?: string; version?: string } | null;
    if (pkg?.name !== "mason-context" || pkg.version !== runtime.version) return false;
    for (const file of BINARIES) {
      if (checksum(await fs.readFile(await storePath(root, base + file))) !== runtime.hashes[file]) return false;
    }
    return true;
  } catch { return false; }
}

/** Install the executing distribution, including unpublished local builds, outside the app's manifest. */
export async function installRuntime(root: string, selected: Awaited<ReturnType<typeof sourceRuntime>>) {
  const { runtime, source } = selected;
  if (await verifyRuntime(root, runtime)) return runtime;
  const relative = `.mason/runtime/${runtime.id}`;
  const target = await storePath(root, relative, true);
  const stage = await storePath(root, ".mason/runtime/.install-" + randomUUID(), true);
  await fs.mkdir(stage);
  try {
    if (runtime.bundle) {
      if (!selected.bundleRoot) throw new Error("Standalone bundle source is missing.");
      const { manifest } = await verifyBundle(selected.bundleRoot, runtime.bundle.manifestHash);
      for (const file of ["bundle.json", ...Object.keys(manifest.files)]) {
        const from = await storePath(selected.bundleRoot, file);
        const to = await storePath(stage, file, true);
        await fs.copyFile(from, to);
        await fs.chmod(to, (await fs.stat(from)).mode & 0o777);
      }
      await verifyBundle(stage, runtime.bundle.manifestHash);
    } else {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const options = { timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
      const packed = JSON.parse((await exec(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", stage], { ...options, cwd: source })).stdout);
      const filename = packed[0]?.filename;
      if (typeof filename !== "string" || path.basename(filename) !== filename) throw new Error("npm did not produce a Mason package archive.");
      await fs.rename(path.join(stage, filename), path.join(stage, "mason.tgz"));
      await fs.writeFile(path.join(stage, "package.json"), JSON.stringify({ name: "mason-project-runtime", private: true, version: "1.0.0" }));
      await exec(npm, ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--save-exact", "./mason.tgz"], { ...options, cwd: stage });
      for (const file of BINARIES) {
        if (checksum(await fs.readFile(path.join(stage, "node_modules/mason-context", file))) !== runtime.hashes[file]) throw new Error("Installed Mason binary differs from the selected distribution.");
      }
    }
    await fs.writeFile(path.join(stage, "receipt.json"), JSON.stringify(runtime, null, 2) + "\n");
    // Keep a damaged prior runtime available for inspection; never merge partial installs.
    try { await fs.rename(target, target + ".previous-" + randomUUID()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fs.rename(stage, target);
    if (!await verifyRuntime(root, runtime)) throw new Error("The installed Mason runtime could not be verified.");
    return runtime;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
