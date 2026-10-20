import fs from "node:fs/promises";
import { readBoundedFile } from "../utils/files.js";
import { decisionSchema } from "./provenance.js";

export const MERGE_DRIVER_NAME = "mason-decision";
export const MERGE_ATTRIBUTE = `.mason/decisions/*.json merge=${MERGE_DRIVER_NAME}`;
/** A refused or unavailable semantic merge falls back to Git's ordinary text conflict.
 * Git keeps %A unchanged when a driver fails, so the fallback must write the markers. */
export const MERGE_DRIVER_COMMAND =
  "mason merge-decision %O %A %B %L %P || git merge-file --marker-size=%L -L ours -L base -L theirs %A %O %B";

/** Inspections and review history only grow; each side may append to the common prefix. */
const APPEND_ONLY = new Set(["history", "inspections"]);

export type DecisionMerge =
  { status: "merged"; text: string } | { status: "conflict"; reason: string };

const canonical = (value: unknown): string | undefined =>
  JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

function appendOnly(base: unknown, ours: unknown, theirs: unknown): unknown[] | null | undefined {
  if (base === undefined && ours === undefined && theirs === undefined) return undefined;
  const lists = [base ?? [], ours ?? [], theirs ?? []];
  if (!lists.every(Array.isArray)) return null;
  const [common, current, incoming] = lists as unknown[][];
  const extendsCommon = (list: unknown[]) =>
    list.length >= common.length &&
    common.every((entry, i) => canonical(entry) === canonical(list[i]));
  if (!extendsCommon(current) || !extendsCommon(incoming)) return null;
  const added = new Map<string, unknown>();
  for (const entry of [...current.slice(common.length), ...incoming.slice(common.length)])
    added.set(canonical(entry)!, entry);
  const at = (entry: unknown) => String((entry as { at?: unknown }).at ?? "");
  // Sort by time, then content, so merging in either direction gives identical bytes.
  const appended = [...added].sort(([a, x], [b, y]) =>
    at(x) < at(y) ? -1 : at(x) > at(y) ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
  return [...common, ...appended.map(([, entry]) => entry)];
}

/** Three-way merge of one decision record. Both sides and the result must be valid records;
 * anything a person should decide (two revisions, two verdicts) is returned as a conflict. */
export function mergeDecisionRecords(
  baseText: string,
  oursText: string,
  theirsText: string,
  expectedId?: string,
): DecisionMerge {
  const conflict = (reason: string): DecisionMerge => ({ status: "conflict", reason });
  let parsed: unknown[];
  try {
    parsed = [baseText, oursText, theirsText].map((text) => JSON.parse(text) as unknown);
  } catch {
    return conflict("a version is not valid JSON");
  }
  if (!parsed.every((value) => value && typeof value === "object" && !Array.isArray(value)))
    return conflict("a version is not a JSON object");
  const [base, ours, theirs] = parsed as Record<string, unknown>[];
  for (const [label, side] of [
    ["current", ours],
    ["incoming", theirs],
  ] as const)
    if (!decisionSchema.safeParse(side).success)
      return conflict(`the ${label} version is not a valid decision record`);

  const merged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)])) {
    if (APPEND_ONLY.has(key)) {
      const list = appendOnly(base[key], ours[key], theirs[key]);
      if (list === null) return conflict(`${key} on one side does not extend the common version`);
      if (list !== undefined) merged[key] = list;
      continue;
    }
    const [b, o, t] = [base[key], ours[key], theirs[key]].map(canonical);
    if (o !== t && o !== b && t !== b) return conflict(`both sides changed ${key}`);
    // Take the side that changed the field; unchanged or identical sides agree.
    const value = o === b ? theirs[key] : ours[key];
    if (value !== undefined) merged[key] = value;
  }
  const result = decisionSchema.safeParse(merged);
  if (!result.success)
    return conflict(`the combined record is invalid: ${result.error.issues[0].message}`);
  if (expectedId !== undefined && result.data.id !== expectedId)
    return conflict("the record id does not match its file name");
  return { status: "merged", text: JSON.stringify(result.data, null, 2) + "\n" };
}

/** `mason merge-decision <base> <current> <incoming> [marker-size] [path]`: exit 0 after
 * writing the merge to <current>, or 1 leaving it untouched for Git's text fallback. */
export async function runDecisionMerge(args: string[]): Promise<number> {
  const [basePath, oursPath, theirsPath, , pathname] = args;
  if (!basePath || !oursPath || !theirsPath || args.length > 5)
    throw new Error(
      "Usage: mason merge-decision <base> <current> <incoming> [marker-size] [path]. Git runs this through the merge driver that mason setup configures.",
    );
  const read = async (file: string) => {
    const text = await readBoundedFile(file, 10 * 1024 * 1024);
    if (text === null) throw new Error(`${file} is not a regular file or exceeds 10 MiB`);
    return text;
  };
  const id = pathname && /(?:^|\/)\.mason\/decisions\/([^/]+)\.json$/.exec(pathname)?.[1];
  const result = mergeDecisionRecords(
    await read(basePath),
    await read(oursPath),
    await read(theirsPath),
    id || undefined,
  );
  if (result.status === "conflict") {
    console.error(
      `Mason: ${pathname || "decision record"}: ${result.reason}; leaving it to Git's text merge.`,
    );
    return 1;
  }
  await fs.writeFile(oursPath, result.text, "utf8");
  return 0;
}
