import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configurePath, removePath, hasWindowsEntry, windowsPath, type PathChange } from "../src/distribution/path.js";

let root: string, bin: string, changes: PathChange[];
const save = async (value: PathChange[]) => { changes = structuredClone(value); };
const options = (shell = "bash") => ({ platform: "linux" as const, userHome: root, env: { SHELL: "/bin/" + shell } });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-path-"));
  bin = path.join(root, "Mason's $tools [x]");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "mason"), '#!/bin/sh\nprintf "fixture-mason\\n"\n', { mode: 0o755 });
  changes = [];
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe("standalone PATH ownership", () => {
  it("preserves profile bytes and permissions through repeat install and uninstall", async () => {
    const file = path.join(root, ".bashrc"), original = "# existing settings\r\nexport EXAMPLE=value";
    await fs.writeFile(file, original, { mode: 0o640 });
    expect((await configurePath(bin, [], save, options())).status).toBe("configured");
    const first = await fs.readFile(file, "utf8");
    expect(first.startsWith(original)).toBe(true);
    expect(first.split("# >>> mason PATH")).toHaveLength(2);
    await configurePath(bin, changes, save, options());
    expect(await fs.readFile(file, "utf8")).toBe(first);
    await fs.appendFile(file, "# added later\n");
    expect(await removePath(changes)).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe(original + "\r\n# added later\n");
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
  });
  it("uses the existing Bash login profile without masking other login settings", async () => {
    await fs.writeFile(path.join(root, ".bash_login"), "# existing login");
    await fs.writeFile(path.join(root, ".profile"), "# fallback login");
    await configurePath(bin, [], save, options());
    expect(changes.map(c => c.kind === "profile" && path.basename(c.file))).toEqual([".bashrc", ".bash_login"]);
    expect(await fs.readFile(path.join(root, ".profile"), "utf8")).toBe("# fallback login");
    await expect(fs.stat(path.join(root, ".bash_profile"))).rejects.toThrow();
  });
  it("keeps the original profile intact when uninstall cannot replace it", async () => {
    await configurePath(bin, [], save, options());
    const file = path.join(root, ".bashrc"), original = await fs.readFile(file);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("replacement failed"));
    expect((await removePath(changes)).join()).toContain("replacement failed");
    expect(await fs.readFile(file)).toEqual(original);
    expect((await fs.readdir(root)).some(name => name.includes(".mason-"))).toBe(false);
  });
  it("uses ZDOTDIR and preserves a symlinked profile", async () => {
    const config = path.join(root, "zsh"), target = path.join(root, "dotfile");
    await fs.mkdir(config); await fs.writeFile(target, "# linked settings\n");
    const link = path.join(config, ".zshrc"); await fs.symlink(target, link);
    await configurePath(bin, [], save, { ...options("zsh"), env: { SHELL: "/bin/zsh", ZDOTDIR: config } });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fs.readFile(target, "utf8")).startsWith("# linked settings\n")).toBe(true);
    expect(await removePath(changes)).toEqual([]);
    expect(await fs.readFile(link, "utf8")).toBe("# linked settings\n");
  });
  it("retains an edited managed block on uninstall and does not duplicate it on upgrade", async () => {
    await configurePath(bin, [], save, options());
    const file = path.join(root, ".bashrc");
    const edited = (await fs.readFile(file, "utf8")).replace("export PATH", "export CUSTOM_PATH");
    await fs.writeFile(file, edited);
    expect((await configurePath(bin, changes, save, options())).status).toBe("manual");
    expect(await fs.readFile(file, "utf8")).toBe(edited);
    expect((await removePath(changes)).join()).toContain("edited");
    expect(await fs.readFile(file, "utf8")).toBe(edited);
  });
  it("resumes after the ownership intent was recorded before a profile write", async () => {
    await configurePath(bin, [], save, options());
    for (const change of changes) if (change.kind === "profile") await fs.writeFile(change.file, "");
    expect((await configurePath(bin, changes, save, options())).status).toBe("configured");
    expect(changes).toHaveLength(2);
    expect((await fs.readFile(path.join(root, ".bashrc"), "utf8")).split("# >>> mason PATH")).toHaveLength(2);
    expect(await removePath(changes)).toEqual([]);
  });
  it("respects an explicit profile without changing default shell files", async () => {
    const file = path.join(root, "custom/profile");
    await configurePath(bin, [], save, { ...options(), env: { SHELL: "/bin/bash", MASON_PROFILE: file } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "profile", file });
    await expect(fs.stat(path.join(root, ".bashrc"))).rejects.toThrow();
  });
  it("keeps unsupported shells and opt-out installs explicit", async () => {
    expect((await configurePath(bin, [], save, options("fish"))).status).toBe("manual");
    expect((await configurePath(bin, [], save, { ...options(), env: { MASON_NO_MODIFY_PATH: "1" } })).status).toBe("manual");
    expect(changes).toEqual([]);
  });
  it("keeps an unreadable profile or invalid PATH component out of claimed success", async () => {
    await fs.mkdir(path.join(root, ".bashrc"));
    expect((await configurePath(bin, [], save, options())).status).toBe("manual");
    expect((await configurePath(bin + ":unsafe", [], save, options())).status).toBe("manual");
    expect(changes).toEqual([]);
  });
  it("does not rewrite non-UTF8 shell settings", async () => {
    const file = path.join(root, ".bashrc"), original = Buffer.from([0xff, 0xfe, 0x00]);
    await fs.writeFile(file, original);
    expect((await configurePath(bin, [], save, options())).status).toBe("manual");
    expect(await fs.readFile(file)).toEqual(original);
    expect(changes).toEqual([]);
  });
  it("recognizes equivalent Windows PATH entries without rewriting their spelling", () => {
    expect(hasWindowsEntry('C:\\Other;"C:/Users/Test/Bin/"', "c:\\users\\test\\bin")).toBe(true);
    expect(hasWindowsEntry("C:\\Mason-old", "C:\\Mason")).toBe(false);
    expect(hasWindowsEntry(null, "C:\\Mason")).toBe(false);
    expect(hasWindowsEntry('%USERPROFILE%/Tools', 'C:\\User\\Tools', { USERPROFILE: 'C:\\User' })).toBe(true);
  });
  if (process.platform !== "win32") it("lets a fresh interactive Bash find Mason without a manual export or duplicate PATH entries", async () => {
    await configurePath(bin, [], save, options());
    const file = path.join(root, ".bashrc");
    const output = execFileSync("/bin/bash", ["--noprofile", "--rcfile", file, "-ic", 'mason; . "$1"; printf "%s\\n" "$PATH"', "test", file],
      { env: { ...process.env, PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(output.split("\n")[0]).toBe("fixture-mason");
    expect(output.split("\n")[1].split(":").filter(p => p === bin)).toHaveLength(1);
  });
  if (process.platform === "win32") it("updates Windows user PATH without losing other entries and removes only its addition", async () => {
    const before = await windowsPath("read"), other = path.join(root, "other user program");
    try {
      expect((await configurePath(bin, [], save)).status).toBe("configured");
      const owned = structuredClone(changes);
      const installed = await windowsPath("read");
      expect(installed.value).toBe(bin + (before.value ? ";" + before.value : ""));
      await configurePath(bin, changes, save);
      expect(await windowsPath("read")).toEqual(installed);
      const preexisting: PathChange[] = [];
      await configurePath(bin, [], async c => { preexisting.push(...c); });
      expect(preexisting).toEqual([]);
      await windowsPath("add", other, installed);
      expect(await removePath(owned)).toEqual([]);
      const after = await windowsPath("read");
      expect(hasWindowsEntry(after.value, bin)).toBe(false);
      expect(hasWindowsEntry(after.value, other)).toBe(true);
      expect(after.kind).toBe(before.kind ?? "ExpandString");
    } finally {
      await windowsPath("remove", bin, undefined, before.value === null);
      await windowsPath("remove", other, undefined, before.value === null);
    }
    expect(await windowsPath("read")).toEqual(before);
  }, 60000);
});
