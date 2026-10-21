import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFileAccess } from "../utils/files.js";
import { anchorMatches } from "../utils/paths.js";
import {
  decisionApproval,
  effectiveDecision,
  latestDecisionInspection,
  type DecisionRecord,
} from "./provenance.js";

const exec = promisify(execFile);
const MAX_DIFFED_FILES = 8;
const MAX_SHOWN_FILES = 3;
const MAX_SHOWN_HUNKS = 2;
const MAX_HUNK_LINES = 8;
const HISTORY_DEPTH = 20;

/** The capture that drift compares against: the latest valid inspection, else the save capture. */
export function driftBaseline(record: DecisionRecord) {
  const effective = effectiveDecision(record);
  const inspection = latestDecisionInspection(
    record,
    decisionApproval(effective) === "accepted" ? "operative" : "all",
  );
  return {
    record: effective,
    capture: inspection?.capture ?? (effective.version === 2 ? effective.capture : undefined),
    commits: [inspection?.headHash, effective.refreshedHash].filter(
      (hash): hash is string => !!hash && /^[a-f0-9]{40,64}$/.test(hash),
    ),
  };
}

interface Hunk {
  header: string;
  lines: string[];
}
export interface DriftExcerpt {
  /** Identifiers named by the decision that appear in changed lines or enclosing declarations. */
  mentions: string[];
  /** `low` only when the decision names identifiers and every changed file was diffed
   * against its exact captured content without mentioning them. */
  relevance: "mentioned" | "low" | "unknown";
  unknownReason?: "no-identifiers" | "incomplete";
  files: Array<{ path: string; hunks: Hunk[]; omittedHunks: number; unavailable?: string }>;
  omittedFiles: string[];
}

