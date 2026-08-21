import { runHook } from "./hook.js";
import type { HookEnv } from "./hook.js";

export const USAGE = `Usage: mason-hook [--print-config | --help]

Claude Code PostToolUse hook: when the session reads or edits a file that a
Mason decision record anchors, the record is injected into the model's
context. Deterministic lookup, no LLM call; silent when nothing matches.

Reads the hook JSON on stdin and prints the hook output JSON on stdout.
Register it via .claude/settings.json (committed to the repo, so the whole
team gets the same rail):

  mason-hook --print-config   Print the settings.json hooks block

Repeat injections are deduped per session; state lives in the OS temp dir.`;

export const SETTINGS_CONFIG = {
  hooks: {
    PostToolUse: [
      {
        matcher: "Read|Edit|Write",
        hooks: [
          {
            type: "command",
            command: "npx -y -p mason-context mason-hook",
            timeout: 10,
          },
        ],
      },
    ],
  },
};

export interface HookCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function runHookCli(
  argv: string[],
  stdinText: string,
  io: HookCliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  env: HookEnv = {}
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  if (argv.includes("--print-config")) {
    io.out(JSON.stringify(SETTINGS_CONFIG, null, 2));
    return 0;
  }

  // A hook must never disrupt the session: any failure path is a silent
  // success with no output.
  try {
    const output = await runHook(stdinText, env);
    if (output !== null) io.out(output);
  } catch {
    // Silent by design.
  }
  return 0;
}
