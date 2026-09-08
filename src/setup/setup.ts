import { randomUUID } from "node:crypto";
import { hash, workspace } from "../automation/evidence.js";
import { withLock, type Host } from "../automation/store.js";
import { automate } from "../automation/runtime.js";
import { inspectOnboarding } from "../mcp/onboarding.js";
import { writeStoreJson } from "../utils/storage.js";
import { applyEdit, readText } from "./files.js";
import { ancillaryEdits, hookEdits, instructionEdits, mcpEdit, inspectHostConfig } from "./config.js";
import { hookCommand, installedCommand } from "./launcher.js";
import { hookConfig } from "../automation/adapters.js";
import { loadSetup, loadSetupReceipt, SETUP_PATH, type SetupConfig } from "./model.js";
import { setupStatus } from "./status.js";
import { ownershipEdit, completedHookOwnership } from "./ownership.js";

export async function selectHost(root: string, explicit?: Host): Promise<Host> {
  if (explicit) return explicit;
  if (process.env.MASON_SETUP_HOST === "codex" || process.env.MASON_SETUP_HOST === "claude") return process.env.MASON_SETUP_HOST;
  const found: Host[] = [];
  if (await readText(root, ".codex/config.toml") !== null || await readText(root, ".codex/hooks.json") !== null) found.push("codex");
  if (await readText(root, ".claude/settings.json") !== null || await readText(root, ".mcp.json") !== null) found.push("claude");
  if (found.length === 1) return found[0];
  throw new Error("Choose the assistant for setup with --host codex or --host claude.");
}

export async function setupProject(dir: string, options: { host?: Host; base?: string; evidence?: string[] } = {}) {
  const ws = await workspace(dir);
  const host = await selectHost(ws.root, options.host);
  return withLock(ws.root, ".mason/reports/setup-lock", async () => {
    const existing = await loadSetup(ws.root);
    const previousReceipt = await loadSetupReceipt(ws.root, ws.directory, host);
    const installed = await installedCommand();
    if (!installed.available) throw new Error(installed.message!);
    // Preflight every edit before shared files change.
    const instructions = await instructionEdits(ws.root, host);
    const mcp = await mcpEdit(ws.root, host);
    const hooks = await hookEdits(ws.root, host);
    const ancillary = await ancillaryEdits(ws.root);
    const edits = [...ancillary, ...instructions, mcp, ...hooks];
    const setupBefore = await readText(ws.root, SETUP_PATH);
    const mcpFingerprint = hash((await inspectHostConfig(ws.root, host, mcp.after)).mcp);
    const desiredHooks = hookConfig(host, hookCommand(host)).hooks;
    const configuredHook = desiredHooks.SessionStart[0].hooks[0].command;
    const ownership = await ownershipEdit(ws.root, [...instructions, mcp, hooks[0]], { [hooks[0].path]: configuredHook });
    const fingerprint = hash({ command: "mason",
      mcp: mcpFingerprint, hooks: desiredHooks,
      instructions: instructions.map(edit => edit.path) });
    const previous = existing?.hosts[host];
    const changed = edits.some(edit => edit.before !== edit.after) || previous?.fingerprint !== fingerprint;
    const revision = !changed && previous ? previous.revision : randomUUID();
    const setup: SetupConfig = existing ?? { version: 2, hosts: {} };
    setup.hosts[host] = { configuredVersion: installed.version!, revision, fingerprint, mcpFingerprint, instructions: instructions.map(e => e.path) };

    // Capture through the ordinary automation engine so later hooks resume the
    // same immutable baselines. This must precede instruction and ignore edits.
    const initial = await automate(ws.root, { event: "turn_start" });
    const findings = await inspectOnboarding(ws.root, options.base, options.evidence);
    const receiptPath = ws.directory + "/setup-" + host + ".json";
    const initialReportPath = previousReceipt?.initialReportPath ?? initial.report.reportPath;
    const initialBaselinePaths = previousReceipt?.initialBaselinePaths ?? initial.report.baselinePaths;
    await writeStoreJson(ws.root, receiptPath, { version: 1, host, status: "installing", initialReportPath,
      initialBaselinePaths, root: ws.root, revision });
    const changedFiles: string[] = [];
    if (await applyEdit(ws.root, ownership)) changedFiles.push(ownership.path);
    for (const edit of edits) if (await applyEdit(ws.root, edit)) changedFiles.push(edit.path);
    if (await applyEdit(ws.root, { path: SETUP_PATH, before: setupBefore, after: JSON.stringify(setup, null, 2) + "\n" })) changedFiles.push(SETUP_PATH);
    if (await applyEdit(ws.root, await completedHookOwnership(ws.root, hooks[0].path, configuredHook)) && !changedFiles.includes(ownership.path)) changedFiles.push(ownership.path);
    // Ensure a repo that initially had no instructions now has a baseline too.
    const checked = await automate(ws.root, { event: "turn_start" });
    const configured = await inspectHostConfig(ws.root, host, undefined);
    await writeStoreJson(ws.root, receiptPath, { version: 1, host, status: "configured", initialReportPath,
      initialBaselinePaths, root: ws.root, revision, configuredAt: new Date().toISOString() });
    return { version: 1, action: "setup", status: "configured", host, root: ws.root,
      runtime: { kind: "global", command: "mason", version: installed.version }, changedFiles, initialReportPath, findings, reportPath: checked.report.reportPath,
      activation: await setupStatus(ws.root),
      next: configured.disabled || configured.mcpDisabled ? "Mason hooks or MCP are disabled in project configuration. Review that setting before activation."
        : host === "codex" ? "Review/trust this project's MCP configuration and hooks in Codex (/hooks in the CLI), then start a new session and give it a normal task."
        : "Approve the project MCP server in Claude Code, then start a new session and give it a normal task.",
    };
  });
}

export function summarizeSetup(result: Awaited<ReturnType<typeof setupProject>>): string {
  const audit = result.findings.audit;
  return [`Mason configured for ${result.host}.`,
    "  MCP server and lifecycle hooks use mason from PATH.",
    "  Project instructions updated; original audit evidence retained.",
    `  ${result.changedFiles.length} files changed.`,
    `Initial audit: ${audit.status}${"counts" in audit ? `; ${audit.counts.issues} issues, ${audit.counts.advisories + audit.counts.suppressedAdvisories} advisories` : ""}.`,
    ...("issues" in audit ? audit.issues.slice(0, 3).map(f => "  " + f.message) : []),
    `Original evidence: ${result.initialReportPath}`,
    "Activation: " + result.activation.status + ".",
    result.next,
    "If the assistant cannot find mason, restart the desktop app so it picks up PATH.",
    "After the task finishes, run mason-auto status. Configuration alone does not establish activation.",
  ].join("\n");
}
