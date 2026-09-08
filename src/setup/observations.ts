import fs from "node:fs/promises";
import { z } from "zod";
import { hash, workspace } from "../automation/evidence.js";
import { withLock, events, type Host } from "../automation/store.js";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import { loadSetup } from "./model.js";
import { executingVersion } from "./launcher.js";

const observationSchema = z.object({ version: z.literal(1), masonVersion: z.string(), root: z.string(), revision: z.string(), host: z.enum(["codex", "claude"]),
  contextCalls: z.number().int().nonnegative(), lastContextAt: z.string().optional(),
  sessions: z.record(z.object({ events: z.array(z.enum(events)), at: z.string(),
    verificationStatus: z.string().optional(), reportPath: z.string().optional() })),
});
export type Observation = z.infer<typeof observationSchema>;
export function observationPath(directory: string, host: Host, revision: string, version = executingVersion()) { return `${directory}/activation/${host}-${revision}-${hash(version).slice(0, 12)}.json`; }

export async function readObservation(root: string, directory: string, host: Host, revision: string, version = executingVersion()): Promise<Observation | null> {
  const raw = await readStoreJson(root, observationPath(directory, host, revision, version));
  if (raw === null) return null;
  const record = observationSchema.parse(raw);
  if (record.root !== root || record.host !== host || record.revision !== revision || record.masonVersion !== version) throw new Error("Activation receipt belongs to another installation.");
  return record;
}

/** Only the configured Mason invocation supplies these values. Never persist task text or tool arguments. */
export async function observeActivation(dir: string, event: "context" | typeof events[number], options: {
  sessionId?: string; verificationStatus?: string; reportPath?: string;
} = {}): Promise<string | null> {
  const host = process.env.MASON_SETUP_HOST, revision = process.env.MASON_SETUP_REVISION;
  if ((host !== "codex" && host !== "claude") || !revision || !process.env.MASON_SETUP_ROOT) return null;
  try {
    const capturedDirectory = options.reportPath?.match(/^(\.mason\/reports\/automation\/[a-f0-9]{24})\/checks\//)?.[1];
    const ws = capturedDirectory ? { root: await fs.realpath(dir), directory: capturedDirectory } : await workspace(dir);
    if (ws.root !== await fs.realpath(process.env.MASON_SETUP_ROOT)) return null;
    const setup = await loadSetup(ws.root);
    if (setup?.hosts[host]?.revision !== revision) return "Mason setup changed; restart the assistant to observe the current integration.";
    const directory = ws.directory + "/activation";
    await withLock(ws.root, directory, async () => {
      const now = new Date().toISOString();
      const record = await readObservation(ws.root, ws.directory, host, revision) ?? {
        version: 1, masonVersion: executingVersion(), root: ws.root, revision, host, contextCalls: 0, sessions: {},
      } satisfies Observation;
      if (event === "context") { record.contextCalls++; record.lastContextAt = now; }
      else if (options.sessionId) {
        const key = hash(options.sessionId);
        const session = record.sessions[key] ?? { events: [], at: now };
        // Repeated tool observations add no activation evidence; avoid another write.
        if (event !== "task_end" && session.events.includes(event)) return;
        session.events = [...new Set([...session.events, event])];
        session.at = now;
        if (event === "task_end") { session.verificationStatus = options.verificationStatus; session.reportPath = options.reportPath; }
        record.sessions[key] = session;
        const ordered = Object.entries(record.sessions).sort(([, a], [, b]) => b.at.localeCompare(a.at));
        record.sessions = Object.fromEntries(ordered.slice(0, 32));
      } else return;
      await writeStoreJson(ws.root, observationPath(ws.directory, host, revision), record);
    });
    return null;
  } catch (error) {
    return "Mason activation observation could not be saved; activation coverage is unknown. " + (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  }
}
