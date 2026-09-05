import { parseArgs } from "node:util";
import { automate, automationStatus, summarize } from "./runtime.js";
import { runAutomationHook, hookConfig } from "./adapters.js";
import { installAutomation, installedAutomation } from "./install.js";
import { hostSchema } from "./store.js";

const USAGE = `Usage: mason-auto <install|config|status|check|hook> [options]

  install --host claude|codex  Merge lifecycle hooks into this project's host config
  config --host claude|codex   Print the host config without writing
  status                      Read configured hooks and observed runtime events
  check                       Capture/resume and verify retained audit evidence
  hook --host claude|codex     Handle host JSON on stdin

  --dir <path>                Project directory (defaults to cwd)
  --command <prefix>          Installed executable prefix for install/config
  --json                      Machine-readable check output (status always uses JSON)

check exits 0 for verified checks, 1 for issues, 2 for incomplete/unavailable.
Hooks are advisory and exit 0; a failed capture is reported explicitly.
Local evidence is written under .mason/reports/. No LLM calls or source edits.`;

export async function runAutomationCli(argv: string[], stdin = "", io = {
  out: (s: string) => process.stdout.write(s + "\n"), err: (s: string) => process.stderr.write(s + "\n"),
}): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      dir: { type: "string" }, host: { type: "string" }, command: { type: "string" }, json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    } });
    if (values.help || !positionals.length) { io.out(USAGE); return 0; }
    if (positionals.length !== 1) throw new Error("Expected one command.");
    const [action] = positionals;
    const dir = values.dir ?? process.cwd();
    if (action === "hook") {
      const output = await runAutomationHook(hostSchema.parse(values.host), stdin);
      if (output) io.out(JSON.stringify(output));
      return 0;
    }
    if (action === "install" || action === "config") {
      const host = hostSchema.parse(values.host);
      io.out(JSON.stringify(action === "install" ? await installAutomation(dir, host, values.command) : hookConfig(host, values.command), null, 2));
      return 0;
    }
    if (values.host || values.command) throw new Error("--host and --command apply only to install/config/hook.");
    if (action === "status") {
      io.out(JSON.stringify({ ...await automationStatus(dir), configured: await installedAutomation(dir) }, null, 2));
      return 0;
    }
    if (action !== "check") throw new Error("Unknown automation command: " + action);
    const { report } = await automate(dir, { event: "task_end" });
    io.out(values.json ? JSON.stringify(report, null, 2) : summarize(report));
    return report.status === "verified" ? 0 : report.status === "issues-remain" ? 1 : 2;
  } catch (error) {
    const message = "Mason automation unavailable: " + (error instanceof Error ? error.message : String(error));
    if (argv.includes("hook")) { io.out(JSON.stringify({ systemMessage: message })); return 0; }
    io.err(message);
    return 2;
  }
}
