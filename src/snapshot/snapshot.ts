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

export interface FileSummary {
  path: string;
  summary: string;
  role: string;
  dependencies: string[];
  lastUpdated: string;
  gitHash: string;
}

export interface Snapshot {
  version: 1;
  createdAt: string;
  updatedAt: string;
  gitHash: string;
  files: FileSummary[];
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
    return JSON.parse(raw);
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

function parseLLMResponse(raw: string): Array<{
  path: string;
  summary: string;
  role: string;
  dependencies: string[];
}> {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "path" in item &&
        "summary" in item
    );
  } catch {
    // Try to find JSON array in the response
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return [];
      }
    }
    return [];
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

  if (filesWithContent.length === 0) {
    const gitHash = await getCurrentGitHash(resolvedRoot);
    const now = new Date().toISOString();
    return { version: 1, createdAt: now, updatedAt: now, gitHash, files: [] };
  }

  // Call LLM to summarize
  const userMessage = buildSnapshotPrompt(filesWithContent);
  const result = await callLLM(config, userMessage, SNAPSHOT_SYSTEM_PROMPT);

  if (result.type === "prompt") {
    throw new Error(
      "No CLI or API key available for this provider. Use claude or ollama (no key needed), or provide an API key."
    );
  }

  const summaries = parseLLMResponse(result.text);
  const gitHash = await getCurrentGitHash(resolvedRoot);
  const now = new Date().toISOString();

  const files: FileSummary[] = summaries.map((s) => ({
    path: s.path,
    summary: s.summary,
    role: s.role ?? "unknown",
    dependencies: s.dependencies ?? [],
    lastUpdated: now,
    gitHash,
  }));

  const snapshot: Snapshot = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    gitHash,
    files,
  };

  await saveSnapshot(resolvedRoot, snapshot);
  return snapshot;
}

export async function updateSnapshot(
  rootDir: string,
  config: MasonConfig
): Promise<{ added: number; updated: number; removed: number }> {
  const resolvedRoot = path.resolve(rootDir);
  const existing = await loadSnapshot(resolvedRoot);

  if (!existing) {
    const snapshot = await createSnapshot(rootDir, config);
    return { added: snapshot.files.length, updated: 0, removed: 0 };
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
    // If git diff fails (e.g., hash no longer exists), do a full rebuild
    const snapshot = await createSnapshot(rootDir, config);
    return { added: snapshot.files.length, updated: 0, removed: 0 };
  }

  if (changedFiles.length === 0) {
    return { added: 0, updated: 0, removed: 0 };
  }

  // Categorize changes
  const existingPaths = new Set(existing.files.map((f) => f.path));
  const filesToUpdate: string[] = [];
  const filesToRemove: string[] = [];

  for (const file of changedFiles) {
    if (existingPaths.has(file)) {
      filesToUpdate.push(file);
    }
  }

  // Check if any snapshot files were deleted
  for (const file of existing.files) {
    try {
      await fs.access(path.join(resolvedRoot, file.path));
    } catch {
      filesToRemove.push(file.path);
    }
  }

  // Check for new architecturally important files among the changes
  const sampled = await sampleFiles(resolvedRoot, 30);
  const sampledPaths = new Set(sampled.map((s) => s.path));
  const newArchFiles = changedFiles.filter(
    (f) => sampledPaths.has(f) && !existingPaths.has(f)
  );

  const allFilesToProcess = [...new Set([...filesToUpdate, ...newArchFiles])];

  let added = 0;
  let updated = 0;
  const removed = filesToRemove.length;

  if (allFilesToProcess.length > 0) {
    // Read full content of files to process
    const filesWithContent: Array<{ path: string; content: string }> = [];
    for (const filePath of allFilesToProcess) {
      const full = await readFullFile(resolvedRoot, filePath);
      if (full) {
        filesWithContent.push({ path: full.path, content: full.content });
      }
    }

    if (filesWithContent.length > 0) {
      // Get existing summaries for context
      const existingSummaries = existing.files
        .filter((f) => !allFilesToProcess.includes(f.path))
        .map((f) => ({ path: f.path, summary: f.summary, role: f.role }));

      const userMessage = buildIncrementalPrompt(
        filesWithContent,
        existingSummaries
      );
      const llmResult = await callLLM(
        config,
        userMessage,
        SNAPSHOT_SYSTEM_PROMPT
      );

      if (llmResult.type === "prompt") {
        throw new Error(
          "No CLI or API key available for this provider."
        );
      }

      const newSummaries = parseLLMResponse(llmResult.text);
      const gitHash = await getCurrentGitHash(resolvedRoot);
      const now = new Date().toISOString();

      // Merge: update existing, add new, remove deleted
      const updatedFiles = existing.files
        .filter(
          (f) =>
            !filesToRemove.includes(f.path) &&
            !allFilesToProcess.includes(f.path)
        );

      for (const summary of newSummaries) {
        const isNew = !existingPaths.has(summary.path);
        if (isNew) added++;
        else updated++;

        updatedFiles.push({
          path: summary.path,
          summary: summary.summary,
          role: summary.role ?? "unknown",
          dependencies: summary.dependencies ?? [],
          lastUpdated: now,
          gitHash,
        });
      }

      existing.files = updatedFiles;
      existing.updatedAt = now;
      existing.gitHash = gitHash;
    }
  }

  // Remove deleted files
  if (filesToRemove.length > 0) {
    existing.files = existing.files.filter(
      (f) => !filesToRemove.includes(f.path)
    );
  }

  existing.updatedAt = new Date().toISOString();
  existing.gitHash = await getCurrentGitHash(resolvedRoot);
  await saveSnapshot(resolvedRoot, existing);

  return { added, updated, removed };
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

  // Check if hook already exists
  try {
    const existing = await fs.readFile(hookPath, "utf-8");
    if (existing.includes("mason snapshot-update")) {
      return; // Already installed
    }
    // Append to existing hook
    await fs.appendFile(hookPath, "\n" + hookContent);
  } catch {
    // No existing hook — create new
    await fs.writeFile(hookPath, hookContent, { mode: 0o755 });
  }
}
