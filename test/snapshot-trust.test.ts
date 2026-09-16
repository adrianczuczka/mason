import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as fileAccess from "../src/utils/files.js";
import * as snapshotReview from "../src/snapshot/review.js";
import { getContext, getSnapshot, saveSnapshotData, saveVerification } from "../src/mcp/tools.js";
import { createSnapshotTrustReader } from "../src/snapshot/trust.js";
import { initGitRepo, commitAll } from "./helpers.js";
import { prepareVerdicts } from "./snapshot-helpers.js";

describe("snapshot verification evidence on retrieval", () => {
  let repo: string;
  const original = "export const greeting = 'original';\n";
  const edited = "export const greeting = 'reviewed edit';\n";
  const features = { greeting: { description: "Greeting", files: ["src/a.js"] } };
  const flows = { "greeting flow": { description: "Greeting flow", chain: ["src/a.js"] } };
  const source = () => path.join(repo, "src/a.js");
  const snapshotFile = () => path.join(repo, ".mason/snapshot.json");
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "mason-snapshot-trust-"));
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "src"));
    await fs.writeFile(source(), original);
    await fs.writeFile(path.join(repo, ".gitignore"), ".mason/\n");
    await commitAll(repo, "source");
    await saveSnapshotData(repo, structuredClone(features), structuredClone(flows));
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(repo, { recursive: true, force: true }); });

  async function verify(ok = true) {
    const verdict = { ok, ...(ok ? {} : { note: "Description does not match the implementation" }) };
    await saveVerification(repo, await prepareVerdicts(repo, { greeting: verdict, "greeting flow": verdict }));
  }
  async function readings() {
    const snapshot = JSON.parse(await getSnapshot(repo));
    const matched = JSON.parse(await getContext(repo, "greeting"));
    const fallback = JSON.parse(await getContext(repo, "zzzxxyy"));
    return [
      { trust: snapshot.trust, hint: snapshot.hint },
      { trust: { features: { greeting: matched.features.greeting.trust }, flows: { "greeting flow": matched.flows["greeting flow"].trust } }, hint: matched.hint },
      { trust: fallback.trust, hint: fallback.hint },
    ];
  }

  it("reports stale verification after a reviewed local edit is reverted to a clean checkout", async () => {
    await fs.writeFile(source(), edited);
    await verify();
    const saved = await fs.readFile(snapshotFile(), "utf8");
    await fs.writeFile(source(), original);
    for (const result of await readings()) {
      for (const trust of [result.trust.features.greeting, result.trust.flows["greeting flow"]]) {
        expect(trust).toMatchObject({ freshness: "current", verification: "stale", recordedVerdict: "passed", verifiedAt: expect.any(String) });
      }
      expect(result.hint).toMatch(/verification evidence changed/i);
      expect(result.hint).not.toMatch(/No changes detected/);
    }
    expect(await fs.readFile(snapshotFile(), "utf8")).toBe(saved);
  });

  it("revalidates restored evidence without a new verdict or a cache from an earlier call", async () => {
    await verify();
    await fs.writeFile(source(), edited);
    expect(JSON.parse(await getSnapshot(repo)).trust.features.greeting.verification).toBe("stale");
    await fs.writeFile(source(), original);
    await fs.writeFile(path.join(repo, "README.md"), "An unrelated commit");
    await commitAll(repo, "docs");
    for (const result of await readings()) {
      expect(result.trust.features.greeting).toMatchObject({ freshness: "current", verification: "passed", recordedVerdict: "passed" });
    }
  });

  it.each(["changed", "missing"])("retains the historical failure and reason when evidence is %s", async state => {
    await verify(false);
    if (state === "changed") await fs.writeFile(source(), edited);
    else await fs.unlink(source());
    for (const result of await readings()) {
      const trust = result.trust.features.greeting;
      expect(trust).toMatchObject({ verification: state === "changed" ? "stale" : "unknown", recordedVerdict: "failed" });
      expect(trust.reasons.join(" ")).toContain("Description does not match the implementation");
      expect(result.hint).toMatch(/Verification failed/);
    }
  });

  it.each(["excluded", "oversized", "empty anchors"])("does not confirm a verdict with %s evidence", async state => {
    if (state === "empty anchors") await saveSnapshotData(repo, { greeting: { description: "Greeting", files: [] } }, {});
    await verify();
    if (state === "excluded") await fs.writeFile(path.join(repo, ".mason/config.json"), JSON.stringify({ ignore: ["src/a.js"] }));
    if (state === "oversized") await fs.writeFile(source(), "x".repeat(fileAccess.MAX_SOURCE_BYTES + 1));
    expect(JSON.parse(await getSnapshot(repo)).trust.features.greeting).toMatchObject({ verification: "unknown", recordedVerdict: "passed" });
  });

  it("keeps matching unavailable-file markers unknown", async () => {
    await fs.unlink(source());
    await verify(false);
    expect(JSON.parse(await getSnapshot(repo)).trust.features.greeting).toMatchObject({ verification: "unknown", recordedVerdict: "failed" });
  });

  it.each([undefined, "unsupported-token"])("treats legacy or malformed tokens (%s) as unknown without losing the verdict", async token => {
    await verify();
    const snapshot = JSON.parse(await fs.readFile(snapshotFile(), "utf8"));
    snapshot.features.greeting.verificationToken = token;
    await fs.writeFile(snapshotFile(), JSON.stringify(snapshot));
    expect(JSON.parse(await getSnapshot(repo)).trust.features.greeting).toMatchObject({ verification: "unknown", recordedVerdict: "passed" });
  });

  it("keeps never-reviewed entries unverified and shares source reads only within each retrieval", async () => {
    expect(JSON.parse(await getSnapshot(repo)).trust.features.greeting.verification).toBe("unverified");
    await verify();
    const create = fileAccess.createFileAccess;
    const reads: string[] = [];
    vi.spyOn(fileAccess, "createFileAccess").mockImplementation(async root => {
      const access = await create(root);
      return { ...access, read: async file => { reads.push(file); return access.read(file); } };
    });
    await getSnapshot(repo);
    expect(reads.filter(file => file === "src/a.js")).toHaveLength(1);
    await getSnapshot(repo);
    expect(reads.filter(file => file === "src/a.js")).toHaveLength(2);
  });

  it("does not validate entries omitted from matched context", async () => {
    await saveSnapshotData(repo, { unrelated: { description: "Unrelated", files: ["src/b.js"] } }, {});
    await fs.writeFile(path.join(repo, "src/b.js"), "export const billing = true;");
    await saveVerification(repo, await prepareVerdicts(repo, { unrelated: { ok: true } }));
    const create = snapshotReview.createSnapshotEvidenceReader;
    const reads: string[] = [];
    vi.spyOn(snapshotReview, "createSnapshotEvidenceReader").mockImplementation(access => {
      const read = create(access);
      return async (kind, name, entry) => { reads.push(name); return read(kind, name, entry); };
    });
    await getContext(repo, "greeting");
    expect(reads).not.toContain("unrelated");
  });

  it("checks full sampled contents beyond previews while keeping the documented sampling limit", async () => {
    const files = Array.from({ length: 9 }, (_, i) => `src/sample-${i}.js`);
    const content = "// " + "x".repeat(600) + "\nexport const value = 1;\n";
    for (const file of files) await fs.writeFile(path.join(repo, file), content);
    await commitAll(repo, "samples");
    await saveSnapshotData(repo, { greeting: { description: "Greeting", files } }, {});
    await verify();
    await fs.writeFile(path.join(repo, files[0]), content + "export const changed = true;\n");
    expect(JSON.parse(await getSnapshot(repo)).trust.features.greeting.verification).toBe("stale");
    await fs.writeFile(path.join(repo, files[0]), content);
    await fs.writeFile(path.join(repo, files[8]), "// outside verification sample\n");
    expect(JSON.parse(await getSnapshot(repo)).trust.features.greeting).toMatchObject({ freshness: "changed", verification: "passed" });
  });

  it("reports unavailable verification evidence if the verifier cannot initialize its file policy", async () => {
    await verify();
    const snapshot = JSON.parse(await fs.readFile(snapshotFile(), "utf8"));
    vi.spyOn(fileAccess, "createFileAccess").mockRejectedValue(new Error("file policy unavailable"));
    const trust = await createSnapshotTrustReader(repo)("feature", "greeting", snapshot.features.greeting, "current");
    expect(trust).toMatchObject({ verification: "unknown", recordedVerdict: "passed" });
  });
});
