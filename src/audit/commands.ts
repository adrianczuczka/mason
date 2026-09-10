import path from "node:path";
import type { CommandClaim } from "./types.js";

const TOKEN = `(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s\x60;&|]+)`;
const COMMAND = new RegExp(`\\b(npm|pnpm|yarn)((?:[ \\t]+${TOKEN})*?)[ \\t]+run[ \\t]+([A-Za-z0-9:_.-]+)`, "g");
const literal = (value: string) => {
  const unquoted = value.replace(/^(["'])(.*)\1$/, "$2");
  return /[$`*?\[\]{}~\\\x00-\x1f]/.test(unquoted) || path.posix.isAbsolute(unquoted) ? null : unquoted;
};

function splitCommands(line: string): string[] {
  const parts: string[] = [];
  let quote = "", start = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\") { i++; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ";" || line.slice(i, i + 2) === "&&") {
      parts.push(line.slice(start, i));
      if (char === "&") i++;
      start = i + 1;
    }
  }
  parts.push(line.slice(start));
  return parts;
}

/** Deliberately small shell subset: literal cd and npm-family run invocations. */
export function commandClaims(line: string, lineNo: number, cwd?: string | null, shell = false): { claims: CommandClaim[]; cwd: string | null | undefined } {
  const claims: CommandClaim[] = [];
  const segments = splitCommands(line);
  for (const segment of segments) {
    const text = segment.trim().replace(/^\$\s+/, "");
    if (text.startsWith("#") || /^(?:echo|printf)\b/.test(text)) continue;
    const cd = text.match(/^cd\s+(.+)$/);
    if (cd) {
      const directory = literal(cd[1]);
      cwd = directory === null || cwd === null || /\s/.test(directory) && !/^["']/.test(cd[1])
        ? null : path.posix.join(cwd ?? ".", directory);
      continue;
    }
    for (const match of text.matchAll(COMMAND)) {
      const flags = match[2].trim();
      const selector = flags.match(/^(?:--prefix|--dir|-C)(?:\s+|=)(.+)$/);
      let directory = cwd;
      let scopeUnknown: string | undefined;
      if ((shell && match.index !== 0) || match[3].startsWith("-")) scopeUnknown = "Unsupported shell wrapper or options before the script.";
      if (selector) {
        const selected = literal(selector[1]);
        directory = selected === null || cwd === null ? null : path.posix.join(cwd ?? ".", selected);
      } else if (flags) scopeUnknown = "Unsupported package-manager options before run: " + flags;
      const tail = text.slice(match.index! + match[0].length).split(/\s--(?:\s|$)/)[0];
      if (/(?:^|\s)(?:--workspace(?:s)?|-w|--filter|-F|--prefix|--dir|-C|--if-present)(?:\s|=|$)/.test(tail)) {
        scopeUnknown = "Package selection or conditional options after the script need review.";
      }
      if (/[|()]/.test(text) || /\b(?:pushd|popd|if|for|while)\b/.test(text) || directory === null) {
        scopeUnknown = "The command's working directory or shell control flow could not be resolved.";
      }
      claims.push({ scriptName: match[3], invocation: match[0], excerpt: match[0], line: lineNo,
        ...(directory !== undefined && directory !== null ? { directory } : {}), ...(scopeUnknown ? { scopeUnknown } : {}) });
    }
    // An unresolved directory change must not leave later commands apparently scoped.
    if (/\b(?:cd|pushd|popd)\b/.test(text)) cwd = null;
  }
  return { claims, cwd };
}
