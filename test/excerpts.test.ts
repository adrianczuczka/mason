import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commitAll, initGitRepo } from "./helpers.js";
import { loadDecisions, upsertDecision } from "../src/decisions/decisions.js";
import { computeDecisionDrift } from "../src/decisions/drift.js";
import { reviewDecision } from "../src/decisions/review.js";
import { driftExcerpt, formatDriftExcerpt, namedIdentifiers } from "../src/decisions/excerpts.js";

const source = `fun refresh(force: Boolean) {
  if (ready()) notifyListener(payload)
}

fun label(): String {
  // Formats a label.
  return "label"
}
`;
let root: string;
const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text);
const edit = async (from: string, to: string, file = "src/Repo.kt") =>
  write(file, (await fs.readFile(path.join(root, file), "utf8")).replace(from, to));
async function decide(files = ["src/Repo.kt"]) {
  await upsertDecision(root, {
    title: "Notify the listener after refresh succeeds",
    body: "refresh() calls notifyListener only after the ready() guard passes; the payload carries the new items.",
    category: "decision",
    files,
  });
  return (await loadDecisions(root))[0];
}
async function excerpt() {
  const record = (await loadDecisions(root))[0];
  const changed = (await computeDecisionDrift(root)).staleDecisions[record.id] ?? [];
  return driftExcerpt(root, record, changed);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mason-excerpts-"));
  await initGitRepo(root);
  await fs.mkdir(path.join(root, "src"));
  await write("src/Repo.kt", source);
  await commitAll(root, "initial");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("decision drift excerpts", () => {
  it("shows the changed lines and labels edits that never mention the decision as low relevance", async () => {
    const record = await decide();
    await commitAll(root, "decision");
    await edit("// Formats a label.", "// Builds the display label.");
    await commitAll(root, "reword comment");
    const result = await excerpt();
    expect(result).toMatchObject({ relevance: "low", mentions: [] });
    expect(result.files[0].hunks[0]).toMatchObject({
      header: expect.stringContaining("fun label()"),
      lines: ["-  // Formats a label.", "+  // Builds the display label."],
    });
    const text = formatDriftExcerpt(record.title, record.id, result);
    expect(text).toContain("Low relevance");
    expect(text).toContain("not evidence of consistency");
    expect(text).toContain("+  // Builds the display label.");
  });

  it("matches only code identifiers the decision names, not its prose", async () => {
    expect(
      namedIdentifiers(
        'Use `review_decision(action: "prepare")` before refresh() calls notifyListener; keep `mason-drift` output stable for the opt-in payload.',
      ).sort(),
    ).toEqual(["action", "mason-drift", "notifyListener", "prepare", "refresh", "review_decision"]);
    await decide();
    await commitAll(root, "decision");
    await edit("notifyListener(payload)", "notifyListener(payload, cached)");
    // The enclosing declaration counts: this hunk sits inside refresh().
    expect(await excerpt()).toMatchObject({
      relevance: "mentioned",
      mentions: ["notifyListener", "ready", "refresh"],
    });
  });

  it("does not assess relevance when the decision names no identifiers", async () => {
    await upsertDecision(root, {
      title: "Keep labels short",
      body: "Labels shown to people stay brief.",
      category: "decision",
      files: ["src/Repo.kt"],
    });
    await commitAll(root, "decision");
    await edit("// Formats a label.", "// Builds the display label.");
    const result = await excerpt();
    expect(result).toMatchObject({ relevance: "unknown", unknownReason: "no-identifiers" });
    expect(formatDriftExcerpt("t", "id", result)).toContain("Relevance not assessed");
  });

  it("diffs against the latest inspection rather than the original capture", async () => {
    await decide();
    await commitAll(root, "decision");
    await edit("notifyListener(payload)", "notifyListener(payload, cached)");
    await commitAll(root, "first change");
    const id = (await loadDecisions(root))[0].id;
    const prepared = await reviewDecision(root, { id });
    await reviewDecision(root, {
      id,
      action: "inspect",
      inspector: "Fixture agent",
      note: "The listener still waits for the ready guard.",
      reviewToken: prepared.reviewToken,
    });
    await edit("// Formats a label.", "// Builds the display label.");
    const result = await excerpt();
    expect(result.files[0].hunks.flatMap((hunk) => hunk.lines)).toEqual([
      "-  // Formats a label.",
      "+  // Builds the display label.",
    ]);
    expect(result.relevance).toBe("low");
  });

  it("shows added files and stays unknown when captured content is not in Git history", async () => {
    await decide(["src"]);
    await write("src/Helper.kt", "fun helper() = 1\n");
    const added = await excerpt();
    expect(added.files[0]).toMatchObject({
      path: "src/Helper.kt",
      hunks: [{ header: "(added since capture)", lines: ["+fun helper() = 1"] }],
    });

    // A capture of uncommitted content has no commit to diff against.
    await fs.rm(path.join(root, ".mason"), { recursive: true });
    await fs.rm(path.join(root, "src/Helper.kt"));
    await edit("// Formats a label.", "// Uncommitted wording.");
    await decide();
    await edit("// Uncommitted wording.", "// Later wording.");
    const unknown = await excerpt();
    expect(unknown.relevance).toBe("unknown");
    expect(unknown.files[0].unavailable).toBe("captured content is not in recent Git history");
    expect(formatDriftExcerpt("t", "id", unknown)).toContain("Relevance unknown");
  });
});
