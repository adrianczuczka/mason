import { z } from "zod";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import { workspace } from "./evidence.js";
import { HOOK_EVENTS, hookConfig } from "./adapters.js";
import { withLock, type Host } from "./store.js";

const groupSchema = z.object({ hooks: z.array(z.object({ type: z.string(), command: z.string().optional() }).passthrough()) }).passthrough();
const configSchema = z.object({ hooks: z.record(z.array(groupSchema)).optional() }).passthrough();
const recordSchema = z.object({ version: z.literal(1), hosts: z.record(z.object({ command: z.string() })) });
export const configPath = (host: Host) => host === "claude" ? ".claude/settings.json" : ".codex/hooks.json";

/** Explicit install preserves other settings and hooks, replacing only Mason's recorded handlers. */
export async function installAutomation(dir: string, host: Host, command?: string) {
  const ws = await workspace(dir);
  return withLock(ws.root, ".mason/reports/automation-install", () => installLocked(ws.root, host, command));
}

async function installLocked(root: string, host: Host, command?: string) {
  const file = configPath(host);
  const existing = configSchema.parse(await readStoreJson(root, file) ?? {});
  const record = recordSchema.parse(await readStoreJson(root, ".mason/automation.json") ?? { version: 1, hosts: {} });
  const desired = hookConfig(host, command);
  const newCommand = desired.hooks.SessionStart[0].hooks[0].command;
  const previous = record.hosts[host]?.command;
  const hooks = existing.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = (hooks[event] ?? []).map(group => ({ ...group,
      hooks: group.hooks.filter(handler => !(handler.type === "command" && typeof handler.command === "string" &&
        (handler.command === previous || handler.command === newCommand))),
    })).filter(group => group.hooks.length);
    hooks[event].push(...desired.hooks[event]);
  }
  record.hosts[host] = { command: newCommand };
  await writeStoreJson(root, file, { ...existing, hooks });
  await writeStoreJson(root, ".mason/automation.json", record);
  return { version: 1, host, configPath: file, status: "configured", command: newCommand,
    events: HOOK_EVENTS,
    next: host === "codex"
      ? "Review/trust these hooks using Codex /hooks and start a new session. mason-auto status reports observed events separately from configuration."
      : "Start a new Claude Code session. mason-auto status reports observed events separately from configuration.",
    note: "Install mason-context in the project before using the default command. Ignore .mason/reports/ to keep local evidence out of commits. Hooks preserve evidence and suggest scoped repairs; they do not approve edits or decisions." };
}

export async function installedAutomation(dir: string) {
  const ws = await workspace(dir);
  const raw = await readStoreJson(ws.root, ".mason/automation.json");
  if (raw === null) return {};
  const record = recordSchema.parse(raw);
  const result: Record<string, unknown> = {};
  for (const host of ["claude", "codex"] as const) {
    const expected = record.hosts[host];
    if (!expected) continue;
    const current = configSchema.parse(await readStoreJson(ws.root, configPath(host)) ?? {});
    const configuredEvents = HOOK_EVENTS.filter(event => current.hooks?.[event]?.some(group =>
      group.hooks.some(handler => handler.type === "command" && handler.command === expected.command)));
    result[host] = { configPath: configPath(host), configuredEvents,
      status: current.disableAllHooks === true ? "disabled" : configuredEvents.length === HOOK_EVENTS.length ? "configured" : "incomplete",
      runtime: "Host version, trust, policy, and tool coverage still determine execution; inspect observed events." };
  }
  return result;
}
