import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  template,
  forkFixture,
  replay,
  grade,
  referenceSource,
  delegatedSource,
} from "../bench/harness/knowledge/cancellation-lifecycle.mjs";

it("matches reviewed facts across arms and rejects behavioral, ownership and receipt mutations", async () => {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mason-cancellation-grade-test-")),
  );
  const options = {
    binary: path.resolve("dist/mason.js"),
    observer: fileURLToPath(
      new URL("../bench/harness/knowledge/observe-cancellation-hook.mjs", import.meta.url),
    ),
    hookLog: path.join(temp, "hooks.jsonl"),
  };
  try {
    const seed = await template(
      path.join(temp, "seed"),
      "accepted",
      path.resolve("dist/mason-mcp.js"),
    );
    const root = path.join(temp, "notes");
    const initial = await forkFixture(seed, root, "notes", options);
    const masonRoot = path.join(temp, "mason");
    const mason = await forkFixture(seed, masonRoot, "mason", options);
    for (const file of [
      "operation.mjs",
      "managed.mjs",
      "requirements.md",
      "ownership.md",
      "incident.md",
      "check.mjs",
    ])
      expect(initial.files[file]).toBe(mason.files[file]);
    expect(JSON.parse(initial.files["PROJECT_NOTES_REVIEW.json"])).toEqual(seed.knowledge[0]);
    await replay(masonRoot, "accepted");
    expect((await grade(masonRoot, mason, { ok: true })).pass).toBe(true);
    const decisionFile = Object.keys(mason.files).find((file) =>
      file.startsWith(".mason/decisions/"),
    )!;
    const tampered = JSON.parse(mason.files[decisionFile]);
    tampered.body = "Invented approval and guidance";
    await fs.writeFile(path.join(masonRoot, decisionFile), JSON.stringify(tampered));
    expect((await grade(masonRoot, mason, { ok: true })).failures).toContain(
      "knowledge/review history changed without witnessed inspection",
    );
    await fs.writeFile(path.join(masonRoot, decisionFile), mason.files[decisionFile]);
    await replay(root, "accepted");
    expect((await grade(root, initial, { ok: true })).pass).toBe(true);
    await fs.writeFile(path.join(root, "operation.mjs"), referenceSource("once-only"));
    expect((await grade(root, initial, { ok: true })).pass).toBe(false);
    await fs.writeFile(path.join(root, "operation.mjs"), referenceSource("finally-cleanup"));
    expect((await grade(root, initial, { ok: true })).failures).toContain(
      "current managed ownership not used for every operation",
    );
    await fs.writeFile(path.join(root, "operation.mjs"), delegatedSource);
    await fs.writeFile(path.join(root, "PROJECT_NOTES_REVIEW.json"), "{}\n");
    expect((await grade(root, initial, { ok: true })).failures).toContain(
      "protected or unexpected change: PROJECT_NOTES_REVIEW.json",
    );
    await fs.writeFile(
      path.join(root, "PROJECT_NOTES_REVIEW.json"),
      initial.files["PROJECT_NOTES_REVIEW.json"],
    );
    await fs.writeFile(
      path.join(root, "managed.mjs"),
      initial.files["managed.mjs"] + "// changed\n",
    );
    expect((await grade(root, initial, { ok: true })).failures).toContain(
      "protected or unexpected change: managed.mjs",
    );
    await fs.writeFile(path.join(root, "managed.mjs"), initial.files["managed.mjs"]);
    expect((await grade(root, initial, { ok: false })).failures).toContain("session incomplete");
    await fs.writeFile(path.join(root, "greeting.txt"), "welcome\n");
    expect(
      (await grade(root, { ...initial, scenario: "unrelated" }, { ok: true })).failures,
    ).toContain("protected or unexpected change: operation.mjs");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}, 30000);
