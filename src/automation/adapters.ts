import { retrievedDecisions } from "./usefulness.js";
import { failureMessage, hookFailureMessage } from "./execution.js";
import { z } from "zod";
import { automate, observeReadOnlyTool, type AutomationEvent } from "./runtime.js";
import { hostSchema, type Host } from "./store.js";
import { resolveHookRoot } from "./hook-root.js";
import { runHook } from "../hook/hook.js";

const inputSchema = z.object({
  cwd: z.string().min(1),
  session_id: z.string().min(1).max(500),
  hook_event_name: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ]),
  tool_name: z.string().optional(),
  tool_use_id: z.string().max(500).optional(),
  tool_response: z.unknown().optional(),
  tool_input: z.unknown().optional(),
  stop_hook_active: z.boolean().optional(),
  permission_mode: z.string().optional(),
});
const lifecycle: Record<z.infer<typeof inputSchema>["hook_event_name"], AutomationEvent["event"]> =
  {
    SessionStart: "session_start",
    UserPromptSubmit: "turn_start",
    PreToolUse: "before_tool",
    PostToolUse: "after_tool",
    Stop: "task_end",
  };

/** Reuse the existing file-scoped injector; never infer file targets from shell text. */
async function decisionContext(host: Host, raw: unknown, root: string): Promise<string | null> {
  const input = inputSchema.parse(raw);
  if (
    host !== "claude" ||
    !(
      (input.hook_event_name === "PostToolUse" && input.tool_name === "Read") ||
      (input.hook_event_name === "PreToolUse" && ["Edit", "Write"].includes(input.tool_name ?? ""))
    )
  )
    return null;
  try {
    const output = await runHook(JSON.stringify(raw), {
      rootDir: root,
      hookEventName: input.hook_event_name,
    });
    if (!output) return null;
    const parsed: unknown = JSON.parse(output);
    return z
      .object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) })
      .parse(parsed).hookSpecificOutput.additionalContext;
  } catch (error) {
    // Delivery failure must not discard an audit notice or an activation diagnostic.
    return failureMessage(error) + " Decision knowledge was not delivered.";
  }
}

/** Shell and unknown/MCP tools are conservatively observed: edits need not use a file editor. */
export function normalizeHook(
  host: Host,
  raw: unknown,
): { cwd: string; name: string; readOnly: boolean; event: AutomationEvent } {
  hostSchema.parse(host);
  const input = inputSchema.parse(raw);
  const readOnly = (
    host === "claude"
      ? /^(Read|Glob|Grep|WebSearch|WebFetch)$/
      : /^(read_file|list_dir|grep_files|Read|Glob|Grep)$/
  ).test(input.tool_name ?? "");
  return {
    cwd: input.cwd,
    name: input.hook_event_name,
    readOnly,
    event: {
      event: lifecycle[input.hook_event_name],
      host,
      sessionId: input.session_id,
      toolId: input.tool_use_id,
      stopHookActive: input.stop_hook_active,
      mutating: !!input.tool_name && !readOnly,
      ...(input.hook_event_name === "PostToolUse"
        ? { retrievedDecisionIds: retrievedDecisions(input.tool_name, input.tool_response) }
        : {}),
    },
  };
}

