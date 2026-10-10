import { isRecord } from "../utils/validation.js";
import fs from "node:fs/promises";
import { z } from "zod";
import { workspace, hash } from "./evidence.js";
import { readStoreJson, writeStoreJson, storePath } from "../utils/storage.js";
import { withStoreLock } from "../utils/store-lock.js";
import type { AutomationEvent, AutomationReport } from "./runtime.js";
import type { RepairFinding } from "../audit/repair.js";

const directory = ".mason/local/usefulness";
const configPath = directory + "/config.json";
const configSchema = z.object({ version: z.literal(1), enabled: z.boolean() });
export const usefulnessRating = z.enum(["helpful", "already-knew", "irrelevant", "deferred"]);
const findingSchema = z.object({
  type: z.string(),
  channels: z.array(z.enum(["agent", "completion"])),
  status: z.enum(["resolved", "unresolved", "review-required", "unverified", "unknown"]),
  deliveredAt: z.string(),
  observedAt: z.string(),
  rating: usefulnessRating.optional(),
});
const sessionSchema = z.object({
  host: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().optional(),
  checks: z.number(),
  checkMs: z.number(),
  findings: z.record(findingSchema),
  decisions: z.array(z.string()),
  retrievalObserved: z.boolean(),
  receiptIds: z.array(z.string()),
  reportPath: z.string(),
  truncated: z.boolean(),
});
const stateSchema = z.object({ version: z.literal(1), sessions: z.record(sessionSchema) });
type Session = z.infer<typeof sessionSchema>;
const empty = () => ({ version: 1 as const, sessions: {} as Record<string, Session> });
const statePath = (ws: Awaited<ReturnType<typeof workspace>>) =>
  `${directory}/${hash([ws.root, ws.gitDir, ws.branch]).slice(0, 24)}.json`;
