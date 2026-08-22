import type {
  CommandClaim,
  CountClaim,
  DocClaims,
  PathClaim,
} from "./types.js";
import { extractTreeClaims } from "./tree.js";

/**
 * Single-segment names that count as path claims without containing a "/".
 * Anything else without a slash is prose ("name your file `config.ts`"), not
 * a claim about this repo.
 */
const ROOT_FILE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsup.config.ts",
  "vitest.config.ts",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "Cargo.toml",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "settings.gradle.kts",
  "settings.gradle",
  "build.gradle.kts",
  "build.gradle",
  "manifest.json",
  "server.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "CLAUDE.md",
  "AGENTS.md",
  ".gitignore",
  ".env.example",
]);

const SHELL_FENCE_INFOS = new Set(["", "bash", "sh", "shell", "console", "zsh"]);

const COMMAND_RE = /\b(npm|pnpm|yarn)\s+run\s+([A-Za-z0-9:_.-]+)/g;
const COUNT_RE = /(\d+)\s+(modules?|packages?|workspaces?|crates?)\b/gi;
/** "3 package managers" is not a package count. */
const COUNT_DENYLIST_RE = /^\s*(manager|registr|lock|json)/i;

const IGNORE_LINE = "<!-- mason:ignore -->";
const IGNORE_START = "<!-- mason:ignore-start -->";
const IGNORE_END = "<!-- mason:ignore-end -->";

/**
 * Normalize a candidate token into a repo-relative path claim, or return
 * null when the token is not a claim about this repo (URL, glob,
 * placeholder, relative import example, bare word).
 */
export function normalizePathToken(token: string): string | null {
  let t = token.trim();
  if (!t) return null;
  if (/\s/.test(t)) return null;
  if (t.includes("://") || t.includes("\\")) return null;
  if (/[*?[\]{}<>$`]/.test(t)) return null;
  if (t.startsWith("/") || t.startsWith("~") || t.startsWith("./") || t.startsWith("../")) {
    return null;
  }
  // `src/mcp/tools.ts:189` claims the file, not the line.
  t = t.replace(/:\d+(?:-\d+)?$/, "");
  if (t.includes(":")) return null;
  const normalized = t.replace(/\/+$/, "");
  if (!normalized) return null;
  // `server/src/test/kotlin/...` — a dots-only segment is an "and so on"
  // placeholder, not a claim.
  if (normalized.split("/").some((seg) => /^\.+$/.test(seg))) return null;
  if (normalized.includes("/")) return normalized;
  return ROOT_FILE_NAMES.has(normalized) ? normalized : null;
}

/** A fence line that is exactly one path-shaped token is a file-list claim. */
function exactTokenPath(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || /\s/.test(trimmed) || !trimmed.includes("/")) return null;
  return normalizePathToken(trimmed);
}

function computeIgnoredLines(lines: string[]): boolean[] {
  const ignored = new Array<boolean>(lines.length).fill(false);
  let inRegion = false;
  let ignoreNext = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(IGNORE_START)) {
      inRegion = true;
      ignored[i] = true;
      continue;
    }
    if (line.includes(IGNORE_END)) {
      inRegion = false;
      ignored[i] = true;
      continue;
    }
    if (inRegion) {
      ignored[i] = true;
      continue;
    }
    if (ignoreNext) {
      if (line.trim().length === 0) continue; // skip blanks to the next real line
      ignored[i] = true;
      ignoreNext = false;
      continue;
    }
    if (line.includes(IGNORE_LINE)) {
      ignored[i] = true;
      const rest = line.replace(IGNORE_LINE, "").trim();
      if (rest.length === 0) ignoreNext = true;
    }
  }
  return ignored;
}

/**
 * Extract every checkable claim from a context-file's markdown. Deterministic
 * and purely lexical — precision comes from the checks' provability gates,
 * not from clever parsing here.
 */
export function extractClaims(content: string): DocClaims {
  const lines = content.split("\n");
  const ignored = computeIgnoredLines(lines);

  const paths = new Map<string, PathClaim>();
  const counts: CountClaim[] = [];
  const commands = new Map<string, CommandClaim>();

  const addPath = (claim: PathClaim): void => {
    if (!paths.has(claim.path)) paths.set(claim.path, claim);
  };
  const addCommand = (claim: CommandClaim): void => {
    if (!commands.has(claim.scriptName)) commands.set(claim.scriptName, claim);
  };

  let inFence = false;
  let fenceInfo = "";
  let fenceMarker = "";
  let blockLines: string[] = [];
  let blockStartLine = 0;

  const processBlock = (): void => {
    for (const claim of extractTreeClaims(blockLines, blockStartLine)) {
      addPath(claim);
    }
    for (let i = 0; i < blockLines.length; i++) {
      const exact = exactTokenPath(blockLines[i]);
      if (exact) {
        addPath({
          path: exact,
          line: blockStartLine + i,
          excerpt: blockLines[i].trim(),
        });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const fenceMatch = line.match(/^\s*(```+|~~~+)(.*)$/);

    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
        fenceInfo = fenceMatch[2].trim().toLowerCase();
        blockLines = [];
        blockStartLine = lineNo + 1;
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false;
        processBlock();
      }
      continue;
    }

    if (inFence) {
      // Ignored lines become spacers so the rest of a tree still parses.
      blockLines.push(ignored[i] ? "" : line);
      if (!ignored[i] && SHELL_FENCE_INFOS.has(fenceInfo)) {
        for (const m of line.matchAll(COMMAND_RE)) {
          addCommand({
            scriptName: m[2],
            invocation: m[0],
            line: lineNo,
            excerpt: m[0],
          });
        }
      }
      continue;
    }

    if (ignored[i]) continue;

    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const normalized = normalizePathToken(m[1]);
      if (normalized) {
        addPath({ path: normalized, line: lineNo, excerpt: m[1] });
      }
    }
    for (const m of line.matchAll(/"([A-Za-z][\w.@-]*(?:\/[\w.@-]+)+\/?)"/g)) {
      const normalized = normalizePathToken(m[1]);
      if (normalized) {
        addPath({ path: normalized, line: lineNo, excerpt: m[1] });
      }
    }
    for (const m of line.matchAll(COUNT_RE)) {
      const rest = line.slice((m.index ?? 0) + m[0].length);
      if (COUNT_DENYLIST_RE.test(rest)) continue;
      counts.push({
        count: Number.parseInt(m[1], 10),
        unit: m[2].toLowerCase(),
        line: lineNo,
        excerpt: m[0],
      });
    }
    for (const m of line.matchAll(COMMAND_RE)) {
      addCommand({
        scriptName: m[2],
        invocation: m[0],
        line: lineNo,
        excerpt: m[0],
      });
    }
  }

  // An unclosed fence still gets its block processed — trees at the end of a
  // truncated doc are claims too.
  if (inFence) processBlock();

  return {
    paths: [...paths.values()],
    counts,
    commands: [...commands.values()],
  };
}
