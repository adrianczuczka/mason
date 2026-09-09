import { z } from "zod";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import { workspace } from "./evidence.js";
import { HOOK_EVENTS, hookConfig, knownManagedHookCommands } from "./adapters.js";
import { withLock, type Host } from "./store.js";
import { readText } from "../setup/files.js";
import { OWNERSHIP_PATH, ownershipSchema } from "../setup/ownership.js";

const groupSchema = z.object({ hooks: z.array(z.object({ type: z.string(), command: z.string().optional() }).passthrough()) }).passthrough();
export const automationConfigSchema = z.object({ hooks: z.record(z.array(groupSchema)).optional() }).passthrough();
export const recordSchema = z.object({ version: z.literal(1), hosts: z.record(z.object({ command: z.string() })) });
export const AUTOMATION_PATH = ".mason/local/automation.json";
async function installationRecord(root: string) {
  return recordSchema.parse(await readStoreJson(root, AUTOMATION_PATH) ?? { version: 1, hosts: {} });
}
export const configPath = (host: Host) => host === "claude" ? ".claude/settings.json" : ".codex/hooks.json";

/** Explicit install preserves other settings and hooks, replacing only Mason's recorded handlers. */
export async function installAutomation(dir: string, host: Host, command?: string) {
  const ws = await workspace(dir);
  return withLock(ws.root, ".mason/reports/setup-lock", () => installLocked(ws.root, host, command));
}

export async function planAutomationInstall(root: string, host: Host, command?: string) {
  const file = configPath(host);
  const before = await readText(root, file);
  const existing = automationConfigSchema.parse(JSON.parse(before ?? "{}"));
  const record = await installationRecord(root);
  const desired = hookConfig(host, command);
  const newCommand = desired.hooks.SessionStart[0].hooks[0].command;
  const previous = record.hosts[host]?.command;
  const ownershipText = await readText(root, OWNERSHIP_PATH);
  const pending = ownershipText === null ? [] : ownershipSchema.parse(JSON.parse(ownershipText)).files[file]?.hookCommands ?? [];
  // A clone has shared hooks but no local ownership receipt.
  const owned = new Set([previous, ...pending, newCommand, ...knownManagedHookCommands(host)]);
  const hooks = existing.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = (hooks[event] ?? []).map(group => ({ ...group,
      hooks: group.hooks.filter(handler => !(handler.type === "command" && typeof handler.command === "string" &&
        owned.has(handler.command))),
    })).filter(group => group.hooks.length);
    hooks[event].push(...desired.hooks[event]);
  }
  record.hosts[host] = { command: newCommand };
  return { file, before, config: { ...existing, hooks }, record, newCommand };
}

async function installLocked(root: string, host: Host, command?: string) {
  const { file, before, config, record, newCommand } = await planAutomationInstall(root, host, command);
  const { ancillaryEdits } = await import("../setup/config.js");
  const { applyEdit } = await import("../setup/files.js");
  const { ownershipEdit, completedHookOwnership } = await import("../setup/ownership.js");
  const edit = { path: file, before, after: JSON.stringify(config, null, 2) + "\n" };
  const ancillary = await ancillaryEdits(root);
  await applyEdit(root, await ownershipEdit(root, [edit], { [file]: newCommand }));
  for (const edit of ancillary) await applyEdit(root, edit);
  await applyEdit(root, edit);
  // Keep the previous command until its replacement is installed. Ownership
  // records the pending command so teardown/reinstallation can resume either side.
  await writeStoreJson(root, AUTOMATION_PATH, record);
  await applyEdit(root, await completedHookOwnership(root, file, newCommand));
  return { version: 1, host, configPath: file, status: "configured", command: newCommand,
    events: HOOK_EVENTS,
    next: host === "codex"
      ? "Review/trust these hooks using Codex /hooks and start a new session. mason-auto status reports observed events separately from configuration."
      : "Start a new Claude Code session. mason-auto status reports observed events separately from configuration.",
    note: "Install mason-context in the project before using the default command. Ignore .mason/reports/ to keep local evidence out of commits. Hooks preserve evidence and suggest scoped repairs; they do not approve edits or decisions." };
}

export async function installedAutomation(dir: string) {
  const ws = await workspace(dir);
  const record = await installationRecord(ws.root);
  const result: Record<string, unknown> = {};
  for (const host of ["claude", "codex"] as const) {
    const expected = record.hosts[host];
    if (!expected) continue;
    const current = automationConfigSchema.parse(await readStoreJson(ws.root, configPath(host)) ?? {});
    const configuredEvents = HOOK_EVENTS.filter(event => current.hooks?.[event]?.some(group =>
      group.hooks.some(handler => handler.type === "command" && handler.command === expected.command)));
    result[host] = { configPath: configPath(host), configuredEvents,
      status: current.disableAllHooks === true ? "disabled" : configuredEvents.length === HOOK_EVENTS.length ? "configured" : "incomplete",
      runtime: "Host version, trust, policy, and tool coverage still determine execution; inspect observed events." };
  }
  return result;
}
