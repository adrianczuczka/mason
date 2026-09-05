import { z } from "zod";
import { automate, type AutomationEvent } from "./runtime.js";
import { hostSchema, type Host } from "./store.js";

const inputSchema = z.object({
  cwd: z.string().min(1), session_id: z.string().min(1).max(500),
  hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]),
  tool_name: z.string().optional(), tool_use_id: z.string().max(500).optional(),
  tool_input: z.unknown().optional(), stop_hook_active: z.boolean().optional(), permission_mode: z.string().optional(),
});
const lifecycle: Record<z.infer<typeof inputSchema>["hook_event_name"], AutomationEvent["event"]> = {
  SessionStart: "session_start", UserPromptSubmit: "turn_start", PreToolUse: "before_tool", PostToolUse: "after_tool", Stop: "task_end",
};

/** Shell and unknown/MCP tools are conservatively observed: edits need not use a file editor. */
export function normalizeHook(host: Host, raw: unknown): { cwd: string; name: string; event: AutomationEvent } {
  hostSchema.parse(host);
  const input = inputSchema.parse(raw);
  const readOnly = host === "claude" ? /^(Read|Glob|Grep|WebSearch|WebFetch)$/ : /^(read_file|list_dir|grep_files)$/;
  return { cwd: input.cwd, name: input.hook_event_name, event: {
    event: lifecycle[input.hook_event_name], host, sessionId: input.session_id, toolId: input.tool_use_id,
    mutating: !!input.tool_name && !readOnly.test(input.tool_name),
    stopHookActive: input.stop_hook_active || input.permission_mode === "plan",
  } };
}

export async function runAutomationHook(host: Host, stdin: string): Promise<Record<string, unknown> | null> {
  let name = "";
  try {
    if (Buffer.byteLength(stdin) > 1024 * 1024) throw new Error("Hook input exceeds 1 MiB.");
    const input = normalizeHook(host, JSON.parse(stdin));
    name = input.name;
    const result = await automate(input.cwd, input.event);
    if (!result.message) return null;
    if (name === "Stop") {
      // A single continuation for actionable task findings; advisories never create a loop.
      return result.continueOnce ? { decision: "block", reason: result.message } : { systemMessage: result.message };
    }
    return { hookSpecificOutput: { hookEventName: name, additionalContext: result.message } };
  } catch (error) {
    const message = "Mason automation unavailable; evidence capture/verification was not established. " +
      (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 700);
    // Hook failure is visible but does not turn documentation advice into an editing permission gate.
    return { systemMessage: message, ...(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(name)
      ? { hookSpecificOutput: { hookEventName: name, additionalContext: message } } : {}) };
  }
}

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
export function hookConfig(host: Host, command = "npx --no-install --package mason-context mason-auto") {
  const handler = { type: "command", command: command + " hook --host " + host, timeout: 30 };
  return { hooks: Object.fromEntries(HOOK_EVENTS.map(name => [name,
    [{ ...(["PreToolUse", "PostToolUse"].includes(name) ? { matcher: ".*" } : {}), hooks: [{ ...handler }] }],
  ])) };
}
