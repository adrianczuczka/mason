import { fileURLToPath } from "node:url";
import { runAutomationCli, isHookCommand } from "../src/automation/cli.js";
import { createProgress, type Progress } from "../src/utils/progress.js";

declare const PKG_VERSION: string;
const inputArgs = process.argv.slice(2);
const managedLaunch = inputArgs[0] === "--setup-host";
const setupHost = managedLaunch ? inputArgs.splice(0, 2)[1] : undefined;
const [command, ...args] = inputArgs;
const usage = `Mason ${PKG_VERSION}

Usage: mason <command> [options]

  setup --host codex|claude   Connect this project to your assistant
  teardown [--host codex|claude] Disconnect project integrations; retain knowledge
  status                     Show configuration, observed use and verification
  check                      Resume and verify retained documentation findings
  audit                      Audit project instructions
  review --base <ref>         Review committed changes
  drift                      Check an optional architecture map
  mcp                        Run the MCP server (stdio)
  upgrade [version]          Upgrade the standalone user installation
  updates [status|enable|disable|pin|unpin]
                             Manage automatic standalone updates
  rollback                   Restore and pin the previous standalone version
  uninstall                  Remove that installation; retain project data

Use mason <command> --help for options. npm users can keep using mason-auto,
mason-audit, mason-review, mason-drift, mason-hook and mason-mcp.`;