export async function runAutomationHook(
  host: Host,
  stdin: string,
  options: { managed?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  let name = "";
  let hook: ReturnType<typeof normalizeHook> | undefined;
  try {
    if (Buffer.byteLength(stdin) > 1024 * 1024) throw new Error("Hook input exceeds 1 MiB.");
    let raw: unknown;
    try {
      raw = JSON.parse(stdin);
    } catch {
      throw new Error("Hook input is not valid JSON.");
    }
    const input = normalizeHook(host, raw);
    hook = input;
    name = input.name;
    if (options.managed) {
      input.cwd = await resolveHookRoot(host, input.cwd);
      const { prepareLaunch } = await import("../setup/launcher.js");
      if (!(await prepareLaunch(host, { dir: input.cwd, allowInactive: true }))) return null;
    }
    if (["before_tool", "after_tool"].includes(input.event.event) && input.readOnly) {
      const observed = await observeReadOnlyTool(input.cwd, input.event);
      const { observeActivation } = await import("../setup/observations.js");
      const warning = await observeActivation(observed.root, input.event.event, {
        sessionId: input.event.sessionId,
        directory: observed.directory,
      });
      const knowledge = await decisionContext(host, raw, observed.root);
      return knowledge
        ? {
            ...(warning ? { systemMessage: warning } : {}),
            hookSpecificOutput: { hookEventName: name, additionalContext: knowledge },
          }
        : warning
          ? { systemMessage: warning }
          : null;
    }
    const result = await automate(input.cwd, input.event);
    const { observeActivation } = await import("../setup/observations.js");
    const warning = await observeActivation(result.report.root, input.event.event, {
      sessionId: input.event.sessionId,
      verificationStatus: result.report.status,
      reportPath: result.report.reportPath,
    });
    if (warning) result.message = [result.message, warning].filter(Boolean).join("\n");
    const knowledge = await decisionContext(host, raw, result.report.root);
    if (knowledge) result.message = [result.message, knowledge].filter(Boolean).join("\n\n");
    if (name === "Stop" && result.stopBlockReason) {
      return { decision: "block", reason: result.message ?? result.stopBlockReason };
    }
    if (!result.message) return null;
    if (name === "Stop") {
      // Re-entry remains advisory; delivery does not resolve the finding.
      return { systemMessage: result.message };
    }
    return { hookSpecificOutput: { hookEventName: name, additionalContext: result.message } };
  } catch (error) {
    const message = hook
      ? await hookFailureMessage(hook.cwd, host, hook.event.sessionId!, error)
      : failureMessage(error);
    if (!message) return null;
    // Hook failure is visible but does not turn documentation advice into an editing permission gate.
    return {
      systemMessage: message,
      ...(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(name)
        ? { hookSpecificOutput: { hookEventName: name, additionalContext: message } }
        : {}),
    };
  }
}

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;
/** Only guard Mason's generated launch, never interpret a custom command prefix. */
export function managedHookCommand(host: Host, platform = process.platform, legacy = false) {
  const command = `mason --setup-host ${host}${legacy ? " auto" : ""} hook --host ${host}`;
  return platform === "win32"
    ? `cmd.exe /d /s /c "where mason >nul 2>nul & if errorlevel 1 (exit /b 0) else (${command})"`
    : `if command -v mason >/dev/null 2>&1; then ${command}; fi`;
}
export function knownManagedHookCommands(host: Host) {
  return [
    "npx --no-install --package mason-context mason auto hook --host " + host,
    "npx --no-install --package mason-context mason hook --host " + host,
    managedHookCommand(host, "linux"),
    managedHookCommand(host, "win32"),
    managedHookCommand(host, "linux", true),
    managedHookCommand(host, "win32", true),
    `mason --setup-host ${host} hook --host ${host}`,
    `mason --setup-host ${host} auto hook --host ${host}`,
  ];
}
/** Migration recognizes both platforms; runtime compatibility is platform-specific. */
export function compatibleManagedHookCommands(host: Host, platform = process.platform) {
  return [
    managedHookCommand(host, platform),
    managedHookCommand(host, platform, true),
    `mason --setup-host ${host} hook --host ${host}`,
    `mason --setup-host ${host} auto hook --host ${host}`,
  ];
}
export function hookConfig(host: Host, command = "npx --no-install --package mason-context mason") {
  const handler = {
    type: "command",
    command: [`mason --setup-host ${host}`, `mason --setup-host ${host} auto`].includes(command)
      ? managedHookCommand(host)
      : command + " hook --host " + host,
    timeout: 30,
  };
  return {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((name) => [
        name,
        [
          {
            ...(["PreToolUse", "PostToolUse"].includes(name) ? { matcher: ".*" } : {}),
            hooks: [{ ...handler }],
          },
        ],
      ]),
    ),
  };
}
