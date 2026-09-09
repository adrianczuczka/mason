import os from "node:os";
import fs from "node:fs/promises";
import { withLock } from "./store.js";
import { hash, workspace } from "./evidence.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readStoreJson, writeStoreJson, storePath } from "../utils/storage.js";

const failureSchema = z.object({
  code: z.enum(["inputs-changed", "storage-full", "busy", "invalid-input", "history-unavailable", "invalid-evidence", "io-error", "internal"]),
  message: z.string(), retryable: z.boolean(), receiptRecorded: z.boolean(),
});
export type AutomationFailure = z.infer<typeof failureSchema>;
const attemptSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), lease: z.literal(true).optional(), event: z.string(), startedAt: z.string(), finishedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  pid: z.number().int().positive(), host: z.string(),
  status: z.enum(["running", "completed", "failed", "unknown"]),
  verificationStatus: z.string().optional(), reportPath: z.string().optional(), failure: failureSchema.optional(),
});
const executionSchema = z.object({ version: z.literal(1), attempts: z.array(attemptSchema).max(160), discardedAttempts: z.number().int().nonnegative().default(0) });
function parseExecution(raw: unknown) {
  try { return executionSchema.parse(raw); }
  catch (error) { throw new Error("Invalid automation execution store; receipt history was retained.", { cause: error }); }
}

/** Classify failures without interpreting the advisory hook's exit code as evidence. */
export function automationFailure(error: unknown): AutomationFailure {
  const recorded = failureSchema.safeParse((error as { failure?: unknown } | null)?.failure);
  if (recorded.success) return recorded.data;
  const message = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 700);
  const codes = new Set<string>();
  let cause: unknown = error;
  for (let i = 0; cause && i < 8; i++) {
    codes.add(String((cause as NodeJS.ErrnoException).code));
    cause = (cause as Error).cause;
  }
  const code: AutomationFailure["code"] = codes.has("ENOSPC") || codes.has("EDQUOT") ? "storage-full"
    : /changed during|changed while|changed between/.test(message) ? "inputs-changed"
    : /Automation is busy/.test(message) ? "busy"
    : /not a git repository|unknown revision|bad revision|different history|unreachable/.test(message) ? "history-unavailable"
    : error instanceof z.ZodError || error instanceof SyntaxError || /Hook input|Expected one command|Unknown automation command|--host/.test(message) ? "invalid-input"
    : /store|baseline|modified|symbolic link|Symlink|automation state|state belongs/.test(message) ? "invalid-evidence"
    : [...codes].some(c => /^E[A-Z]+$/.test(c)) ? "io-error" : "internal";
  return { code, message, retryable: ["inputs-changed", "storage-full", "busy", "io-error"].includes(code), receiptRecorded: false };
}

export function failureMessage(error: unknown): string {
  const failure = automationFailure(error);
  return `Mason automation unavailable [${failure.code}]; evidence capture/verification was not established. ${failure.message}` +
    (failure.receiptRecorded ? "" : " No durable failure receipt was recorded.");
}

const notificationsSchema = z.object({ version: z.literal(1), sessions: z.record(z.object({
  signature: z.string(), code: failureSchema.shape.code, message: z.string(), count: z.number().int().positive(), lastAt: z.string(),
})) });

export async function failureNotifications(root: string, directory: string) {
  const raw = await readStoreJson(root, directory + "/notifications.json");
  return raw === null ? { version: 1 as const, sessions: {} } : notificationsSchema.parse(raw);
}

/** Suppress repeats only after the failure itself has a durable execution receipt. */
export async function hookFailureMessage(dir: string, host: string, sessionId: string, error: unknown): Promise<string | null> {
  const failure = automationFailure(error);
  if (!failure.receiptRecorded) return failureMessage(error);
  try {
    const ws = await workspace(dir);
    return await withLock(ws.root, ws.directory + "/notifications", async () => {
      const notices = await failureNotifications(ws.root, ws.directory);
      const key = hash([host, sessionId]), signature = hash([failure.code, failure.message]);
      const previous = notices.sessions[key];
      const execution = await executionStatus(ws.root, ws.directory);
      const recovered = previous && execution.attempts.some(a => a.status === "completed" && a.startedAt > previous.lastAt);
      const repeat = previous?.signature === signature && !recovered;
      notices.sessions[key] = { signature, code: failure.code, message: failure.message,
        count: repeat ? previous.count + 1 : 1, lastAt: new Date().toISOString() };
      notices.sessions = Object.fromEntries(Object.entries(notices.sessions).sort(([, a], [, b]) => b.lastAt.localeCompare(a.lastAt)).slice(0, 32));
      await writeStoreJson(ws.root, ws.directory + "/notifications.json", notices);
      return repeat ? null : failureMessage(error) + " Repeated failures in this session are recorded in mason status --json.";
    });
  } catch { return failureMessage(error); }
}