let progress: Progress | undefined;
try {
  if (managedLaunch) {
    if (!setupHost || !["codex", "claude"].includes(setupHost) || !["mcp", "auto"].includes(command)) throw new Error("Invalid setup invocation.");
    // Hook setup is checked against the parsed payload's checkout, after stdin
    // is read. MCP can explain missing setup over the protocol in a fresh clone.
    if (!(command === "auto" && isHookCommand(args))) {
      const { prepareLaunch } = await import("../src/setup/launcher.js");
      await prepareLaunch(setupHost as "codex" | "claude", { allowInactive: command === "mcp" });
    }
  }
  if (command === "internal-integration-version") console.log(JSON.stringify({ protocol: 1, version: PKG_VERSION }));
  else if (!command || ["--help", "-h", "help"].includes(command)) console.log(usage);
  else if (["--version", "-v"].includes(command)) console.log(PKG_VERSION);
  else if (command === "internal-update") {
    if (args.length) throw new Error("internal-update takes no arguments.");
    const { currentInstallation } = await import("../src/distribution/state.js");
    const { runAutomaticUpdate } = await import("../src/distribution/updates.js");
    await runAutomaticUpdate((await currentInstallation()).home);
  }
  else if (command === "internal-install") {
    if (args.length) throw new Error("internal-install takes no arguments.");
    const { installStandalone } = await import("../src/distribution/install.js");
    const bundleRoot = fileURLToPath(new URL("../..", import.meta.url));
    progress = createProgress();
    const policyRevision = process.env.MASON_UPDATE_POLICY_REVISION;
    if (policyRevision && !/^[a-f0-9]{64}$/.test(process.env.MASON_EXPECTED_SHA256 ?? "")) throw new Error("Automatic staging requires a verified release checksum.");
    const installed = await installStandalone(bundleRoot, progress, { stageOnly: !!policyRevision, policyRevision });
    progress.stop();
    const outcome = installed.previousVersion && installed.previousVersion !== installed.version
      ? `Updated Mason ${installed.previousVersion} → ${installed.version}` : `Installed Mason ${installed.version}`;
    if (policyRevision) console.log(`Staged Mason ${installed.version}. It will activate at a future MCP launch after existing servers exit.`);
    else {
      const { updateStatus } = await import("../src/distribution/updates.js");
      const status = await updateStatus(installed.home);
      const policy = status.pinnedVersion ? `pinned to ${status.pinnedVersion}` : status.mirror ? "managed by your mirror" : status.enabled ? "enabled" : "disabled";
      console.log(`${outcome} in ${installed.home}.\n${installed.path.message}\nAutomatic updates: ${policy}. Manage with mason updates.`);
    }
  } else if (command === "updates") {
    if (args.includes("--help")) console.log("Usage: mason updates [status|enable|disable|pin|unpin] [--json]. Pin holds the installed version; mason upgrade <version> installs and pins a specific release. Environment and mirror restrictions still apply.");
    else {
      const action = args.filter(arg => arg !== "--json")[0] ?? "status";
      if (args.filter(arg => arg !== "--json").length > 1 || !["status", "enable", "disable", "pin", "unpin"].includes(action)) throw new Error("Usage: mason updates [status|enable|disable|pin|unpin] [--json]");
      const { currentInstallation } = await import("../src/distribution/state.js");
      const { updateSettings, updateStatus, scheduleAutomaticUpdate } = await import("../src/distribution/updates.js");
      const { home } = await currentInstallation();
      if (action !== "status") await updateSettings(home, action as "enable" | "disable" | "pin" | "unpin");
      const status = await updateStatus(home);
      if (args.includes("--json")) console.log(JSON.stringify(status));
      else {
        console.log(`Mason ${status.version}\nAutomatic updates: ${status.effective ? "enabled" : "inactive"} (preference: ${status.enabled ? "enabled" : "disabled"}).`);
        if (status.pinnedVersion) console.log(`Pinned to ${status.pinnedVersion}. Run mason updates unpin to follow stable releases.`);
        if (status.mirror) console.log("Company mirror installation: automatic public updates are disabled.");
        if (!status.effective && status.enabled && !status.pinnedVersion && !status.mirror) console.log("Suppressed by CI, MASON_NO_AUTO_UPDATE, MASON_VERSION, or MASON_RELEASE_BASE.");
        if (status.pendingVersion) console.log(`Downloaded ${status.pendingVersion}; activates on a future MCP launch after existing servers exit.`);
        if (status.lastCheck) {
          console.log(`Last check: ${new Date(status.lastCheck.lastAttempt).toISOString()}`);
          if (status.lastCheck.availableVersion) console.log(`Available stable release: ${status.lastCheck.availableVersion}`);
          if (status.lastCheck.error) console.log(`Last update problem: ${status.lastCheck.error}`);
        }
      }
      if (action === "enable" || action === "unpin") void scheduleAutomaticUpdate();
    }
  } else if (command === "rollback") {
    if (args.includes("--help")) console.log("Usage: mason rollback. Close running Mason MCP servers, then restore and pin the previous installed version.");
    else {
      if (args.length) throw new Error("rollback takes no arguments.");
      const { rollbackStandalone } = await import("../src/distribution/install.js");
      const restored = await rollbackStandalone();
      console.log(`Restored Mason ${restored.version} and pinned it. Run mason updates unpin to resume automatic updates.`);
    }
  } else if (command === "upgrade" || command === "uninstall") {
    if (args.includes("--help")) console.log(command === "upgrade" ? "Usage: mason upgrade [version]. Configured projects use the upgraded command on their next launch. Restart running assistants." : "Usage: mason uninstall. Removes the standalone user installation; project configuration and knowledge are retained. Run mason teardown in each project first to disconnect its integrations.");
    else {
      const { upgradeStandalone, uninstallStandalone } = await import("../src/distribution/install.js");
      if (args.length > (command === "upgrade" ? 1 : 0)) throw new Error("Unexpected arguments.");
      if (command === "upgrade") {
        progress = createProgress();
        process.exitCode = await upgradeStandalone(args[0], progress);
        if (process.exitCode === 0) console.log("Restart running assistants to use this installation. Existing project integrations use mason from PATH.");
      }
      else console.log((process.platform === "win32" ? "Finishing installation cleanup after runtime exit: " : "Removed standalone installation: ") + await uninstallStandalone() + ". Project configuration and knowledge were retained. Reinstall Mason to use its integrations.");
    }
  } else if (["setup", "teardown", "status", "check", "auto"].includes(command)) {
    const forwarded = command === "auto" ? args : [command, ...args];
    let input = "";
    if (isHookCommand(forwarded) && !process.stdin.isTTY) for await (const chunk of process.stdin) {
      input += chunk.toString(); if (Buffer.byteLength(input) > 1024 * 1024) break;
    }
    process.exitCode = await runAutomationCli(forwarded, input, undefined,
      { managedHost: managedLaunch ? setupHost as "codex" | "claude" : undefined });
    if (command === "setup" && process.exitCode === 0 && !args.includes("--help")) {
      const { scheduleAutomaticUpdate } = await import("../src/distribution/updates.js");
      void scheduleAutomaticUpdate();
    }
  } else if (["audit", "review", "drift", "hook", "mcp"].includes(command)) {
    const binary = new URL(`./mason-${command}.js`, import.meta.url);
    process.argv = [process.execPath, fileURLToPath(binary), ...args];
    await import(binary.href);
  } else throw new Error("Unknown command: " + command + ". Run mason --help.");
} catch (error) {
  progress?.stop(false);
  const message = "Mason: " + (error instanceof Error ? error.message : String(error));
  if (command === "auto" && isHookCommand(args)) {
    console.log(JSON.stringify({ systemMessage: message + " Verification was not established." }));
    process.exitCode = 0;
  } else { console.error(message); process.exitCode = 2; }
}
