import { randomUUID } from "node:crypto";
import { git, hash, workspace } from "../automation/evidence.js";
import { withLock, type Host } from "../automation/store.js";
import { writeStoreJson } from "../utils/storage.js";
import { applyEdit, readText } from "./files.js";
import {
  ancillaryEdits,
  hookEdits,
  instructionEdits,
  mcpEdit,
  inspectIntegration,
  mcpPath,
} from "./config.js";
import { hookConfig } from "../automation/adapters.js";
import { configPath } from "../automation/install.js";
import { hookCommand, installedCommand } from "./launcher.js";
import { loadSetup, loadSetupReceipt, SETUP_PATH, type SetupConfig } from "./model.js";
import { setupStatus } from "./status.js";
import { ownershipEdit, completedHookOwnership } from "./ownership.js";
import type { Progress } from "../utils/progress.js";

export async function selectHost(root: string, explicit?: Host): Promise<Host> {
  if (explicit) return explicit;
  if (process.env.MASON_SETUP_HOST === "codex" || process.env.MASON_SETUP_HOST === "claude")
    return process.env.MASON_SETUP_HOST;
  const found: Host[] = [];
  if (
    (await readText(root, ".codex/config.toml")) !== null ||
    (await readText(root, ".codex/hooks.json")) !== null
  )
    found.push("codex");
  if (
    (await readText(root, ".claude/settings.json")) !== null ||
    (await readText(root, ".mcp.json")) !== null
  )
    found.push("claude");
  if (found.length === 1) return found[0];
  throw new Error("Choose the assistant for setup with --host codex or --host claude.");
}

export async function setupProject(
  dir: string,
  options: { host?: Host; progress?: Progress } = {},
) {
  options.progress?.step("Checking project configuration");
  const ws = await workspace(dir);
  const host = await selectHost(ws.root, options.host);
  if (
    (
      await git(
        ws.root,
        "ls-files",
        "--",
        ".mason/local",
        ws.directory,
        ".mason/reports/setup-lock",
      )
    ).trim()
  )
    throw new Error("Mason local state must be untracked before setup can activate this checkout.");
  return withLock(ws.root, ".mason/reports/setup-lock", async () => {
    const existing = await loadSetup(ws.root);
    const previousReceipt = await loadSetupReceipt(ws.root, ws.directory, host);
    const installed = await installedCommand();
    if (!installed.available) throw new Error(installed.message!);
    const configured = await inspectIntegration(ws.root, host);
    if (!configured.compatible)
      throw new Error(
        "Shared Mason configuration is missing or incompatible. A maintainer should run mason init --host " +
          host +
          " and review/commit the changes. Local setup did not edit shared files.",
      );
    const privatePaths = [SETUP_PATH, ws.directory + "/setup-" + host + ".json"];
    const ignored = (
      await git(ws.root, "check-ignore", "--no-index", "--", ...privatePaths).catch(() => "")
    )
      .trim()
      .split("\n");
    if (!privatePaths.every((file) => ignored.includes(file)))
      throw new Error(
        "Mason local state must be ignored. A maintainer should run mason init and commit the ignore rules.",
      );
    const instructions = configured.instructions;
    const sharedInputs = [
      ...instructions.map((edit) => ({ path: edit.path, before: edit.before })),
      { path: mcpPath(host), before: await readText(ws.root, mcpPath(host)) },
      { path: configPath(host), before: await readText(ws.root, configPath(host)) },
    ];
    const hooks = await hookEdits(ws.root, host);
    const edits = hooks.slice(1);
    const setupBefore = await readText(ws.root, SETUP_PATH);
    const mcpFingerprint = hash(configured.mcp);
    const fingerprint = hash({
      command: "mason",
      mcp: mcpFingerprint,
      hooks: configured.hooks,
      instructions: instructions.map((edit) => edit.path),
    });
    const previous = existing?.hosts[host];
    const changed =
      edits.some((edit) => edit.before !== edit.after) || previous?.fingerprint !== fingerprint;
    const revision = !changed && previous ? previous.revision : randomUUID();
    const setup: SetupConfig = existing ?? { version: 2, hosts: {} };
    setup.hosts[host] = {
      configuredVersion: installed.version!,
      revision,
      fingerprint,
      mcpFingerprint,
      instructions: instructions.map((e) => e.path),
    };

    const receiptPath = ws.directory + "/setup-" + host + ".json";
    // Preserve legacy audit pointers without reading or verifying their artifacts.
    const legacyEvidence = previousReceipt?.initialReportPath
      ? {
          initialReportPath: previousReceipt.initialReportPath,
          initialBaselinePaths: previousReceipt.initialBaselinePaths ?? [],
        }
      : {};
    options.progress?.step(`Activating ${host === "codex" ? "Codex" : "Claude Code"} integration`);
    await writeStoreJson(ws.root, receiptPath, {
      version: 1,
      host,
      status: "installing",
      ...legacyEvidence,
      root: ws.root,
      revision,
    });
    const changedFiles: string[] = [];
    for (const edit of edits) if (await applyEdit(ws.root, edit)) changedFiles.push(edit.path);
    if (
      await applyEdit(ws.root, {
        path: SETUP_PATH,
        before: setupBefore,
        after: JSON.stringify(setup, null, 2) + "\n",
      })
    )
      changedFiles.push(SETUP_PATH);
    options.progress?.step("Checking agent configuration");
    for (const input of sharedInputs)
      if ((await readText(ws.root, input.path)) !== input.before)
        throw new Error(input.path + " changed during setup; inspect it and retry.");
    await writeStoreJson(ws.root, receiptPath, {
      version: 1,
      host,
      status: "configured",
      ...legacyEvidence,
      root: ws.root,
      revision,
      configuredAt: new Date().toISOString(),
    });
    return {
      version: 1,
      action: "setup",
      mode: "activate",
      status: "configured",
      host,
      root: ws.root,
      runtime: { kind: "global", command: "mason", version: installed.version },
      changedFiles,
      receiptPath,
      activation: await setupStatus(ws.root),
      next:
        configured.disabled || configured.mcpDisabled
          ? "Mason hooks or MCP are disabled in project configuration. Review that setting before activation."
          : host === "codex"
            ? "Review/trust this project's MCP configuration and hooks in Codex (/hooks in the CLI), then start a new session and give it a normal task."
            : "Approve the project MCP server in Claude Code, then start a new session and give it a normal task.",
    };
  });
}

