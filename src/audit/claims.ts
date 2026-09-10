import MarkdownIt from "markdown-it";
import { commandClaims } from "./commands.js";
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

const markdown = new MarkdownIt("commonmark", { html: false });
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
    const key = [claim.relativeTo ?? "scope", claim.path].join(":");
    if (!paths.has(key)) paths.set(key, claim);
  };
  const addCommand = (claim: CommandClaim): void => {
    const key = JSON.stringify([claim.scriptName, claim.directory, claim.scopeUnknown]);
    if (!commands.has(key)) commands.set(key, claim);
  };

  // A real Markdown parser distinguishes reference links, images and escaped
  // destinations from code examples. Ignore markers preserve source line offsets.
  const parsed = markdown.parse(lines.map((line, i) => ignored[i] ? "" : line).join("\n"), {});
  for (const token of parsed) {
    if (token.type !== "inline" || !token.map) continue;
    let line = token.map[0] + 1;
    for (const child of token.children ?? []) {
      const target = child.type === "link_open" ? child.attrGet("href") : child.type === "image" ? child.attrGet("src") : null;
      if (target && !/^(?:[a-z][a-z0-9+.-]*:|[\/#~])/i.test(target)) {
        let pathname: string | null = null;
        try { pathname = decodeURIComponent(target.split(/[?#]/)[0]); } catch { /* Unsupported URL encoding. */ }
        if (pathname && !/[$*?{}<>\\\x00-\x1f]/.test(pathname)) {
          addPath({ path: pathname, line, excerpt: target, relativeTo: "document" });
        }
      }
      if (child.type === "softbreak" || child.type === "hardbreak") line++;
      else line += child.content.split("\n").length - 1;
    }
  }

  let shellCwd: string | null | undefined;
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
        shellCwd = undefined;
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
        const scanned = commandClaims(line, lineNo, shellCwd, true);
        shellCwd = scanned.cwd;
        for (const claim of scanned.claims) addCommand(claim);
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
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      for (const claim of commandClaims(match[1], lineNo, undefined, true).claims) addCommand(claim);
    }
    for (const claim of commandClaims(line.replace(/`[^`]+`/g, ""), lineNo).claims) addCommand(claim);
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