/** Each invocation owns a receipt while only brief log updates are serialized. */
const leasePath = (directory: string, id: string) => `${directory}/executions/${id}.json`;

async function refreshRunning(root: string, directory: string, attempts: z.infer<typeof attemptSchema>[]) {
  for (const attempt of attempts) {
    if (attempt.status !== "running") continue;
    let alive = false;
    try {
      const owner = await readStoreJson(root, attempt.lease ? leasePath(directory, attempt.id) : directory + "/lock") as { pid?: unknown; host?: unknown } | null;
      if (attempt.host === os.hostname() && owner?.pid === attempt.pid && owner.host === attempt.host) {
        try { process.kill(attempt.pid, 0); alive = true; }
        catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
      }
    } catch { /* Missing ownership never establishes a running check. */ }
    if (!alive) attempt.status = "unknown";
  }
}

async function editExecution(root: string, directory: string, edit: (log: z.infer<typeof executionSchema>) => void) {
  return withLock(root, directory + "/execution-lock", async () => {
    const file = directory + "/execution.json";
    const raw = await readStoreJson(root, file);
    const log = raw === null ? { version: 1 as const, attempts: [], discardedAttempts: 0 } : parseExecution(raw);
    await refreshRunning(root, directory, log.attempts);
    edit(log);
    // Keep every live invocation plus the latest 32 finished attempts.
    const finished = log.attempts.filter(a => a.status !== "running");
    const discard = new Set(finished.slice(0, Math.max(0, finished.length - 32)).map(a => a.id));
    log.discardedAttempts += discard.size;
    log.attempts = log.attempts.filter(a => !discard.has(a.id));
    await writeStoreJson(root, file, log);
  });
}

export async function recordExecution<T extends { report: { status: string; reportPath: string } }>(
  root: string, directory: string, event: string, run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const attempt: z.infer<typeof attemptSchema> = {
    id: randomUUID(), event, startedAt: new Date().toISOString(), pid: process.pid, host: os.hostname(), status: "running", lease: true,
  };
  const owner = leasePath(directory, attempt.id);
  const finish = async (changes: Partial<z.infer<typeof attemptSchema>>) => editExecution(root, directory, log => {
    const current = log.attempts.find(a => a.id === attempt.id);
    if (!current) throw new Error("Automation execution receipt disappeared; completion could not be recorded.");
    Object.assign(current, changes, { finishedAt: new Date().toISOString(), durationMs: performance.now() - started });
  });
  await writeStoreJson(root, owner, { pid: attempt.pid, host: attempt.host });
  try {
    await editExecution(root, directory, log => {
      if (log.attempts.filter(a => a.status === "running").length >= 128) throw new Error("Too many active automation executions; existing receipts were retained.");
      log.attempts.push(attempt);
    });
    try {
      const result = await run();
      await finish({ status: "completed", verificationStatus: result.report.status, reportPath: result.report.reportPath });
      return result;
    } catch (error) {
      const failure = automationFailure(error);
      try { await finish({ status: "failed", failure: { ...failure, receiptRecorded: true } }); failure.receiptRecorded = true; }
      catch { /* Storage failures may also prevent their own completion receipt. */ }
      throw Object.assign(new Error(failure.message, { cause: error }), { failure });
    }
  } finally { await fs.rm(await storePath(root, owner), { force: true }).catch(() => {}); }
}

export async function executionStatus(root: string, directory: string) {
  const raw = await readStoreJson(root, directory + "/execution.json");
  if (raw === null) return { status: "not-observed" as const, attempts: [] };
  const log = parseExecution(raw);
  await refreshRunning(root, directory, log.attempts);
  const completed = [...log.attempts].reverse().find(a => a.status === "completed");
  // A success that began before another call failed cannot establish recovery.
  const outstanding = [...log.attempts].reverse().find(a => ["failed", "unknown"].includes(a.status) &&
    (!completed || (a.finishedAt ?? a.startedAt) >= completed.startedAt));
  const status = log.attempts.some(a => a.status === "running") ? "running" : outstanding?.status ?? log.attempts.at(-1)?.status ?? "not-observed";
  return { status, attempts: log.attempts, discardedAttempts: log.discardedAttempts };
}
