import fs from "node:fs/promises";
import path from "node:path";

const CACHE_FILE = ".mason-cache.json";

interface CacheData {
  version: 1;
  answers: Record<string, string>;
  lastRun: string;
  findingHashes: string[];
}

export async function loadCache(
  rootDir: string
): Promise<{ answers: Map<string, string>; findingHashes: Set<string> }> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, CACHE_FILE),
      "utf-8"
    );
    const data: CacheData = JSON.parse(raw);
    return {
      answers: new Map(Object.entries(data.answers)),
      findingHashes: new Set(data.findingHashes),
    };
  } catch {
    return { answers: new Map(), findingHashes: new Set() };
  }
}

export async function saveCache(
  rootDir: string,
  answers: Map<string, string>,
  findingHashes: string[]
): Promise<void> {
  const data: CacheData = {
    version: 1,
    answers: Object.fromEntries(answers),
    lastRun: new Date().toISOString(),
    findingHashes,
  };
  await fs.writeFile(
    path.join(rootDir, CACHE_FILE),
    JSON.stringify(data, null, 2),
    "utf-8"
  );
}

export function hashFinding(summary: string, analyzer: string): string {
  return `${analyzer}:${summary.slice(0, 80)}`;
}
