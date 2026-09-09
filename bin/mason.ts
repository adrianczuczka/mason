import { fileURLToPath } from "node:url";
import { runAutomationCli, isHookCommand } from "../src/automation/cli.js";

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
  uninstall                  Remove that installation; retain project data

Use mason <command> --help for options. npm users can keep using mason-auto,
mason-audit, mason-review, mason-drift, mason-hook and mason-mcp.`;

try {
  if (managedLaunch) {
    if (!setupHost || !["codex", "claude"].includes(setupHost) || !["mcp", "auto"].includes(command)) throw new Error("Invalid setup invocation.");
    const { prepareLaunch } = await import("../src/setup/launcher.js");
    const active = await prepareLaunch(setupHost as "codex" | "claude", { allowInactive: command === "auto" && isHookCommand(args) });
    if (!active) process.exit(0);
  }
  if (command === "internal-integration-version") console.log(JSON.stringify({ protocol: 1, version: PKG_VERSION }));
  else if (!command || ["--help", "-h", "help"].includes(command)) console.log(usage);
  else if (["--version", "-v"].includes(command)) console.log(PKG_VERSION);
  else if (command === "internal-install") {
    if (args.length) throw new Error("internal-install takes no arguments.");
    const { installStandalone } = await import("../src/distribution/install.js");
    const bundleRoot = fileURLToPath(new URL("../..", import.meta.url));
    const installed = await installStandalone(bundleRoot);
    console.log(`Installed Mason ${installed.version} in ${installed.home}.\n${installed.path.message}`);
  } else if (command === "upgrade" || command === "uninstall") {
    if (args.includes("--help")) console.log(command === "upgrade" ? "Usage: mason upgrade [version]. Configured projects use the upgraded command on their next launch. Restart running assistants." : "Usage: mason uninstall. Removes the standalone user installation; project configuration and knowledge are retained. Run mason teardown in each project first to disconnect its integrations.");
    else {
      const { upgradeStandalone, uninstallStandalone } = await import("../src/distribution/install.js");
      if (args.length > (command === "upgrade" ? 1 : 0)) throw new Error("Unexpected arguments.");
      if (command === "upgrade") process.exitCode = await upgradeStandalone(args[0]);
      else console.log((process.platform === "win32" ? "Finishing installation cleanup after runtime exit: " : "Removed standalone installation: ") + await uninstallStandalone() + ". Project configuration and knowledge were retained. Reinstall Mason to use its integrations.");
    }
  } else if (["setup", "teardown", "status", "check", "auto"].includes(command)) {
    const forwarded = command === "auto" ? args : [command, ...args];
    let input = "";
    if (isHookCommand(forwarded) && !process.stdin.isTTY) for await (const chunk of process.stdin) {
      input += chunk.toString(); if (Buffer.byteLength(input) > 1024 * 1024) break;
    }
    process.exitCode = await runAutomationCli(forwarded, input);
  } else if (["audit", "review", "drift", "hook", "mcp"].includes(command)) {
    const binary = new URL(`./mason-${command}.js`, import.meta.url);
    process.argv = [process.execPath, fileURLToPath(binary), ...args];
    await import(binary.href);
  } else throw new Error("Unknown command: " + command + ". Run mason --help.");
} catch (error) {
  const message = "Mason: " + (error instanceof Error ? error.message : String(error));
  if (command === "auto" && isHookCommand(args)) {
    console.log(JSON.stringify({ systemMessage: message + " Verification was not established." }));
    process.exitCode = 0;
  } else { console.error(message); process.exitCode = 2; }
}
