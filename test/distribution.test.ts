import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyBundle, sha256 } from "../src/distribution/bundle.js";
import { installStandalone } from "../src/distribution/install.js";
import { installRuntime, verifyRuntime } from "../src/setup/runtime.js";

let root: string, source: string, home: string, bin: string;
async function fixture(version = "1.0.0") {
  await fs.mkdir(source, { recursive: true });
  const files: Record<string, string> = {};
  const contents = {
    [process.platform === "win32" ? "node.exe" : "node"]: "fixture runtime",
    "app/package.json": JSON.stringify({ name: "mason-context", version }),
    "app/dist/mason.js": "fixture CLI " + version,
    "app/dist/mason-auto.js": "fixture automation",
    "app/dist/mason-mcp.js": "fixture MCP",
    "app/node_modules/example/index.js": "dependency",
  };
  for (const [file, text] of Object.entries(contents)) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), text); files[file] = sha256(text);
  }
  const manifest = { format: 1, version, target: `${process.platform}-${process.arch}`, nodeVersion: "24.20.0", files };
  await fs.writeFile(path.join(source, "bundle.json"), JSON.stringify(manifest));
  return manifest;
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mason-distribution-")));
  source = path.join(root, "bundle"); home = path.join(root, "install"); bin = path.join(root, "bin");
  vi.stubEnv("MASON_HOME", home); vi.stubEnv("MASON_BIN_DIR", bin);
  await fixture();
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

describe("standalone distribution integrity and ownership", () => {
  it("rejects a changed dependency before creating an installation", async () => {
    await fs.writeFile(path.join(source, "app/node_modules/example/index.js"), "changed dependency");
    await expect(installStandalone(source)).rejects.toThrow("checksum mismatch");
    await expect(fs.access(home)).rejects.toThrow();
  });
  it("rejects escaping manifest paths and linked dependencies", async () => {
    const manifest = await fixture();
    manifest.files["../outside"] = sha256("outside");
    await fs.writeFile(path.join(source, "bundle.json"), JSON.stringify(manifest));
    await expect(verifyBundle(source)).rejects.toThrow("Unsafe path");
    await fixture();
    const dependency = path.join(source, "app/node_modules/example/index.js");
    await fs.rename(dependency, path.join(root, "outside"));
    await fs.symlink(path.join(root, "outside"), dependency);
    await expect(verifyBundle(source)).rejects.toThrow();
  });
  it("rejects a bundle for another platform", async () => {
    const manifest = await fixture();
    manifest.target = process.platform === "win32" ? "darwin-arm64" : "win32-x64";
    await fs.writeFile(path.join(source, "bundle.json"), JSON.stringify(manifest));
    await expect(installStandalone(source)).rejects.toThrow();
  });
  it("reports an installed project runtime invalid when a dependency changes", async () => {
    const { manifest, manifestHash } = await verifyBundle(source);
    const runtime = { id: manifestHash.slice(0, 24), version: manifest.version,
      hashes: Object.fromEntries(["dist/mason-auto.js", "dist/mason-mcp.js"].map(file => [file, manifest.files["app/" + file]])),
      bundle: { target: manifest.target, manifestHash } };
    await installRuntime(root, { source: path.join(source, "app"), bundleRoot: source, runtime });
    expect(await verifyRuntime(root, runtime)).toBe(true);
    await fs.writeFile(path.join(root, ".mason/runtime", runtime.id, "app/node_modules/example/index.js"), "broken dependency");
    expect(await verifyRuntime(root, runtime)).toBe(false);
  });
  it("retains an unrelated launcher instead of taking ownership", async () => {
    await fs.mkdir(bin);
    const name = process.platform === "win32" ? "mason.cmd" : "mason";
    await fs.writeFile(path.join(bin, name), "someone else's program");
    await expect(installStandalone(source)).rejects.toThrow("unrelated or edited launcher");
    expect(await fs.readFile(path.join(bin, name), "utf8")).toBe("someone else's program");
    await expect(fs.access(path.join(home, "install.json"))).rejects.toThrow();
    await fs.rm(path.join(bin, name));
    await expect(installStandalone(source)).resolves.toMatchObject({ version: "1.0.0" });
  });
  it("resumes an interrupted first install using its ownership receipt", async () => {
    const copy = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockRejectedValueOnce(new Error("disk full"));
    await expect(installStandalone(source)).rejects.toThrow("disk full");
    expect(JSON.parse(await fs.readFile(path.join(home, "install.json"), "utf8")).version).toBe("1.0.0");
    vi.mocked(fs.copyFile).mockImplementation(copy);
    await expect(installStandalone(source)).resolves.toMatchObject({ version: "1.0.0" });
  });
  it("resumes an interrupted upgrade without treating the previous launcher as foreign", async () => {
    await installStandalone(source);
    const old = JSON.parse(await fs.readFile(path.join(home, "install.json"), "utf8"));
    await fixture("1.1.0");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.dirname(String(to)) === bin) throw new Error("interrupted launcher replacement");
      return rename(from, to);
    });
    await expect(installStandalone(source)).rejects.toThrow("interrupted launcher replacement");
    for (const [name, text] of Object.entries(old.launchers)) expect(await fs.readFile(path.join(bin, name), "utf8")).toBe(text);
    vi.mocked(fs.rename).mockImplementation(rename);
    await expect(installStandalone(source)).resolves.toMatchObject({ version: "1.1.0" });
    const current = JSON.parse(await fs.readFile(path.join(home, "install.json"), "utf8"));
    expect(current.current).not.toBe(old.current);
    expect(current.previousLaunchers).toBeUndefined();
  });
});
