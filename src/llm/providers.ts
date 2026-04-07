import type { MasonConfig } from "./config.js";
import { getDefaultModel } from "./config.js";

const SYSTEM_PROMPT = `You are Mason, a context engineering tool. You've been given a comprehensive analysis of a codebase including:
- Git history stats (commit patterns, frequently changed files, stale directories)
- Project structure (directory layout, file counts by type)
- Curated code samples (key architectural files with previews)
- Test-to-source file mapping

Your job: analyze all this data and write a CLAUDE.md file that gives an AI coding assistant everything it needs to work effectively in this codebase.

The CLAUDE.md should include:
- Project overview (what it is, tech stack, architecture)
- Module/package structure and boundaries
- Code conventions and patterns you observe in the samples
- Testing conventions and coverage
- Build and development commands
- Important files and hot spots
- Any warnings or gotchas

Be specific and actionable. Reference actual file paths. Don't be generic — every rule should be grounded in what you see in the data.`;

export async function callLLM(
  config: MasonConfig,
  analysisData: string
): Promise<string> {
  const model = config.model ?? getDefaultModel(config.provider);

  switch (config.provider) {
    case "claude":
      return callClaude(config.apiKey!, model, analysisData);
    case "gemini":
      return callGemini(config.apiKey!, model, analysisData);
    case "openai":
      return callOpenAI(config.apiKey!, model, analysisData);
    case "ollama":
      return callOllama(config.ollamaHost ?? "http://localhost:11434", model, analysisData);
  }
}

async function callClaude(
  apiKey: string,
  model: string,
  data: string
): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Here is the full project analysis. Write a CLAUDE.md based on this data:\n\n${data}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}

async function callGemini(
  apiKey: string,
  model: string,
  data: string
): Promise<string> {
  // Gemini uses the OpenAI-compatible API
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here is the full project analysis. Write a CLAUDE.md based on this data:\n\n${data}`,
      },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

async function callOpenAI(
  apiKey: string,
  model: string,
  data: string
): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here is the full project analysis. Write a CLAUDE.md based on this data:\n\n${data}`,
      },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

async function callOllama(
  host: string,
  model: string,
  data: string
): Promise<string> {
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Here is the full project analysis. Write a CLAUDE.md based on this data:\n\n${data}`,
        },
      ],
    }),
  });

  const result = (await response.json()) as { message?: { content?: string } };
  return result.message?.content ?? "";
}
