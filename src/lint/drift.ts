import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";

const exec = promisify(execFile);

export interface DriftIssue {
  type: "deleted-reference" | "new-module" | "deps-changed" | "config-changed" | "stale-count";
  message: string;
}

export interface DriftResult {
  claudeMdPath: string | null;
  issues: DriftIssue[];
  lastGenerated: string | null;
}

const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.gradle/**",
  "**/target/**",
  "**/.git/**",
  "**/vendor/**",
];

async function findClaudeMd(rootDir: string): Promise<string | null> {
  const candidates = [
    path.join(rootDir, "CLAUDE.md"),
    path.join(rootDir, ".claude", "CLAUDE.md"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Not found
    }
  }
  return null;
}

export async function detectDrift(rootDir: string): Promise<DriftResult> {
  const resolvedRoot = path.resolve(rootDir);
  const claudeMdPath = await findClaudeMd(resolvedRoot);

  if (!claudeMdPath) {
    return { claudeMdPath: null, issues: [], lastGenerated: null };
  }

  const claudeMd = await fs.readFile(claudeMdPath, "utf-8");
  const stat = await fs.stat(claudeMdPath);
  const lastGenerated = stat.mtime.toISOString();
  const issues: DriftIssue[] = [];

  // 1. Find paths referenced in CLAUDE.md that no longer exist
  const referencedPaths = extractPaths(claudeMd);
  for (const refPath of referencedPaths) {
    try {
      await fs.access(path.join(resolvedRoot, refPath));
    } catch {
      issues.push({
        type: "deleted-reference",
        message: `CLAUDE.md references "${refPath}" which no longer exists`,
      });
    }
  }

  // 2. Check for new top-level modules/directories not mentioned in CLAUDE.md
  const topDirs = await getTopLevelSourceDirs(resolvedRoot);
  const claudeMdLower = claudeMd.toLowerCase();
  for (const dir of topDirs) {
    // Check if the directory name appears anywhere in CLAUDE.md
    if (!claudeMdLower.includes(dir.toLowerCase())) {
      issues.push({
        type: "new-module",
        message: `Directory "${dir}/" exists but is not mentioned in CLAUDE.md`,
      });
    }
  }

  // 3. Check if key config files changed since CLAUDE.md was last modified
  const configFiles = [
    "package.json",
    "build.gradle.kts",
    "settings.gradle.kts",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "Gemfile",
  ];
  for (const configFile of configFiles) {
    try {
      const configPath = path.join(resolvedRoot, configFile);
      const configStat = await fs.stat(configPath);
      if (configStat.mtime > stat.mtime) {
        issues.push({
          type: "config-changed",
          message: `${configFile} was modified after CLAUDE.md was last updated`,
        });
      }
    } catch {
      // Config file doesn't exist
    }
  }

  // 4. Check if deps changed since CLAUDE.md was generated (git-based)
  const depsChanged = await checkDepsChangedSinceDate(
    resolvedRoot,
    stat.mtime
  );
  if (depsChanged) {
    issues.push({
      type: "deps-changed",
      message: depsChanged,
    });
  }

  // 5. Check module counts mentioned in CLAUDE.md against reality
  const countIssues = await checkModuleCounts(resolvedRoot, claudeMd);
  issues.push(...countIssues);

  return { claudeMdPath, issues, lastGenerated };
}

function extractPaths(claudeMd: string): string[] {
  const paths = new Set<string>();

  // Match file paths in backticks: `src/something.ts`
  const backtickMatches = claudeMd.match(/`([^`]+\.[a-zA-Z]+)`/g) || [];
  for (const match of backtickMatches) {
    const p = match.replace(/`/g, "");
    // Filter out things that aren't file paths
    if (p.includes("/") && !p.includes("://") && !p.startsWith("npm ")) {
      paths.add(p);
    }
  }

  // Match directory references: `src/legacy/` or "src/legacy/"
  const dirMatches =
    claudeMd.match(/[`"]([a-zA-Z][\w.-]*(?:\/[\w.-]+)+\/?)[`"]/g) || [];
  for (const match of dirMatches) {
    const p = match.replace(/[`"]/g, "");
    if (!p.includes("://")) {
      paths.add(p);
    }
  }

  return [...paths];
}

async function getTopLevelSourceDirs(rootDir: string): Promise<string[]> {
  const allFiles = await fg("*", {
    cwd: rootDir,
    onlyDirectories: true,
    ignore: [
      "node_modules",
      "dist",
      "build",
      ".gradle",
      ".git",
      "target",
      "vendor",
      ".mason",
      ".claude",
      ".github",
      ".vscode",
      ".idea",
      "__pycache__",
      "venv",
      ".venv",
    ],
  });
  return allFiles;
}

async function checkDepsChangedSinceDate(
  rootDir: string,
  since: Date
): Promise<string | null> {
  try {
    const sinceStr = since.toISOString();
    const { stdout } = await exec(
      "git",
      [
        "log",
        `--since=${sinceStr}`,
        "--format=%s",
        "--diff-filter=M",
        "--",
        "package.json",
        "build.gradle.kts",
        "*/build.gradle.kts",
        "Cargo.toml",
        "*/Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "requirements.txt",
        "gradle/libs.versions.toml",
      ],
      { cwd: rootDir }
    );

    const commits = stdout.trim().split("\n").filter(Boolean);
    if (commits.length > 0) {
      return `${commits.length} dependency-related commit(s) since CLAUDE.md was last updated`;
    }
  } catch {
    // No git
  }
  return null;
}

async function checkModuleCounts(
  rootDir: string,
  claudeMd: string
): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];

  // Look for number + "module" patterns in CLAUDE.md
  const countMatches =
    claudeMd.match(/(\d+)\s*(?:modules?|packages?|workspaces?)/gi) || [];

  if (countMatches.length === 0) return issues;

  // Count actual modules
  let actualCount = 0;

  // Gradle modules
  try {
    const settings = await fs.readFile(
      path.join(rootDir, "settings.gradle.kts"),
      "utf-8"
    );
    const includes = settings.match(/include\s*\(/g) || [];
    actualCount = includes.length;
  } catch {
    // Try npm workspaces
    try {
      const pkgRaw = await fs.readFile(
        path.join(rootDir, "package.json"),
        "utf-8"
      );
      const pkg = JSON.parse(pkgRaw);
      if (Array.isArray(pkg.workspaces)) {
        const resolved = await fg(
          pkg.workspaces.map((w: string) => `${w}/package.json`),
          { cwd: rootDir, ignore: IGNORE }
        );
        actualCount = resolved.length;
      }
    } catch {
      // Try Cargo workspace
      try {
        const cargo = await fs.readFile(
          path.join(rootDir, "Cargo.toml"),
          "utf-8"
        );
        const members = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/);
        if (members) {
          actualCount = (members[1].match(/"/g) || []).length / 2;
        }
      } catch {
        // Can't determine module count
        return issues;
      }
    }
  }

  if (actualCount === 0) return issues;

  for (const match of countMatches) {
    const claimedCount = parseInt(match.match(/\d+/)?.[0] ?? "0", 10);
    if (claimedCount > 0 && claimedCount !== actualCount) {
      issues.push({
        type: "stale-count",
        message: `CLAUDE.md says "${match.trim()}" but the project actually has ${actualCount}`,
      });
    }
  }

  return issues;
}
