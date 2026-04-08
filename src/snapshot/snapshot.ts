import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sampleFiles, readFullFile } from "../mcp/sampler.js";
import { callLLM } from "../llm/providers.js";
import type { MasonConfig } from "../llm/config.js";
import {
  SNAPSHOT_SYSTEM_PROMPT,
  buildSnapshotPrompt,
  buildIncrementalPrompt,
} from "./prompt.js";

const exec = promisify(execFile);

export interface FeatureEntry {
  description: string;
  files: string[];
  tests?: string[];
}

export interface FlowEntry {
  description: string;
  chain: string[];
}

export interface Snapshot {
  version: 2;
  createdAt: string;
  updatedAt: string;
  gitHash: string;
  features: Record<string, FeatureEntry>;
  flows: Record<string, FlowEntry>;
}

function snapshotDir(rootDir: string): string {
  return path.join(rootDir, ".mason");
}

function snapshotPath(rootDir: string): string {
  return path.join(snapshotDir(rootDir), "snapshot.json");
}

export async function loadSnapshot(rootDir: string): Promise<Snapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath(rootDir), "utf-8");
    const parsed = JSON.parse(raw);
    // Skip v1 snapshots — they're the old per-file format
    if (parsed.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSnapshot(
  rootDir: string,
  snapshot: Snapshot
): Promise<void> {
  await fs.mkdir(snapshotDir(rootDir), { recursive: true });
  await fs.writeFile(
    snapshotPath(rootDir),
    JSON.stringify(snapshot, null, 2),
    "utf-8"
  );
}

export async function getCurrentGitHash(rootDir: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

function parseSnapshotResponse(raw: string): {
  features: Record<string, FeatureEntry>;
  flows: Record<string, FlowEntry>;
} {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      features: parsed.features ?? {},
      flows: parsed.flows ?? {},
    };
  } catch {
    // Try to find JSON object in the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          features: parsed.features ?? {},
          flows: parsed.flows ?? {},
        };
      } catch {
        return { features: {}, flows: {} };
      }
    }
    return { features: {}, flows: {} };
  }
}

export async function createSnapshot(
  rootDir: string,
  config: MasonConfig
): Promise<Snapshot> {
  const resolvedRoot = path.resolve(rootDir);

  // Use sampler to pick key files
  const sampled = await sampleFiles(resolvedRoot, 25);

  // Read full content of each sampled file
  const filesWithContent: Array<{ path: string; content: string }> = [];
  for (const sample of sampled) {
    const full = await readFullFile(resolvedRoot, sample.path);
    if (full) {
      filesWithContent.push({ path: full.path, content: full.content });
    }
  }

  const gitHash = await getCurrentGitHash(resolvedRoot);
  const now = new Date().toISOString();

  if (filesWithContent.length === 0) {
    return {
      version: 2,
      createdAt: now,
      updatedAt: now,
      gitHash,
      features: {},
      flows: {},
    };
  }

  // Call LLM to build concept map
  const userMessage = buildSnapshotPrompt(filesWithContent);
  const result = await callLLM(config, userMessage, SNAPSHOT_SYSTEM_PROMPT);

  const resultText =
    typeof result === "string" ? result : result.type === "response" ? result.text : "";

  if (!resultText) {
    throw new Error(
      "No CLI or API key available for this provider. Use claude or ollama (no key needed), or provide an API key."
    );
  }

  const { features, flows } = parseSnapshotResponse(resultText);

  const snapshot: Snapshot = {
    version: 2,
    createdAt: now,
    updatedAt: now,
    gitHash,
    features,
    flows,
  };

  await saveSnapshot(resolvedRoot, snapshot);
  return snapshot;
}

