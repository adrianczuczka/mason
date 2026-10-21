/** Pending entries in one session; one turn rarely has more unfinished tool calls. */
export const PENDING_LIMIT = 32;

/** Make room for one more pending tool call by dropping the oldest insertions. A dropped call
 * that later completes records a coverage gap instead of an observed edit. */
export function boundPending(pending: Record<string, unknown>) {
  for (const key of Object.keys(pending).slice(0, -PENDING_LIMIT + 1)) delete pending[key];
}
