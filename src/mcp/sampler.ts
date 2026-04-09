import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";

const exec = promisify(execFile);

const SOURCE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mts", "mjs",
  "kt", "kts", "java",
  "py",
  "go",
  "rs",
  "swift",
  "rb",
  "cs", "cpp", "c", "h",
  "dart",
];

const CONFIG_FILES = [
  // Build & project config
  "package.json",
  "tsconfig.json",
  "build.gradle.kts",
  "build.gradle",
  "settings.gradle.kts",
  "settings.gradle",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Gemfile",
  "*.csproj",
  // Version catalogs & dependency locks
  "gradle/libs.versions.toml",
  // Code quality & formatting
  ".editorconfig",
  ".eslintrc.*",
  "eslint.config.*",
  ".prettierrc",
  "rustfmt.toml",
  ".swiftlint.yml",
  // CI/CD
  ".github/workflows/*.yml",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  // Containerization
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
];

const ENTRY_POINT_PATTERNS = [
  "src/main.*",
  "src/index.*",
  "src/app.*",
  "main.*",
  "index.*",
  "app.*",
  "App.*",
  "**/Main.kt",
  "**/Application.kt",
  "**/main.py",
  "**/main.go",
  "**/main.rs",
  "**/lib.rs",
  "**/Program.cs",
];

// Filename patterns that reveal architectural patterns and conventions.
// These are language-agnostic — the suffixes appear across ecosystems.
// Ordered by architectural importance — most distinctive patterns first.
const ARCHITECTURAL_PATTERNS = [
  // State/data flow
  { glob: "**/*ViewModel.*", category: "state", reason: "viewmodel (state management)" },
  { glob: "**/*Store.*", category: "state", reason: "store (state management)" },
  { glob: "**/*Reducer.*", category: "state", reason: "reducer (state management)" },
  // Data layer — interface
  { glob: "**/*Repository.*", category: "data-interface", reason: "repository interface (data layer contract)" },
  { glob: "**/*Dao.*", category: "data-interface", reason: "DAO (data access)" },
  { glob: "**/*DataSource.*", category: "data-interface", reason: "data source" },
  // Data layer — implementation (where actual patterns live: mappers, retry, IO dispatchers)
  { glob: "**/*RepositoryImpl.*", category: "data-impl", reason: "repository implementation (data layer patterns)" },
  { glob: "**/*ServiceImpl.*", category: "data-impl", reason: "service implementation" },
  { glob: "**/*Impl.*", category: "data-impl", reason: "implementation (concrete patterns)" },
  // Data transformation
  { glob: "**/*Mapper.*", category: "transform", reason: "mapper (data transformation)" },
  { glob: "**/*Converter.*", category: "transform", reason: "converter (data transformation)" },
  { glob: "**/*Adapter.*", category: "transform", reason: "adapter (interface adaptation)" },
  // Dependency injection / wiring
  { glob: "**/*Module.*", category: "di", reason: "module (DI/wiring)" },
  { glob: "**/*Provider.*", category: "di", reason: "provider (DI/wiring)" },
  { glob: "**/*Container.*", category: "di", reason: "container (DI/wiring)" },
  { glob: "**/*Factory.*", category: "di", reason: "factory (object creation)" },
  // API / network
  { glob: "**/*Service.*", category: "api", reason: "service (business/API layer)" },
  { glob: "**/*Client.*", category: "api", reason: "client (API/network layer)" },
  { glob: "**/*Api.*", category: "api", reason: "API interface definition" },
  // Interface contracts / protocols
  { glob: "**/*Interface.*", category: "contract", reason: "interface definition" },
  { glob: "**/*Protocol.*", category: "contract", reason: "protocol definition" },
  { glob: "**/*Trait.*", category: "contract", reason: "trait definition" },
  // Routing / navigation
  { glob: "**/*Router.*", category: "routing", reason: "router (navigation/routing)" },
  { glob: "**/*Route.*", category: "routing", reason: "route definition" },
  { glob: "**/*NavHost.*", category: "routing", reason: "navigation host" },
  { glob: "**/*Controller.*", category: "routing", reason: "controller (request handling)" },
  { glob: "**/*Handler.*", category: "routing", reason: "handler (request handling)" },
  // Middleware / interceptors
  { glob: "**/*Middleware.*", category: "middleware", reason: "middleware (request pipeline)" },
  { glob: "**/*Interceptor.*", category: "middleware", reason: "interceptor (cross-cutting)" },
  { glob: "**/*Plugin.*", category: "middleware", reason: "plugin (extensibility)" },
  // Models / types
  { glob: "**/*Model.*", category: "model", reason: "model (domain types)" },
  { glob: "**/*Entity.*", category: "model", reason: "entity (persistence types)" },
  { glob: "**/*Dto.*", category: "model", reason: "DTO (data transfer types)" },
  { glob: "**/*Schema.*", category: "model", reason: "schema (data validation)" },
  // Use cases / commands
  { glob: "**/*UseCase.*", category: "usecase", reason: "use case (business logic)" },
  { glob: "**/*Interactor.*", category: "usecase", reason: "interactor (business logic)" },
  { glob: "**/*Command.*", category: "usecase", reason: "command (CQRS pattern)" },
];

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.gradle/**",
  "**/target/**",
  "**/.git/**",
  "**/vendor/**",
  "**/__pycache__/**",
  "**/venv/**",
  "**/.venv/**",
  "**/*.min.*",
  "**/*.map",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/*.lock",
  "**/*.generated.*",
  "**/generated/**",
  "**/R.java",
  "**/BuildConfig.java",
];