export async function updateSnapshot(
  rootDir: string,
  config: MasonConfig
): Promise<{ status: string; details: string }> {
  const resolvedRoot = path.resolve(rootDir);
  const existing = await loadSnapshot(resolvedRoot);

  if (!existing) {
    const snapshot = await createSnapshot(rootDir, config);
    const featureCount = Object.keys(snapshot.features).length;
    const flowCount = Object.keys(snapshot.flows).length;
    return {
      status: "created",
      details: `New snapshot: ${featureCount} features, ${flowCount} flows`,
    };
  }

  // Find files changed since last snapshot
  let changedFiles: string[] = [];
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "--name-only", existing.gitHash, "HEAD"],
      { cwd: resolvedRoot }
    );
    changedFiles = stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    // Full rebuild if git diff fails
    const snapshot = await createSnapshot(rootDir, config);
    const featureCount = Object.keys(snapshot.features).length;
    return { status: "rebuilt", details: `${featureCount} features` };
  }

  if (changedFiles.length === 0) {
    return { status: "up-to-date", details: "No changes since last snapshot" };
  }

  // Check which changed files are architecturally relevant
  const sampled = await sampleFiles(resolvedRoot, 30);
  const sampledPaths = new Set(sampled.map((s) => s.path));

  // Also check which changed files are referenced in the existing snapshot
  const snapshotFiles = new Set<string>();
  for (const feature of Object.values(existing.features)) {
    for (const f of feature.files) snapshotFiles.add(f);
    for (const t of feature.tests ?? []) snapshotFiles.add(t);
  }
  for (const flow of Object.values(existing.flows)) {
    for (const f of flow.chain) snapshotFiles.add(f);
  }

  const relevantChanges = changedFiles.filter(
    (f) => sampledPaths.has(f) || snapshotFiles.has(f)
  );

  if (relevantChanges.length === 0) {
    // Changes don't affect snapshot files
    existing.gitHash = await getCurrentGitHash(resolvedRoot);
    existing.updatedAt = new Date().toISOString();
    await saveSnapshot(resolvedRoot, existing);
    return {
      status: "unchanged",
      details: `${changedFiles.length} files changed but none affect the concept map`,
    };
  }

  // Read changed files and ask LLM to update the map
  const filesWithContent: Array<{ path: string; content: string }> = [];
  for (const filePath of relevantChanges) {
    const full = await readFullFile(resolvedRoot, filePath);
    if (full) {
      filesWithContent.push({ path: full.path, content: full.content });
    }
  }

  if (filesWithContent.length === 0) {
    return { status: "unchanged", details: "Changed files could not be read" };
  }

  const userMessage = buildIncrementalPrompt(filesWithContent, {
    features: existing.features,
    flows: existing.flows,
  });

  const result = await callLLM(config, userMessage, SNAPSHOT_SYSTEM_PROMPT);
  const resultText =
    typeof result === "string" ? result : result.type === "response" ? result.text : "";

  if (!resultText) {
    throw new Error("No CLI or API key available for this provider.");
  }

  const { features, flows } = parseSnapshotResponse(resultText);
  const gitHash = await getCurrentGitHash(resolvedRoot);

  existing.features = features;
  existing.flows = flows;
  existing.updatedAt = new Date().toISOString();
  existing.gitHash = gitHash;

  await saveSnapshot(resolvedRoot, existing);

  return {
    status: "updated",
    details: `${Object.keys(features).length} features, ${Object.keys(flows).length} flows (${relevantChanges.length} files changed)`,
  };
}

export async function installHook(rootDir: string): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  const hooksDir = path.join(resolvedRoot, ".git", "hooks");

  try {
    await fs.access(hooksDir);
  } catch {
    throw new Error("Not a git repository (no .git/hooks directory)");
  }

  const hookPath = path.join(hooksDir, "post-commit");
  const hookContent = `#!/bin/sh
# Mason: auto-update project snapshot after commit
# Runs in background so it doesn't block your workflow
mason snapshot-update "$(git rev-parse --show-toplevel)" &
`;

  try {
    const existing = await fs.readFile(hookPath, "utf-8");
    if (existing.includes("mason snapshot-update")) {
      return; // Already installed
    }
    await fs.appendFile(hookPath, "\n" + hookContent);
  } catch {
    await fs.writeFile(hookPath, hookContent, { mode: 0o755 });
  }
}
