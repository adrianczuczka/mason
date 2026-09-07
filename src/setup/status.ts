import { isDeepStrictEqual } from "node:util";
import { hash, workspace } from "../automation/evidence.js";
import { events, type Host } from "../automation/store.js";
import { automationStatus } from "../automation/runtime.js";
import { loadDecisionStore } from "../decisions/decisions.js";
import { hookConfig } from "../automation/adapters.js";
import { loadSetup, loadSetupReceipt } from "./model.js";
import { verifyRuntime } from "./runtime.js";
import { inspectHostConfig, instructionEdits } from "./config.js";
import { LAUNCHER, SHELL_LAUNCHER, POWERSHELL_LAUNCHER, hookCommand, mcpCommand } from "./launcher.js";
import { readText } from "./files.js";
import { readObservation } from "./observations.js";

export async function setupStatus(dir: string) {
  const ws = await workspace(dir);
  const setup = await loadSetup(ws.root);
  if (!setup) {
    const partial = await Promise.all((["codex", "claude"] as const).map(async host => ({ host,
      receipt: await loadSetupReceipt(ws.root, ws.directory, host) })));
    const pending = partial.filter(item => item.receipt !== null).map(item => item.host);
    return { version: 1, status: pending.length ? "incomplete" : "not-configured", hosts: {},
      next: pending.length ? "Setup did not finish. Rerun mason-auto setup --host " + pending[0] + " to resume using the retained original evidence."
        : "Run mason-auto setup --host codex or --host claude." };
  }
  const hosts: Record<string, { status: string; runtime: string; mcp: string; instructions: string; hookConfiguration: string;
    observedEvents: string[]; contextCalls: number; verificationStatus: string; pending: string[] }> = {};
  const commonLauncherCurrent = await readText(ws.root, ".mason/run.cjs") === LAUNCHER;
  const automation = await automationStatus(ws.root);
  for (const host of ["codex", "claude"] as const) {
    const entry = setup.hosts[host];
    if (!entry) continue;
    const launcherCurrent = commonLauncherCurrent && (!entry.runtime.bundle ||
      await readText(ws.root, ".mason/run.sh") === SHELL_LAUNCHER &&
      await readText(ws.root, ".mason/run.ps1") === POWERSHELL_LAUNCHER &&
      await readText(ws.root, `.mason/runtime/${host}.txt`) === entry.runtime.id + "\n");
    const instructions = await instructionEdits(ws.root, host);
    const instructionsCurrent = instructions.every(edit => edit.before === edit.after);
    const installed = await verifyRuntime(ws.root, entry.runtime);
    const config = await inspectHostConfig(ws.root, host, undefined, entry.runtime);
    const mcp = !config.mcpDisabled && hash(config.mcp) === entry.mcpFingerprint &&
      isDeepStrictEqual({ command: config.mcp?.command, args: config.mcp?.args }, mcpCommand(host, entry.runtime));
    const hooks = isDeepStrictEqual(config.hooks, hookConfig(host, hookCommand(host, entry.runtime)).hooks) && !config.disabled;
    const local = await loadSetupReceipt(ws.root, ws.directory, host);
    const configured = local?.status === "configured" && local.root === ws.root && local.revision === entry.revision;
    const observation = await readObservation(ws.root, ws.directory, host, entry.revision);
    // Complete lifecycle evidence must come from one session in this worktree/branch.
    const sessions = Object.values(observation?.sessions ?? {}).sort((a, b) => b.at.localeCompare(a.at));
    const complete = sessions.find(session => events.every(event => session.events.includes(event)));
    const observedEvents = complete?.events ?? sessions[0]?.events ?? [];
    const pending: string[] = [];
    if (!installed || !launcherCurrent) pending.push("Install this checkout's pinned runtime by rerunning setup.");
    if (!mcp || !hooks || !instructionsCurrent || !configured) pending.push("Rerun setup to reconcile project configuration; inspect any disabled host settings.");
    if (!observation?.contextCalls) pending.push("Start a new assistant session and request task context through Mason's get_context tool.");
    if (!complete) pending.push("Review/trust the host configuration, then complete a normal task to observe the full hook lifecycle.");
    if (automation.status === "unavailable") pending.push("The latest automation attempt did not establish verification. Run mason-auto check and inspect its diagnostics.");
    const healthy = installed && launcherCurrent && mcp && hooks && instructionsCurrent && configured && automation.status !== "unavailable";
    hosts[host] = { status: healthy ? complete && observation?.contextCalls ? "active" : "pending" : "attention",
      runtime: installed && launcherCurrent ? "installed" : "missing-or-changed", mcp: mcp ? "configured" : "changed",
      instructions: instructionsCurrent ? "current" : "changed", hookConfiguration: hooks ? "configured" : "disabled-or-changed",
      observedEvents, contextCalls: observation?.contextCalls ?? 0,
      verificationStatus: automation.status === "current" ? automation.verificationStatus ?? "unavailable" : "unavailable", pending };
  }
  const statuses = Object.values(hosts).map(host => host.status);
  const decisions = await loadDecisionStore(ws.root);
  return { version: 1, status: statuses.length && statuses.every(status => status === "active") ? "active"
    : statuses.includes("attention") ? "attention" : "pending", root: ws.root, hosts,
    decisionRecords: decisions.records.length, diagnostics: decisions.diagnostics,
    scope: "Activation receipts record observed use after setup, not complete interception, correct repairs, or measured usefulness. Host trust and higher-priority settings may prevent execution. Receipts are local to this worktree and branch." };
}

export function summarizeActivation(status: Awaited<ReturnType<typeof setupStatus>>): string {
  const lines = ["Mason setup: " + status.status + "."];
  for (const [host, state] of Object.entries(status.hosts)) {
    lines.push(`${host}: ${state.status}`, `  Runtime: ${state.runtime}; MCP: ${state.mcp}; instructions: ${state.instructions}.`,
      `  Hooks: ${state.hookConfiguration}; observed: ${state.observedEvents.join(", ") || "none"}.`,
      `  Task context requests: ${state.contextCalls}; verification: ${state.verificationStatus}.`,
      ...state.pending.map(message => "  Next: " + message));
  }
  if ("decisionRecords" in status) lines.push(`Decision records: ${status.decisionRecords}.`);
  if (status.next) lines.push(status.next);
  return lines.join("\n");
}
