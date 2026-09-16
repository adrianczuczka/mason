import { withStoreLock } from "../utils/store-lock.js";

/** Each checkout has its own snapshot and partials, shared by all MCP processes. */
export function withSnapshotWrite<T>(root: string, run: () => Promise<T>, waitMs = 5000): Promise<T> {
  return withStoreLock(root, ".mason/local/snapshot-write", run, waitMs, "Snapshot store");
}
