import { automationFailure, failureMessage } from "./execution.js";
import { parseArgs } from "node:util";
import { automate, automationStatus, summarize } from "./runtime.js";
import { runAutomationHook, hookConfig } from "./adapters.js";
import { installAutomation, installedAutomation } from "./install.js";
import { hostSchema } from "./store.js";

const TEARDOWN_USAGE = `Usage: mason teardown [options]

Disconnect Mason from this Git project. Defaults to all project hosts.

  --host codex|claude         Disconnect only this host
  --dir <path>               Project directory (defaults to cwd; subdirectories work)
  --dry-run                  Preview changes without writing
  --json                     Machine-readable changes and diagnostics

Keeps shared knowledge, repair evidence, ignore rules and the Mason installation.
Edited or ambiguous entries are retained for manual cleanup. Restart assistants
after teardown. Run mason setup --host codex or --host claude to reconnect.
Exit 0: complete/no-op. Exit 2: cleanup needs attention (also in dry runs).`;

const USAGE = `Usage: mason-auto <setup|teardown|install|config|status|check|hook> [options]

  setup [--host claude|codex]  Connect MCP, instructions and hooks to mason on PATH; retain the initial audit
  teardown [--host claude|codex] Disconnect one host or all project hosts; retain knowledge and evidence
  install --host claude|codex  Merge lifecycle hooks into this project's host config
  config --host claude|codex   Print the host config without writing
  status                      Read configured hooks and observed runtime events
  check                       Capture/resume and verify retained audit evidence
  hook --host claude|codex     Handle host JSON on stdin

  --dir <path>                Project directory (defaults to cwd)
  --command <prefix>          Installed executable prefix for install/config
  --dry-run                   Preview teardown without writing
  --json                      Machine-readable output (status also uses JSON when piped)

check exits 0 for verified checks, 1 for issues, 2 for incomplete/unavailable.
teardown exits 0 for complete/no-op, 2 when cleanup needs attention (also in dry runs).
Hooks are advisory and exit 0; a failed capture is reported explicitly.
Local evidence is written under .mason/reports/. No LLM calls or source edits.`;

const parseCli = (argv: string[]) => parseArgs({ args: argv, allowPositionals: true, options: {
      dir: { type: "string" }, host: { type: "string" }, command: { type: "string" }, json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      "dry-run": { type: "boolean" },
    } });
export function isHookCommand(argv: string[]): boolean {
  try { const parsed = parseCli(argv); return parsed.positionals[0] === "hook" && !parsed.values.help; }
  catch { return false; }
}

export async function runAutomationCli(argv: string[], stdin = "", io = {
  out: (s: string) => process.stdout.write(s + "\n"), err: (s: string) => process.stderr.write(s + "\n"),
}): Promise<number> {
  let action = "";
  try {
    const { values, positionals } = parseCli(argv);
    if (values.help || !positionals.length) { io.out(positionals[0] === "teardown" ? TEARDOWN_USAGE : USAGE); return 0; }
    if (positionals.length !== 1) throw new Error("Expected one command.");
    [action] = positionals;
    const dir = values.dir ?? process.cwd();
    if (values["dry-run"] !== undefined && action !== "teardown") throw new Error("--dry-run applies only to teardown.");
    if (action === "teardown") {
      if (values.command !== undefined) throw new Error("--command applies only to install/config.");
      const { teardownProject, summarizeTeardown } = await import("../setup/teardown.js");
      const result = await teardownProject(dir, { host: values.host === undefined ? undefined : hostSchema.parse(values.host), dryRun: values["dry-run"] });
      io.out(values.json ? JSON.stringify(result, null, 2) : summarizeTeardown(result));
      return result.status === "complete" ? 0 : 2;
    }
    if (action === "hook") {
      const output = await runAutomationHook(hostSchema.parse(values.host), stdin);
      if (output) io.out(JSON.stringify(output));
      return 0;
    }
    if (action === "setup") {
      if (values.command) throw new Error("--command applies to install/config, not managed setup.");
      const { setupProject, summarizeSetup } = await import("../setup/setup.js");
      const result = await setupProject(dir, { host: values.host ? hostSchema.parse(values.host) : undefined });
      io.out(values.json ? JSON.stringify(result, null, 2) : summarizeSetup(result));
      return 0;
    }
    if (action === "install" || action === "config") {
      const host = hostSchema.parse(values.host);
      io.out(JSON.stringify(action === "install" ? await installAutomation(dir, host, values.command) : hookConfig(host, values.command), null, 2));
      return 0;
    }
    if (values.host || values.command) throw new Error("--host and --command apply only to install/config/hook.");
    if (action === "status") {
      const { setupStatus, summarizeActivation } = await import("../setup/status.js");
      const setup = await setupStatus(dir);
      const result = { ...await automationStatus(dir), configured: await installedAutomation(dir), setup };
      io.out(values.json || !process.stdout.isTTY ? JSON.stringify(result, null, 2) : summarizeActivation(setup));
      return 0;
    }
    if (action !== "check") throw new Error("Unknown automation command: " + action);
    const { report } = await automate(dir, { event: "task_end" });
    io.out(values.json ? JSON.stringify(report, null, 2) : summarize(report));
    return report.status === "verified" ? 0 : report.status === "issues-remain" ? 1 : 2;
  } catch (error) {
    const message = action === "setup" ? "Mason setup incomplete: " + automationFailure(error).message + ". Rerun the same setup command to resume; retained audit evidence is preserved."
      : action === "teardown" ? "Mason teardown incomplete: " + automationFailure(error).message + ". Inspect the reported input, then rerun teardown; knowledge and repair evidence are retained."
      : failureMessage(error);
    if (action === "hook" || isHookCommand(argv)) { io.out(JSON.stringify({ systemMessage: message })); return 0; }
    if (argv.includes("--json")) io.out(JSON.stringify({ version: 1, ...(["setup", "teardown"].includes(action) ? { action, status: "incomplete", next: "Inspect the reported input, then rerun the same command to resume." } : { status: "unavailable" }), failure: automationFailure(error) }));
    else io.err(message);
    return 2;
  }
}