export function summarizeSetup(result: Awaited<ReturnType<typeof setupProject>>): string {
  return [
    `Mason configured for ${result.host}.`,
    "  MCP server and lifecycle hooks use mason from PATH.",
    "  Existing shared configuration validated; only local activation state was written.",
    `  ${result.changedFiles.length} files changed.`,
    "Activation: " + result.activation.status + ".",
    result.next,
    "If the assistant cannot find mason, restart the desktop app so it picks up PATH.",
    "After the task finishes, run mason status. Configuration alone does not establish activation.",
  ].join("\n");
}

export async function initializeProject(
  dir: string,
  options: { host?: Host; dryRun?: boolean; progress?: Progress } = {},
) {
  const ws = await workspace(dir);
  const host = await selectHost(ws.root, options.host);
  const run = async (apply: boolean) => {
    const instructions = await instructionEdits(ws.root, host);
    const mcp = await mcpEdit(ws.root, host);
    const hooks = await hookEdits(ws.root, host);
    const edits = [...(await ancillaryEdits(ws.root)), ...instructions, mcp, hooks[0]];
    // Ownership is local bookkeeping for safe removal, never an activation receipt.
    const configuredHook = hookConfig(host, hookCommand(host)).hooks.SessionStart[0].hooks[0]
      .command;
    const ownership = await ownershipEdit(ws.root, [...instructions, mcp, hooks[0]], {
      [hooks[0].path]: configuredHook,
    });
    if (apply) {
      options.progress?.step("Preparing shared agent configuration");
      await applyEdit(ws.root, ownership);
      for (const edit of edits) await applyEdit(ws.root, edit);
      await applyEdit(
        ws.root,
        await completedHookOwnership(ws.root, hooks[0].path, configuredHook),
      );
    }
    return {
      version: 1,
      action: "init",
      status: options.dryRun ? "preview" : "initialized",
      host,
      root: ws.root,
      dryRun: !!options.dryRun,
      changes: edits
        .filter((edit) => edit.before !== edit.after)
        .map((edit) => ({
          path: edit.path,
          action: edit.before === null ? "create" : "update",
        })),
      next:
        "Review and commit shared configuration, then run mason setup --host " +
        host +
        " in each developer's checkout.",
    };
  };
  if (options.dryRun) return run(false);
  if ((await git(ws.root, "ls-files", "--", ".mason/local", ".mason/reports/setup-lock")).trim())
    throw new Error("Mason local bookkeeping must be untracked before initialization.");
  return withLock(ws.root, ".mason/reports/setup-lock", () => run(true));
}

export function summarizeInitialization(result: Awaited<ReturnType<typeof initializeProject>>) {
  return [
    `Mason initialization${result.dryRun ? " preview" : ""} for ${result.host}.`,
    ...result.changes.map(
      (change) => `  ${result.dryRun ? "Would " : ""}${change.action}: ${change.path}`,
    ),
    ...(!result.changes.length ? ["Shared configuration is current; no changes needed."] : []),
    result.dryRun ? "Preview only; no files were changed." : result.next,
  ].join("\n");
}
