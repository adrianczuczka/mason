import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";

const failureSchema = z.object({
  code: z.enum(["inputs-changed", "storage-full", "busy", "invalid-input", "history-unavailable", "invalid-evidence", "io-error", "internal"]),
  message: z.string(), retryable: z.boolean(), receiptRecorded: z.boolean(),
});
export type AutomationFailure = z.infer<typeof failureSchema>;
const attemptSchema = z.object({
  id: z.string(), event: z.string(), startedAt: z.string(), finishedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  pid: z.number().int().positive(), host: z.string(),
  status: z.enum(["running", "completed", "failed", "unknown"]),
  verificationStatus: z.string().optional(), reportPath: z.string().optional(), failure: failureSchema.optional(),
});
const executionSchema = z.object({ version: z.literal(1), attempts: z.array(attemptSchema).max(32), discardedAttempts: z.number().int().nonnegative().default(0) });
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

/** Called under the workspace lock. Keep a bounded history without storing tool input. */
export async function recordExecution<T extends { report: { status: string; reportPath: string } }>(
  root: string, directory: string, event: string, run: () => Promise<T>,
): Promise<T> {
  const file = directory + "/execution.json";
  const raw = await readStoreJson(root, file);
  const log = raw === null ? { version: 1 as const, attempts: [], discardedAttempts: 0 } : parseExecution(raw);
  // The lock has been acquired: an earlier unfinished receipt cannot still own it.
  for (const attempt of log.attempts) if (attempt.status === "running") attempt.status = "unknown";
  log.discardedAttempts += Math.max(0, log.attempts.length - 31);
  log.attempts = log.attempts.slice(-31);
  const started = performance.now();
  const attempt: z.infer<typeof attemptSchema> = {
    id: randomUUID(), event, startedAt: new Date().toISOString(), pid: process.pid, host: os.hostname(), status: "running",
  };
  log.attempts.push(attempt);
  await writeStoreJson(root, file, log);
  try {
    const result = await run();
    Object.assign(attempt, { status: "completed", finishedAt: new Date().toISOString(), durationMs: performance.now() - started,
      verificationStatus: result.report.status, reportPath: result.report.reportPath });
    await writeStoreJson(root, file, log);
    return result;
  } catch (error) {
    const failure = automationFailure(error);
    Object.assign(attempt, { status: "failed", finishedAt: new Date().toISOString(), durationMs: performance.now() - started, failure });
    delete attempt.verificationStatus;
    delete attempt.reportPath;
    try {
      await writeStoreJson(root, file, { ...log, attempts: log.attempts.map(a => a === attempt
        ? { ...a, failure: { ...failure, receiptRecorded: true } } : a) });
      failure.receiptRecorded = true;
    } catch { /* Storage exhaustion can also prevent recording its own failure. */ }
    throw Object.assign(new Error(failure.message, { cause: error }), { failure });
  }
}

export async function executionStatus(root: string, directory: string) {
  const raw = await readStoreJson(root, directory + "/execution.json");
  if (raw === null) return { status: "not-observed" as const, attempts: [] };
  const log = parseExecution(raw);
  let lock: { pid?: unknown; host?: unknown } | null = null;
  if (log.attempts.some(attempt => attempt.status === "running")) {
    try { lock = await readStoreJson(root, directory + "/lock") as { pid?: unknown; host?: unknown } | null; }
    catch { /* An absent/unreadable owner cannot establish an active execution. */ }
  }
  for (const attempt of log.attempts) {
    if (attempt.status !== "running") continue;
    let alive = false;
    if (attempt.host === os.hostname() && lock?.pid === attempt.pid && lock.host === attempt.host) {
      try { process.kill(attempt.pid, 0); alive = true; }
      catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
    }
    if (!alive) attempt.status = "unknown";
  }
  return { status: log.attempts.at(-1)?.status ?? "not-observed", attempts: log.attempts, discardedAttempts: log.discardedAttempts };
}
