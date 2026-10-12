import { hash, workspace } from "../automation/evidence.js";
import { events } from "../automation/store.js";
import { automationStatus } from "../automation/runtime.js";
import { loadDecisionStore } from "../decisions/decisions.js";
import { effectiveSetup, loadSetupReceipt } from "./model.js";
import { inspectIntegration } from "./config.js";
import { installedCommand } from "./launcher.js";
import { readObservation } from "./observations.js";

export async function setupStatus(dir: string) {
  const ws = await workspace(dir);
  const activation = await effectiveSetup(ws.root);
  const setup = activation.setup;
  if (!setup || !Object.keys(setup.hosts).length) {
    const partial = await Promise.all(
      (["codex", "claude"] as const).map(async (host) => ({
        host,
        receipt: await loadSetupReceipt(ws.root, ws.directory, host),
      })),
    );
    const pending = partial.filter((item) => item.receipt !== null).map((item) => item.host);
    const configuration: Record<
      string,
      { compatible: boolean; disabled?: boolean; diagnostic?: string }
    > = {};
    await Promise.all(
      (["codex", "claude"] as const).map(async (host) => {
        try {
          const inspected = await inspectIntegration(ws.root, host);
          configuration[host] = {
            compatible: inspected.compatible,
            disabled: inspected.disabled || inspected.mcpDisabled,
          };
        } catch (error) {
          configuration[host] = {
            compatible: false,
            diagnostic: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return {
      version: 1,
      status: pending.length ? "incomplete" : "not-configured",
      hosts: {},
      configuration,
      next: pending.length
        ? "Setup did not finish. Rerun mason setup --host " +
          pending[0] +
          " to resume local activation; use mason init if shared configuration needs updating."
        : "Project hooks are inactive. Run mason setup --host codex or --host claude for compatible shared configuration; a maintainer uses mason init to prepare missing or incompatible configuration.",
    };
  }
  const hosts: Record<
    string,
    {
      status: string;
      runtime: string;
      mcp: string;
      instructions: string;
      hookConfiguration: string;
      observedEvents: string[];
      contextCalls: number;
      verificationStatus: string;
      verificationScope: string;
      pending: string[];
      updates: string[];
    }
  > = {};
  const installed = await installedCommand();
  const automation = await automationStatus(ws.root);
  for (const host of ["codex", "claude"] as const) {
    const entry = setup.hosts[host];
    if (!entry) continue;
    const config = await inspectIntegration(ws.root, host);
    const instructionsCurrent = config.instructionsCurrent;
    const mcp =
      config.mcpCompatible && !config.mcpDisabled && hash(config.mcp) === entry.mcpFingerprint;
    const currentHooks = config.hooksCurrent;
    const hooks = config.hooksCompatible && !config.disabled;
    const local = await loadSetupReceipt(ws.root, ws.directory, host);
    const configured =
      activation.root !== ws.root ||
      (local?.status === "configured" &&
        local.root === ws.root &&
        local.revision === entry.revision);
    const observation = await readObservation(
      ws.root,
      ws.directory,
      host,
      entry.revision,
      installed.version ?? "unavailable",
    );
    // Complete lifecycle evidence must come from one session in this worktree/branch.
    const sessions = Object.values(observation?.sessions ?? {}).sort((a, b) =>
      b.at.localeCompare(a.at),
    );
    const complete = sessions.find((session) =>
      events.every((event) => session.events.includes(event)),
    );
    const observedEvents = complete?.events ?? sessions[0]?.events ?? [];
    const pending: string[] = [];
    if (!installed.available) pending.push(installed.message!);
    if (!mcp || !hooks || !config.instructionCompatible || !configured)
      pending.push(
        "Run mason setup to activate existing configuration; incompatible shared configuration needs mason init and review. Inspect any disabled host settings.",
      );
    if (!observation?.contextCalls)
      pending.push(
        "Start a new assistant session and request task context through Mason's get_context tool.",
      );
    if (!complete)
      pending.push(
        "Review/trust the host configuration, then complete a normal task to observe the full hook lifecycle.",
      );
    if (automation.status === "unavailable")
      pending.push(
        "The latest automation attempt did not establish verification. Run mason check and inspect its diagnostics.",
      );
    const healthy =
      installed.available &&
      mcp &&
      hooks &&
      config.instructionCompatible &&
      configured &&
      automation.status !== "unavailable";
    hosts[host] = {
      status: healthy
        ? complete && observation?.contextCalls
          ? "active"
          : "pending"
        : "attention",
      runtime: installed.available ? "global (" + installed.version + ")" : "unavailable-on-path",
      mcp: mcp ? "configured" : "changed",
      instructions: instructionsCurrent
        ? "current"
        : config.instructionCompatible
          ? "compatible"
          : "incompatible",
      hookConfiguration: hooks
        ? currentHooks
          ? "configured"
          : "compatible"
        : "disabled-or-changed",
      observedEvents,
      contextCalls: observation?.contextCalls ?? 0,
      verificationScope: automation.scope,
      verificationStatus:
        automation.status === "current"
          ? (automation.verificationStatus ?? "unavailable")
          : "unavailable",
      pending,
      updates:
        config.compatible && (!currentHooks || !instructionsCurrent)
          ? [
              "Updated integration templates are available. A maintainer can run mason init --host " +
                host +
                " to update it when convenient; review and commit the configuration changes.",
            ]
          : [],
    };
  }
  const statuses = Object.values(hosts).map((host) => host.status);
  const decisions = await loadDecisionStore(ws.root);
  return {
    version: 1,
    status:
      statuses.length && statuses.every((status) => status === "active")
        ? "active"
        : statuses.includes("attention")
          ? "attention"
          : "pending",
    root: ws.root,
    hosts,
    activationRoot: activation.root,
    decisionRecords: decisions.records.length,
    diagnostics: decisions.diagnostics,
    scope:
      "Activation receipts record observed use after setup, not complete interception, correct repairs, or measured usefulness. Host trust and higher-priority settings may prevent execution. Receipts are local to this worktree and branch.",
  };
}

export function summarizeActivation(status: Awaited<ReturnType<typeof setupStatus>>): string {
  const lines = ["Mason setup: " + status.status + "."];
  if (status.activationRoot && status.activationRoot !== status.root) {
    lines.push(
      "Activation inherited from " + status.activationRoot + "; evidence belongs to this worktree.",
    );
  }
  for (const [host, state] of Object.entries(status.hosts)) {
    lines.push(
      `${host}: ${state.status}`,
      `  Runtime: ${state.runtime}; MCP: ${state.mcp}; instructions: ${state.instructions}.`,
      `  Hooks: ${state.hookConfiguration}; observed: ${state.observedEvents.join(", ") || "none"}.`,
      `  Task context requests: ${state.contextCalls}; verification: ${state.verificationStatus} (${state.verificationScope}).`,
      ...state.pending.map((message) => "  Next: " + message),
    );
    lines.push(...state.updates.map((message) => "  Optional: " + message));
  }
  if ("decisionRecords" in status) lines.push(`Decision records: ${status.decisionRecords}.`);
  if (status.next) lines.push(status.next);
  return lines.join("\n");
}
