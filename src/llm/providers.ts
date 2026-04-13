import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { MasonConfig } from "./config.js";
import { getDefaultModel } from "./config.js";

const exec = promisify(execFile);

const CLAUDE_MD_SYSTEM_PROMPT = `You are Mason, a context engineering tool. You've been given a comprehensive analysis of a codebase including:
- Git history stats (commit patterns, frequently changed files, stale directories)
- Project structure (directory layout, file counts by type)
- Curated code samples (key architectural files with previews)
- Test-to-source file mapping

Your job: write a COMPLETE CLAUDE.md file from scratch based ONLY on the analysis data provided below. Do NOT read any existing files in the project. Do NOT reference or preserve any existing CLAUDE.md. Generate the entire document fresh.

CRITICAL: Output ONLY the raw markdown content. No preamble, no summary, no "Here's the CLAUDE.md:", no explanation, no questions, no commentary. Start directly with "# CLAUDE.md" and end with the last line of content. Your entire response will be written directly to a file.

The CLAUDE.md should include:
- Project overview (what it is, tech stack, architecture)
- Module/package structure and boundaries
- Code conventions and patterns you observe in the samples
- Testing conventions and coverage
- Build and development commands
- Important files and hot spots
- Any warnings or gotchas

Be specific and actionable. Reference actual file paths. Don't be generic — every rule should be grounded in what you see in the data.`;

export type CallResult =
  | { type: "response"; text: string }
  | { type: "prompt"; text: string };

export async function callLLM(
  config: MasonConfig,
  userMessage: string,
  systemPrompt?: string
): Promise<CallResult> {
  const model = config.model ?? getDefaultModel(config.provider);
  const system = systemPrompt ?? CLAUDE_MD_SYSTEM_PROMPT;

  switch (config.provider) {
    case "claude":
      if (config.apiKey) {
        return {
          type: "response",
          text: await callClaudeAPI(config.apiKey, model, system, userMessage),
        };
      }
      return {
        type: "response",
        text: await callClaudeCLI(system, userMessage),
      };

    case "ollama":
      return {
        type: "response",
        text: await callOllamaCLI(
          config.ollamaHost ?? "http://localhost:11434",
          model,
          system,
          userMessage,
        ),
      };

    case "gemini":
      if (config.apiKey) {
        return {
          type: "response",
          text: await callGeminiAPI(config.apiKey, model, system, userMessage),
        };
      }
      return {
        type: "response",
        text: await callGeminiCLI(system, userMessage),
      };

    case "openai":
      if (config.apiKey) {
        return {
          type: "response",
          text: await callOpenAIAPI(config.apiKey, model, system, userMessage),
        };
      }
      return {
        type: "prompt",
        text: formatPromptForCopy(system, userMessage),
      };
  }
}

function formatPromptForCopy(system: string, userMessage: string): string {
  return `${system}\n\n---\n\n${userMessage}`;
}

// === CLI-based providers (no API key) ===

async function callViaTempFile(
  command: string,
  args: (promptPath: string) => string[],
  system: string,
  userMessage: string
): Promise<string> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const prompt = `${system}\n\n${userMessage}`;
  const tmpFile = path.join(os.tmpdir(), `mason-prompt-${Date.now()}.txt`);

  try {
    await fs.writeFile(tmpFile, prompt, "utf-8");
    const { stdout } = await exec(command, args(tmpFile), {
      maxBuffer: 10_000_000,
      timeout: 300_000,
    });
    return stdout.trim();
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

function spawnWithStdin(
  command: string,
  args: string[],
  input: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", reject);

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

async function callClaudeCLI(
  system: string,
  userMessage: string
): Promise<string> {
  const prompt = `${system}\n\n${userMessage}`;
  return spawnWithStdin("claude", ["-p"], prompt);
}

async function callGeminiCLI(
  system: string,
  userMessage: string
): Promise<string> {
  const prompt = `${system}\n\n${userMessage}`;
  return spawnWithStdin("gemini", ["-p", ""], prompt);
}

async function callOllamaCLI(
  host: string,
  model: string,
  system: string,
  userMessage: string
): Promise<string> {
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    }),
  });

  const result = (await response.json()) as {
    message?: { content?: string };
  };
  return result.message?.content ?? "";
}

// === API-based providers ===

async function callClaudeAPI(
  apiKey: string,
  model: string,
  system: string,
  userMessage: string
): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}

async function callGeminiAPI(
  apiKey: string,
  model: string,
  system: string,
  userMessage: string
): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8192,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

async function callOpenAIAPI(
  apiKey: string,
  model: string,
  system: string,
  userMessage: string
): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8192,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}
