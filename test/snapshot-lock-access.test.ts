import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withStoreLock } from "../src/utils/store-lock.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-lock-access-"));
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it("retries a Windows delete-pending lock without running an unprotected write", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const denied = Object.assign(new Error("delete pending"), { code: "EPERM" });
  const open = vi.spyOn(fs, "open").mockRejectedValueOnce(denied);
  const write = vi.fn(async () => {
    const owner = JSON.parse(
      await fs.readFile(path.join(root, ".mason/local/test-lock/lock"), "utf8"),
    );
    expect(owner.pid).toBe(process.pid);
    return "saved";
  });
  expect(await withStoreLock(root, ".mason/local/test-lock", write)).toBe("saved");
  expect(open).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledTimes(1);
});

it.each(["win32", "linux"])(
  "preserves persistent access failures on %s without writing",
  async (current) => {
    Object.defineProperty(process, "platform", { value: current });
    const denied = Object.assign(new Error("access denied"), { code: "EPERM" });
    vi.spyOn(fs, "open").mockRejectedValue(denied);
    const write = vi.fn();
    await expect(withStoreLock(root, ".mason/local/test-lock", write, 0)).rejects.toBe(denied);
    expect(write).not.toHaveBeenCalled();
  },
);

it("does not retry owner-record write failures as lock contention", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const denied = Object.assign(new Error("owner write denied"), { code: "EPERM" });
  const original = fs.open.bind(fs);
  const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    vi.spyOn(handle, "writeFile").mockRejectedValueOnce(denied);
    return handle;
  });
  const write = vi.fn();
  await expect(withStoreLock(root, ".mason/local/test-lock", write)).rejects.toBe(denied);
  expect(open).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(root, ".mason/local/test-lock/lock"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
