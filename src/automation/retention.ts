import fs from "node:fs/promises";
import path from "node:path";
import { readStoreJson, storePath } from "../utils/storage.js";

export const RETAINED_CHECK_REPORTS = 100;
/** Scan only once this many accumulate, so most hook writes skip the directory listing. */
export const CHECK_REPORT_PRUNE_THRESHOLD = 150;
const REPORT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.json$/;

/**
 * Hooks write a check report whenever they notify, so a long-lived checkout accumulates
 * thousands. Notices link to recent reports; older ones are not read again. Keep the newest
 * reports and every report still named by automation state or a setup receipt. Original
 * repair baselines live outside this directory and are never touched.
 */
export async function pruneCheckReports(
  root: string,
  directory: string,
  referenced: Array<string | null | undefined>,
): Promise<number> {
  const checks = directory + "/checks";
  let entries;
  try {
    entries = await fs.readdir(await storePath(root, checks), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const reports = entries.filter((entry) => entry.isFile() && REPORT_NAME.test(entry.name));
  if (reports.length <= CHECK_REPORT_PRUNE_THRESHOLD) return 0;
  const receipts = await Promise.all(
    ["codex", "claude"].map((host) => readStoreJson(root, `${directory}/setup-${host}.json`)),
  );
  const keep = new Set(
    [
      ...referenced,
      ...receipts.map((receipt) =>
        receipt && typeof receipt === "object" && "initialReportPath" in receipt
          ? String(receipt.initialReportPath)
          : undefined,
      ),
    ].flatMap((file) => (file?.startsWith(checks + "/") ? [file.slice(checks.length + 1)] : [])),
  );
  const absolute = await storePath(root, checks);
  const dated = await Promise.all(
    reports.map(async (entry) => {
      const stat = await fs.lstat(path.join(absolute, entry.name)).catch(() => null);
      return { name: entry.name, modified: stat?.mtimeMs ?? Infinity };
    }),
  );
  dated.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  let removed = 0;
  for (const { name } of dated.slice(RETAINED_CHECK_REPORTS)) {
    if (keep.has(name)) continue;
    try {
      await fs.unlink(path.join(absolute, name));
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