const PREVIEW_LINES = 60;

export interface ProjectConfig {
  patterns?: string[];
  alwaysInclude?: string[];
  ignore?: string[];
}

export interface SampledFile {
  path: string;
  preview: string;
  totalLines: number;
  sizeBytes: number;
  reason: string;
}

async function loadProjectConfig(
  rootDir: string
): Promise<ProjectConfig> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, ".mason", "config.json"),
      "utf-8"
    );
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function sampleFiles(
  rootDir: string,
  maxFiles: number = 25
): Promise<SampledFile[]> {
  const selected = new Map<string, string>(); // path -> reason
  const projectConfig = await loadProjectConfig(rootDir);
  const ignorePatterns = [...IGNORE_PATTERNS, ...(projectConfig.ignore ?? [])];

  // 0. Always-include files from project config (highest priority)
  for (const filePath of projectConfig.alwaysInclude ?? []) {
    if (selected.size >= maxFiles) break;
    // Validate path stays within project root
    const resolvedPath = path.resolve(rootDir, filePath);
    if (!resolvedPath.startsWith(path.resolve(rootDir))) continue;
    selected.set(filePath, "always-include (project config)");
  }

  // 1. Config files (cap at 5)
  let configCount = 0;
  for (const pattern of CONFIG_FILES) {
    if (configCount >= 5) break;
    const matches = await fg(pattern, {
      cwd: rootDir,
      ignore: ignorePatterns,
      deep: 3,
    });
    for (const match of matches) {
      if (configCount >= 5 || selected.size >= maxFiles) break;
      selected.set(match, "config file");
      configCount++;
    }
  }

  // 2. Module build/config files — build files from subdirectories reveal dependency graph
  const moduleBuildPatterns = [
    // Gradle
    "**/build.gradle.kts",
    "**/build.gradle",
    // Cargo workspace members
    "**/Cargo.toml",
    // Node workspaces
    "**/package.json",
    // Go sub-modules
    "**/go.mod",
  ];
  let moduleBuildCount = 0;
  for (const pattern of moduleBuildPatterns) {
    const matches = await fg(pattern, {
      cwd: rootDir,
      ignore: ignorePatterns,
      deep: 4,
    });
    // Skip root-level files (already captured as config)
    const subMatches = matches.filter((m) => m.includes("/"));
    for (const match of subMatches) {
      if (moduleBuildCount >= 4 || selected.size >= maxFiles) break;
      if (!selected.has(match)) {
        selected.set(match, "module build file (reveals dependency graph)");
        moduleBuildCount++;
      }
    }
    if (moduleBuildCount >= 4) break;
  }

  // 3. Entry points (cap at 2)
  let entryCount = 0;
  for (const pattern of ENTRY_POINT_PATTERNS) {
    if (entryCount >= 2) break;
    const matches = await fg(pattern, {
      cwd: rootDir,
      ignore: ignorePatterns,
      deep: 5,
    });
    for (const match of matches) {
      if (entryCount >= 2 || selected.size >= maxFiles) break;
      if (!selected.has(match)) {
        selected.set(match, "entry point");
        entryCount++;
      }
    }
  }

  // 4. Hot files from git (up to 5)
  try {
    const { stdout } = await exec(
      "git",
      ["log", "--since=3 months ago", "--format=", "--name-only"],
      { cwd: rootDir, maxBuffer: 5_000_000 }
    );

    const fileCounts = new Map<string, number>();
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      if (
        line.includes("node_modules") ||
        line.includes("/build/") ||
        line.includes(".gradle") ||
        line.includes("/generated/")
      )
        continue;
      const ext = path.extname(line).slice(1);
      if (!SOURCE_EXTENSIONS.includes(ext)) continue;
      fileCounts.set(line, (fileCounts.get(line) ?? 0) + 1);
    }

    const hotFiles = [...fileCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    for (const [file, count] of hotFiles) {
      if (selected.size >= maxFiles) break;
      if (!selected.has(file)) {
        selected.set(file, `frequently changed (${count} commits in 3 months)`);
      }
    }
  } catch {
    // No git
  }

  // 5. Architectural pattern files — one per category (cap at 8)
  const seenCategories = new Set<string>();
  let patternCount = 0;
  for (const pattern of ARCHITECTURAL_PATTERNS) {
    if (patternCount >= 8 || selected.size >= maxFiles) break;
    if (seenCategories.has(pattern.category)) continue;

    const matches = await fg(pattern.glob, {
      cwd: rootDir,
      ignore: ignorePatterns,
    });

    if (matches.length > 0) {
      for (const match of matches) {
        if (!selected.has(match)) {
          selected.set(match, pattern.reason);
          seenCategories.add(pattern.category);
          patternCount++;
          break;
        }
      }
    }
  }

  // 5b. Custom patterns from project config
  for (const customGlob of projectConfig.patterns ?? []) {
    if (selected.size >= maxFiles) break;
    const matches = await fg(customGlob, {
      cwd: rootDir,
      ignore: ignorePatterns,
    });
    for (const match of matches) {
      if (selected.size >= maxFiles) break;
      if (!selected.has(match)) {
        selected.set(match, "custom pattern (project config)");
        break; // one per pattern
      }
    }
  }

  // 6. Test examples — diverse across file types (cap at 3)
  const testPatternGroups = [
    // JS/TS tests
    { patterns: ["**/*.test.*", "**/*.spec.*"], label: "JS/TS test" },
    // JVM tests
    { patterns: ["**/*Test.kt", "**/*Test.java"], label: "JVM test" },
    // Python tests
    { patterns: ["**/test_*.py", "**/*_test.py"], label: "Python test" },
    // Go tests
    { patterns: ["**/*_test.go"], label: "Go test" },
    // Swift tests
    { patterns: ["**/*Tests.swift", "**/*Test.swift"], label: "Swift test" },
    // Rust tests
    { patterns: ["**/*_test.rs"], label: "Rust test" },
  ];
  let testCount = 0;
  for (const group of testPatternGroups) {
    if (testCount >= 3 || selected.size >= maxFiles) break;
    const testFiles = await fg(group.patterns, {
      cwd: rootDir,
      ignore: ignorePatterns,
    });
    if (testFiles.length > 0) {
      for (const file of testFiles) {
        if (!selected.has(file)) {
          selected.set(file, `test example (${group.label})`);
          testCount++;
          break;
        }
      }
    }
  }

  // 7. Directory breadth — fill remaining slots with one file per top-level dir
  const sourceGlobs = SOURCE_EXTENSIONS.map((ext) => `**/*.${ext}`);
  const allSourceFiles = await fg(sourceGlobs, {
    cwd: rootDir,
    ignore: ignorePatterns,
  });

  const dirRepresentatives = new Map<string, string>();
  const boringFiles = /\.(gradle|gradle\.kts|json|toml|yaml|yml|xml|properties)$/;
  for (const file of allSourceFiles) {
    const topDir = file.split("/")[0];
    if (!dirRepresentatives.has(topDir) && !boringFiles.test(file)) {
      dirRepresentatives.set(topDir, file);
    }
  }

  for (const [, file] of dirRepresentatives) {
    if (selected.size >= maxFiles) break;
    if (!selected.has(file)) {
      selected.set(file, "directory representative");
    }
  }

  // Read file previews
  const results: SampledFile[] = [];
  for (const [filePath, reason] of selected) {
    try {
      const fullPath = path.resolve(rootDir, filePath);
      if (!fullPath.startsWith(path.resolve(rootDir))) continue;
      if (isSensitiveFile(filePath)) continue;
      const stat = await fs.stat(fullPath);
      if (stat.size > 100_000) continue;

      const content = await fs.readFile(fullPath, "utf-8");
      const lines = content.split("\n");
      const preview = lines.slice(0, PREVIEW_LINES).join("\n");

      results.push({
        path: filePath,
        preview,
        totalLines: lines.length,
        sizeBytes: stat.size,
        reason,
      });
    } catch {
      // Skip
    }
  }

  return results;
}

const SENSITIVE_PATTERNS = [
  /^\.env$/,
  /^\.env\./,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  /id_rsa/,
  /id_ed25519/,
  /credentials\./,
  /secret/i,
  /\.keystore$/,
  /local\.properties$/,
];

function isSensitiveFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return SENSITIVE_PATTERNS.some((p) => p.test(basename));
}

export async function readFullFile(
  rootDir: string,
  filePath: string
): Promise<{ path: string; content: string; totalLines: number } | null> {
  try {
    const fullPath = path.join(path.resolve(rootDir), filePath);
    if (!fullPath.startsWith(path.resolve(rootDir))) return null;
    if (isSensitiveFile(filePath)) return null;

    const content = await fs.readFile(fullPath, "utf-8");
    return {
      path: filePath,
      content,
      totalLines: content.split("\n").length,
    };
  } catch {
    return null;
  }
}
