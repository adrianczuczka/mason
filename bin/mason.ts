import { fileURLToPath } from "node:url";
import { runAutomationCli, isHookCommand } from "../src/automation/cli.js";

declare const PKG_VERSION: string;
const [command, ...args] = process.argv.slice(2);
const usage = `Mason ${PKG_VERSION}

Usage: mason <command> [options]

  setup --host codex|claude   Connect this project to your assistant
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
  if (!command || ["--help", "-h", "help"].includes(command)) console.log(usage);
  else if (["--version", "-v"].includes(command)) console.log(PKG_VERSION);
  else if (command === "internal-install") {
    if (args.length) throw new Error("internal-install takes no arguments.");
    const { sourceRuntime } = await import("../src/setup/runtime.js");
    const selected = await sourceRuntime();
    if (!selected.bundleRoot) throw new Error("This command requires a standalone bundle.");
    const { installStandalone } = await import("../src/distribution/install.js");
    const installed = await installStandalone(selected.bundleRoot);
    console.log(`Installed Mason ${installed.version} in ${installed.home}.\nLauncher: ${installed.bin}\nAdd that directory to PATH if needed, then run: mason setup --host codex`);
  } else if (command === "upgrade" || command === "uninstall") {
    if (args.includes("--help")) console.log(command === "upgrade" ? "Usage: mason upgrade [version]. Project versions change only when you rerun setup." : "Usage: mason uninstall. Removes the standalone user installation; project runtimes, configuration and knowledge are retained.");
    else {
      const { upgradeStandalone, uninstallStandalone } = await import("../src/distribution/install.js");
      if (args.length > (command === "upgrade" ? 1 : 0)) throw new Error("Unexpected arguments.");
      if (command === "upgrade") process.exitCode = await upgradeStandalone(args[0]);
      else console.log((process.platform === "win32" ? "Finishing installation cleanup after runtime exit: " : "Removed standalone installation: ") + await uninstallStandalone() + ". Project configurations and pinned runtimes were retained.");
    }
  } else if (["setup", "status", "check", "auto"].includes(command)) {
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
  console.error("Mason: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
}
