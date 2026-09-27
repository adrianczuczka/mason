import { execGit } from "../utils/git-read.js";
import { loadDecisionStore } from "./decisions.js";
import { decisionApproval } from "./provenance.js";

/** Informational only: saving, committing, and accepting are separate operations. */
export async function pendingKnowledge(root: string, now = Date.now()): Promise<string | null> {
  try {
    const [store, status] = await Promise.all([
      loadDecisionStore(root),
      execGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".mason/decisions"],
        { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 }),
    ]);
    const changed = new Set<string>();
    const entries = status.stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const file = entry.slice(3);
      if (/^\.mason\/decisions\/[^/]+\.json$/.test(file)) changed.add(file);
      if (/[RC]/.test(entry.slice(0, 2))) i++; // porcelain -z includes the old name separately
    }
    const records = new Map(store.records.map(record => [`.mason/decisions/${record.id}.json`, record]));
    const age = (at?: string) => {
      const time = at ? Date.parse(at) : NaN;
      return Number.isFinite(time) ? `${Math.max(0, Math.floor((now - time) / 86400000))} days` : "unknown age";
    };
    const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    const list = (items: string[]) => items.slice(0, 5).map(safe).join("; ") + (items.length > 5 ? `; ${items.length - 5} more` : "");
    const proposals = store.records.filter(record => record.status === "active" && decisionApproval(record) === "proposed")
      .map(record => {
        // Revisions must not reset how long an outstanding proposal has waited.
        const history = record.version === 2 ? record.history : [];
        let lastReview = -1;
        history.forEach((event, index) => { if (event.kind === "accepted" || event.kind === "reaffirmed") lastReview = index; });
        const since = history.slice(lastReview + 1).find(event => event.kind === "created" || event.kind === "revised")?.at ?? record.createdAt;
        return { record, since };
      }).sort((a, b) => {
        const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
        return timestamp(a.since) - timestamp(b.since) || a.record.id.localeCompare(b.record.id);
      });
    const lines = [];
    if (changed.size) lines.push(`${changed.size} uncommitted decision record(s): ${list([...changed].sort().map(file =>
      `${file} (saved-record age: ${age(records.get(file)?.updatedAt)})`))}.`);
    if (proposals.length) lines.push(`${proposals.length} proposal(s) awaiting review (oldest first): ${list(proposals.map(({ record, since }) =>
      `.mason/decisions/${record.id}.json (${age(since)})`))}.`);
    if (store.diagnostics.length) lines.push(`${store.diagnostics.length} decision record(s) could not be read; pending knowledge summary is incomplete.`);
    return lines.length ? `Mason pending knowledge:\n${lines.join("\n")}\nInformational only; review and commit through the normal project workflow. No approval is implied.` : null;
  } catch {
    return "Mason pending knowledge: unavailable; decision records or Git status could not be read.";
  }
}
