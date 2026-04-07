import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type Provider = "claude" | "gemini" | "openai" | "ollama";

export interface MasonConfig {
  provider: Provider;
  apiKey?: string;
  model?: string;
  ollamaHost?: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".mason");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULT_MODELS: Record<Provider, string> = {
  claude: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o",
  ollama: "llama3",
};

export async function loadConfig(): Promise<MasonConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveConfig(config: MasonConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function getDefaultModel(provider: Provider): string {
  return DEFAULT_MODELS[provider];
}

export function validateProvider(value: string): Provider {
  const valid: Provider[] = ["claude", "gemini", "openai", "ollama"];
  if (!valid.includes(value as Provider)) {
    throw new Error(
      `Invalid provider "${value}". Must be one of: ${valid.join(", ")}`
    );
  }
  return value as Provider;
}