async function enabled(root: string) {
  const raw = await readStoreJson(root, configPath);
  return raw !== null && configSchema.parse(raw).enabled;
}
export async function configureUsefulness(
  dir: string,
  value: boolean,
  options: { onlyIfUnset?: boolean } = {},
) {
  const ws = await workspace(dir);
  const configured = await withStoreLock(ws.root, directory, async () => {
    if (options.onlyIfUnset) {
      const existing = await readStoreJson(ws.root, configPath);
      if (existing !== null) return configSchema.parse(existing).enabled;
    }
    // Self-contained ignore rules keep these observations local even before project setup.
    const ignore = await storePath(ws.root, directory + "/.gitignore", true);
    try {
      await fs.writeFile(ignore, "*\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await writeStoreJson(ws.root, configPath, { version: 1, enabled: value });
    return value;
  });
  return {
    enabled: configured,
    storage: directory,
    note: "Local only. Disabling retains prior observations.",
  };
}

/** Store IDs and counts, never hook payloads, prompts, returned text or source contents. */
export async function observeUsefulness(
  root: string,
  event: AutomationEvent,
  report: AutomationReport,
  agent: RepairFinding[],
  completion: RepairFinding[],
  elapsedMs: number,
  observedAt = new Date().toISOString(),
) {
  if (!event.host || !event.sessionId || !(await enabled(root))) return;
  const ws = await workspace(root);
  await withStoreLock(ws.root, directory, async () => {
    if (!(await enabled(root))) return;
    const raw = await readStoreJson(root, statePath(ws));
    const state = raw === null ? empty() : stateSchema.parse(raw);
    const now = observedAt;
    const key = hash([event.host, event.sessionId]);
    const session = (state.sessions[key] ??= {
      host: event.host!,
      updatedAt: now,
      checks: 0,
      checkMs: 0,
      findings: {},
      decisions: [],
      retrievalObserved: false,
      receiptIds: [],
      reportPath: report.reportPath,
      truncated: false,
    });
    const newer = now >= session.updatedAt;
    if (newer) {
      session.updatedAt = now;
      session.reportPath = report.reportPath;
    }
    session.checks++;
    session.checkMs += Math.max(0, elapsedMs);
    if (newer) {
      if (event.event === "task_end") session.endedAt = now;
      else delete session.endedAt;
    }
    // Publication and stats recording use separate locks. A first-delivery record
    // can arrive after a newer audit; use that retained audit for its status.
    let latestFindings: { id: string; status: z.infer<typeof findingSchema>["status"] }[] = [];
    if (
      !newer &&
      [...agent.slice(0, 4), ...completion.slice(0, 4)].some((f) => !session.findings[f.id])
    ) {
      try {
        if (!session.reportPath.startsWith(ws.directory + "/checks/"))
          throw new Error("Unexpected report path");
        latestFindings = z
          .object({
            findings: z.array(z.object({ id: z.string(), status: findingSchema.shape.status })),
          })
          .parse(await readStoreJson(root, session.reportPath)).findings;
      } catch {
        /* Unavailable newer evidence means unknown, never reuse an older verdict. */
      }
    }
    for (const [channel, findings] of [
      ["agent", agent],
      ["completion", completion],
    ] as const) {
      for (const finding of findings.slice(0, 4)) {
        if (!session.findings[finding.id] && Object.keys(session.findings).length >= 200) {
          session.truncated = true;
          continue;
        }
        const saved = (session.findings[finding.id] ??= {
          type: finding.original.type,
          channels: [],
          status: newer
            ? finding.status
            : (latestFindings.find((f) => f.id === finding.id)?.status ?? "unknown"),
          deliveredAt: now,
          observedAt: newer ? now : session.updatedAt,
        });
        if (!saved.channels.includes(channel)) saved.channels.push(channel);
      }
    }
    for (const [id, saved] of Object.entries(session.findings)) {
      if (now < saved.observedAt) continue;
      const current = report.findings.find((f) => f.id === id);
      saved.status = current?.status ?? "unknown";
      saved.observedAt = now;
    }
    // Only successful get_context response receipts count as retrieval. Invocation alone is insufficient.
    if (event.retrievedDecisionIds !== undefined && event.toolId) {
      const receipt = hash([event.toolId]);
      if (!session.receiptIds.includes(receipt)) {
        session.retrievalObserved = true;
        const decisions = [
          ...new Set([...session.decisions, ...event.retrievedDecisionIds.map((id) => hash([id]))]),
        ];
        if (decisions.length > 200) session.truncated = true;
        session.decisions = decisions.slice(0, 200);
        session.receiptIds = [...session.receiptIds, receipt].slice(-200);
      }
    }
    const keys = Object.keys(state.sessions).sort((a, b) =>
      state.sessions[b].updatedAt.localeCompare(state.sessions[a].updatedAt),
    );
    for (const key of keys.slice(50)) delete state.sessions[key];
    await writeStoreJson(root, statePath(ws), state);
  });
}
export async function rateUsefulness(
  dir: string,
  sessionId: string,
  findingId: string,
  rating: z.infer<typeof usefulnessRating>,
) {
  const ws = await workspace(dir);
  return withStoreLock(ws.root, directory, async () => {
    const state = stateSchema.parse(await readStoreJson(ws.root, statePath(ws)));
    const finding = state.sessions[sessionId]?.findings[findingId];
    if (!finding)
      throw new Error("Unknown retained session or finding; inspect mason stats --json.");
    finding.rating = usefulnessRating.parse(rating);
    await writeStoreJson(ws.root, statePath(ws), state);
    return { session: sessionId, finding: findingId, rating };
  });
}
export async function usefulnessStatus(dir: string, sessionId?: string) {
  const ws = await workspace(dir);
  const raw = await readStoreJson(ws.root, statePath(ws));
  const state = raw === null ? empty() : stateSchema.parse(raw);
  if (sessionId !== undefined && !Object.hasOwn(state.sessions, sessionId))
    throw new Error("Unknown retained session; inspect mason stats --json for session IDs.");
  const sessions = Object.entries(state.sessions)
    .filter(([id]) => sessionId === undefined || id === sessionId)
    .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
    .map(([id, s]) => ({
      id,
      ...s,
      receiptIds: undefined,
      delivered: Object.keys(s.findings).length,
      resolved: Object.values(s.findings).filter((f) => f.status === "resolved").length,
      unknown: Object.values(s.findings).filter(
        (f) => f.status === "unknown" || f.status === "unverified",
      ).length,
      open: Object.values(s.findings).filter(
        (f) => f.status === "unresolved" || f.status === "review-required",
      ).length,
      ratings: Object.fromEntries(
        usefulnessRating.options.map((rating) => [
          rating,
          Object.values(s.findings).filter((f) => f.rating === rating).length,
        ]),
      ),
      deferred: Object.values(s.findings).filter((f) => f.rating === "deferred").length,
      retrievedDecisions: s.retrievalObserved ? s.decisions.length : null,
      application: "unknown",
      modelTokens: null,
    }));
  const sum = (pick: (s: (typeof sessions)[number]) => number) =>
    sessions.reduce((total, s) => total + pick(s), 0);
  const retrievalObservedSessions = sessions.filter((s) => s.retrievalObserved).length;
  return {
    version: 1,
    enabled: await enabled(ws.root),
    branch: ws.branch,
    sessionId: sessionId ?? null,
    summary: {
      sessions: sessions.length,
      delivered: sum((s) => s.delivered),
      resolved: sum((s) => s.resolved),
      open: sum((s) => s.open),
      unknown: sum((s) => s.unknown),
      ratings: Object.fromEntries(
        usefulnessRating.options.map((rating) => [rating, sum((s) => s.ratings[rating])]),
      ),
      retrievedDecisions: retrievalObservedSessions ? sum((s) => s.retrievedDecisions ?? 0) : null,
      retrievalObservedSessions,
      checks: sum((s) => s.checks),
      checkMs: sum((s) => s.checkMs),
      truncatedSessions: sessions.filter((s) => s.truncated).length,
      application: "unknown",
      modelTokens: null,
    },
    note: "Counts sum distinct findings and returned records within each retained session; the same item may appear in multiple sessions. Status reflects the last observed check, not a fresh verification. Up to 50 sessions and 200 findings/records per session are retained. Resolution after a notice does not establish causation. Ratings are supplied feedback, not authenticated judgments. Lesson application, later-session reuse and model-token cost are unknown.",
    sessions,
  };
}
export function summarizeUsefulness(result: Awaited<ReturnType<typeof usefulnessStatus>>) {
  const s = result.summary;
  return [
    `Mason stats — tracking ${result.enabled ? "enabled" : "disabled"} (local only)`,
    `${s.sessions} retained session(s)${result.sessionId ? " selected" : " in this branch"}. Counts are summed per session.`,
    `Findings: ${s.delivered} delivered; ${s.resolved} observed resolved; ${s.open} open; ${s.unknown} unknown.`,
    `Feedback: ${s.ratings.helpful} helpful; ${s.ratings["already-knew"]} already knew; ${s.ratings.irrelevant} irrelevant; ${s.ratings.deferred} deferred.`,
    `Decision records returned: ${s.retrievedDecisions ?? "unknown"} (${s.retrievalObservedSessions}/${s.sessions} sessions with retrieval receipts); application unknown.`,
    `Automation: ${(s.checkMs / 1000).toFixed(2)} seconds across ${s.checks} observations; model-token cost unknown.`,
    ...(s.truncatedSessions
      ? [`${s.truncatedSessions} session(s) have truncated observations.`]
      : []),
    ...(result.sessionId
      ? result.sessions.flatMap((session) => [
          `Session ${session.id} (${session.host}) — ${session.endedAt ? "last observed stop " + session.endedAt : "no final stop observed"}`,
          `Evidence: ${session.reportPath}`,
          ...Object.entries(session.findings).map(
            ([id, f]) =>
              `  ${id}: ${f.type}; ${f.status}; ${f.channels.join("/")}${f.rating ? "; rated " + f.rating : ""}`,
          ),
        ])
      : [
          s.sessions
            ? "Use --json for session IDs, then --session <id> for details."
            : "No retained sessions observed.",
        ]),
    "Last observed checks only. Resolution after a notice does not prove Mason caused it.",
  ].join("\n");
}

/** Hosts may wrap MCP text blocks; do not infer retrieval from tool inputs. */
export function retrievedDecisions(
  tool: string | undefined,
  response: unknown,
): string[] | undefined {
  if (!/(?:^|__)mason__get_context$/.test(tool ?? "")) return undefined;
  try {
    let value: unknown = typeof response === "string" ? JSON.parse(response) : response;
    if (!isRecord(value)) return undefined;
    if (value.isError) return undefined;
    if (Array.isArray(value?.content)) {
      const block: unknown = value.content.find(
        (item: unknown) => isRecord(item) && item.type === "text" && typeof item.text === "string",
      );
      if (!isRecord(block) || typeof block.text !== "string" || !block.text) return undefined;
      const text = block.text;
      value = JSON.parse(text);
    }
    if (!isRecord(value) || !isRecord(value.decisions)) return undefined;
    return Object.keys(value.decisions)
      .filter((id) => /^[a-zA-Z0-9_-]{1,200}$/.test(id))
      .slice(0, 200);
  } catch {
    return undefined;
  }
}