/** Find a commit whose copy of the file has exactly the captured bytes, in one Git process. */
async function capturedCommit(root: string, file: string, hash: string, preferred: string[]) {
  if (/[\n\r]/.test(file)) return null;
  const { stdout } = await exec(
    "git",
    ["--literal-pathspecs", "log", "-n", String(HISTORY_DEPTH), "--format=%H", "--", file],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  const commits = [...new Set([...preferred, ...stdout.split("\n").filter(Boolean)])];
  const batch = exec("git", ["cat-file", "--batch"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  batch.child.stdin!.end(commits.map((commit) => `${commit}:${file}\n`).join(""));
  const output = (await batch).stdout;
  let position = 0;
  for (const commit of commits) {
    const end = output.indexOf(10, position);
    if (end < 0) break;
    const header = output.subarray(position, end).toString("utf8").split(" ");
    position = end + 1;
    if (header[1] !== "blob") continue;
    const size = Number(header[2]);
    const bytes = output.subarray(position, position + size);
    position += size + 1;
    if (createHash("sha256").update(bytes).digest("hex") === hash) return commit;
  }
  return null;
}

/** Code identifiers a decision names: backticked spans, calls, camelCase, snake_case and
 * backticked kebab-case. Ordinary prose is excluded because it overlaps with nearly any change. */
export function namedIdentifiers(text: string): string[] {
  const names = new Set<string>();
  const add = (name: string) => {
    if (name.length >= 3) names.add(name);
  };
  for (const [, span] of text.matchAll(/`([^`]+)`/g))
    for (const [name] of span.matchAll(/[A-Za-z_$][\w$]*(?:-[A-Za-z0-9_$]+)*/g)) add(name);
  for (const [, name] of text.matchAll(/([A-Za-z_$][\w$]*)\(/g)) add(name);
  // Hyphenated prose ("opt-in", "draft-only") is not code; kebab-case names count in backticks.
  for (const [name] of text.matchAll(/[A-Za-z_$][\w$]*/g))
    if (/[a-z][A-Z]|[_$]/.test(name)) add(name);
  return [...names];
}

/** Lowercase identifiers in code, with their camelCase and snake_case parts. */
function codeTokens(code: string): Set<string> {
  const tokens = new Set<string>();
  for (const [name] of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    tokens.add(name.toLowerCase());
    for (const part of name.split(/_+|(?<=[a-z0-9])(?=[A-Z])/))
      if (part.length >= 3) tokens.add(part.toLowerCase());
  }
  return tokens;
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) hunks.push({ header: line, lines: [] });
    else if (hunks.length && /^[+-]/.test(line)) hunks.at(-1)!.lines.push(line);
  }
  return hunks;
}

/** Bounded changed hunks for the drifted anchor files, against the exact captured content.
 * Relevance matches identifiers the decision names against changed code; it never establishes
 * consistency and never replaces source inspection. */
export async function driftExcerpt(
  root: string,
  record: DecisionRecord,
  changedFiles: string[],
): Promise<DriftExcerpt> {
  const baseline = driftBaseline(record);
  const excerpt: DriftExcerpt = { mentions: [], relevance: "unknown", files: [], omittedFiles: [] };
  const named = namedIdentifiers(`${baseline.record.title}\n${baseline.record.body}`);
  const found = new Set<string>();
  let complete = !!baseline.capture && changedFiles.length <= MAX_DIFFED_FILES;
  const access = await createFileAccess(root);
  for (const [index, file] of changedFiles.slice(0, MAX_DIFFED_FILES).entries()) {
    let hunks: Hunk[] | null = null;
    let unavailable: string | undefined;
    const captured = baseline.capture?.files[file];
    try {
      if (!baseline.capture?.anchors.some((anchor) => anchorMatches(anchor, file))) {
        unavailable = "not in the captured anchor scope";
      } else if (captured === undefined) {
        // Added since capture: every current line is new.
        const source = await access.read(file);
        if (source)
          hunks = [
            {
              header: "(added since capture)",
              lines: source.content
                .replace(/\r?\n$/, "")
                .split("\n")
                .map((line) => "+" + line),
            },
          ];
        else unavailable = "added since capture but unreadable";
      } else {
        const commit = await capturedCommit(root, file, captured, baseline.commits);
        if (!commit) unavailable = "captured content is not in recent Git history";
        else {
          const { stdout } = await exec(
            "git",
            [
              "--literal-pathspecs",
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--no-renames",
              "-U0",
              commit,
              "--",
              file,
            ],
            { cwd: root, maxBuffer: 1024 * 1024 },
          );
          hunks = parseHunks(stdout);
        }
      }
    } catch {
      unavailable = "diff could not be read within its bounds";
    }
    // Binary and mode-only changes have no hunks to compare, so they cannot be low relevance.
    if (!hunks?.length) complete = false;
    const code = (hunks ?? [])
      .map((hunk) => [hunk.header, ...hunk.lines.map((line) => line.slice(1))].join("\n"))
      .join("\n");
    const tokens = codeTokens(code);
    for (const name of named)
      if (
        name.includes("-")
          ? code.toLowerCase().includes(name.toLowerCase())
          : tokens.has(name.toLowerCase())
      )
        found.add(name);
    if (index >= MAX_SHOWN_FILES) excerpt.omittedFiles.push(file);
    else
      excerpt.files.push({
        path: file,
        hunks: (hunks ?? [])
          .slice(0, MAX_SHOWN_HUNKS)
          .map((hunk) => ({ ...hunk, lines: hunk.lines.slice(0, MAX_HUNK_LINES) })),
        omittedHunks: Math.max(0, (hunks?.length ?? 0) - MAX_SHOWN_HUNKS),
        ...(unavailable ? { unavailable } : {}),
      });
  }
  excerpt.omittedFiles.push(...changedFiles.slice(MAX_DIFFED_FILES));
  excerpt.mentions = [...found].sort();
  excerpt.relevance = found.size ? "mentioned" : complete && named.length ? "low" : "unknown";
  if (excerpt.relevance === "unknown")
    excerpt.unknownReason = named.length ? "incomplete" : "no-identifiers";
  return excerpt;
}

export function formatDriftExcerpt(title: string, id: string, excerpt: DriftExcerpt): string {
  const safe = (value: string, max = 160) =>
    value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max);
  const lines = [`Changed lines for decision ${JSON.stringify(safe(title, 250))} (${safe(id)}):`];
  lines.push(
    excerpt.relevance === "mentioned"
      ? `  Changed lines mention identifiers named by the decision: ${excerpt.mentions.map((name) => safe(name, 60)).join(", ")}.`
      : excerpt.relevance === "low"
        ? "  Low relevance: no changed line or enclosing declaration mentions an identifier named by the decision. This is a name match, not evidence of consistency; inspect before recording."
        : excerpt.unknownReason === "no-identifiers"
          ? "  Relevance not assessed: the decision names no code identifiers (such as `refresh()` or onRefresh) to match against the changes."
          : "  Relevance unknown: some changed content could not be compared with its captured version.",
  );
  for (const file of excerpt.files) {
    if (file.unavailable) {
      lines.push(`  ${safe(file.path)}: ${file.unavailable}.`);
      continue;
    }
    for (const hunk of file.hunks)
      lines.push(
        `  ${safe(file.path)} ${safe(hunk.header, 120)}`,
        ...hunk.lines.map((line) => "    " + safe(line)),
      );
    if (!file.hunks.length) lines.push(`  ${safe(file.path)}: changed without text hunks.`);
    if (file.omittedHunks) lines.push(`  ${safe(file.path)}: ${file.omittedHunks} more hunk(s).`);
  }
  if (excerpt.omittedFiles.length)
    lines.push(`  ${excerpt.omittedFiles.length} more changed file(s) not shown.`);
  return lines.join("\n");
}
