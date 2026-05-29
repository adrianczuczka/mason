import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type Provider = "claude" | "gemini" | "openai" | "ollama";

export interface ConfluenceConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  parentPageId?: string;
}

export interface MasonConfig {
  provider: Provider;
  apiKey?: string;
  model?: string;
  ollamaHost?: string;
  confluence?: ConfluenceConfig;
}

function configDir(): string {
  return path.join(os.homedir(), ".mason");
}

function configFile(): string {
  return path.join(configDir(), "config.json");
}

const DEFAULT_MODELS: Record<Provider, string> = {
  claude: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o",
  ollama: "llama3",
};

export async function loadConfig(): Promise<MasonConfig | null> {
  try {
    const raw = await fs.readFile(configFile(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveConfig(config: MasonConfig): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(config, null, 2), "utf-8");
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

export async function detectCLI(
  provider: Provider
): Promise<{ available: boolean; version?: string }> {
  const cliName = provider === "claude" ? "claude"
    : provider === "gemini" ? "gemini"
    : provider === "ollama" ? "ollama"
    : null;

  if (!cliName) return { available: false };

  try {
    const { stdout } = await exec(cliName, ["--version"]);
    return { available: true, version: stdout.trim() };
  } catch {
    return { available: false };
  }
}

export function needsApiKey(provider: Provider): boolean {
  return provider === "openai";
}

export async function saveConfluenceConfig(
  confluence: ConfluenceConfig
): Promise<void> {
  const existing = (await loadConfig()) ?? { provider: "claude" as Provider };
  await saveConfig({ ...existing, confluence });
}

export async function loadConfluenceConfig(): Promise<ConfluenceConfig | null> {
  const config = await loadConfig();
  return config?.confluence ?? null;
}
