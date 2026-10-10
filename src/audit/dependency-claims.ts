import { isRecord } from "../utils/validation.js";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { inspectionGit } from "./inspection.js";

export interface DependencyMatch {
  dependency: string;
  manifest: string;
  before: string | null;
  after: string | null;
  line: number;
  excerpt: string;
}

/** Preserve line numbers while excluding comments and Mason's generated instructions. */
export function dependencyText(content: string): string {
  return content
    .replace(/<!-- mason:start -->[\s\S]*?<!-- mason:end -->/g, (text) =>
      text.replace(/[^\n]/g, " "),
    )
    .replace(/<!--[\s\S]*?-->/g, (text) => text.replace(/[^\n]/g, " "));
}

/** Conservative supported declarations. Other ecosystems remain informational. */
function declarations(file: string, source: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!source) return result;
  if (path.posix.basename(file) === "package.json") {
    const json: unknown = JSON.parse(source);
    if (!isRecord(json)) throw new Error("Invalid package manifest");
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "engines",
    ]) {
      const entries = json[section];
      if (entries === undefined) continue;
      if (!isRecord(entries) || !Object.values(entries).every((value) => typeof value === "string"))
        throw new Error("Invalid dependency declarations: " + section);
      for (const [name, value] of Object.entries(entries)) {
        if (typeof value === "string")
          result.set(name, [...(result.has(name) ? [result.get(name)] : []), value].join("; "));
      }
    }
  } else if (file.endsWith("libs.versions.toml")) {
    const catalog = parseToml(source);
    const versions = catalog.versions;
    for (const section of ["libraries", "plugins"]) {
      const entries = catalog[section];
      if (entries === undefined) continue;
      if (!isRecord(entries)) throw new Error("Invalid version catalog: " + section);
      for (const entry of Object.values(entries)) {
        if (typeof entry === "string") {
          const parts = entry.split(":");
          if (parts.length >= 3) result.set(parts.slice(0, -1).join(":"), parts.at(-1)!);
        } else if (isRecord(entry)) {
          const name =
            entry.module ??
            (typeof entry.group === "string" && typeof entry.name === "string"
              ? `${entry.group}:${entry.name}`
              : entry.id);
          const version =
            typeof entry.version === "string"
              ? entry.version
              : isRecord(entry.version) &&
                  typeof entry.version.ref === "string" &&
                  isRecord(versions)
                ? versions[entry.version.ref]
                : undefined;
          if (typeof name === "string")
            result.set(name, typeof version === "string" ? version : "unspecified");
          else throw new Error("Invalid version catalog entry");
        } else throw new Error("Invalid version catalog entry");
      }
    }
  } else if (/build\.gradle(?:\.kts)?$/.test(file)) {
    for (const match of source.matchAll(/["']([\w.-]+:[\w.-]+):([^"'\s]+)["']/g))
      result.set(match[1], match[2]);
    for (const match of source.matchAll(
      /\bid\s*\(?\s*["']([\w.-]+)["']\s*\)?\s*version\s*["']([^"']+)["']/g,
    ))
      result.set(match[1], match[2]);
  }
  return result;
}

export async function matchDependencyChanges(
  root: string,
  from: string,
  head: string,
  files: string[],
  content: string,
) {
  const matches: DependencyMatch[] = [];
  const lines = dependencyText(content).split("\n");
  let incomplete = files.length > 64;
  for (const file of files.slice(0, 64)) {
    if (!/(?:^|\/)(?:package\.json|libs\.versions\.toml|build\.gradle(?:\.kts)?)$/.test(file)) {
      incomplete = true;
      continue;
    }
    try {
      const read = async (revision: string) => {
        // ls-tree distinguishes a missing file (addition/deletion) from unavailable evidence.
        const { stdout: entry } = await inspectionGit(
          ["ls-tree", revision, "--", `:(literal)${file}`],
          { cwd: root, timeout: 10000 },
        );
        if (!entry) return "";
        if (!entry.startsWith("100644 ") && !entry.startsWith("100755 "))
          throw new Error("Unsupported manifest mode");
        return (
          await inspectionGit(["show", `${revision}:${file}`], {
            cwd: root,
            maxBuffer: 1024 * 1024,
            timeout: 10000,
          })
        ).stdout;
      };
      const [before, after] = await Promise.all([read(from), read(head)]);
      const old = declarations(file, before),
        next = declarations(file, after);
      for (const dependency of new Set([...old.keys(), ...next.keys()])) {
        if (old.get(dependency) === next.get(dependency)) continue;
        const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const mention = new RegExp(
          `(^|[^a-zA-Z0-9_@./-])${escaped}(?![a-zA-Z0-9_/-]|\\.[a-zA-Z0-9_])`,
          "i",
        );
        const line = lines.findIndex((text) => mention.test(text));
        if (line < 0) continue;
        matches.push({
          dependency,
          manifest: file,
          before: old.get(dependency) ?? null,
          after: next.get(dependency) ?? null,
          line: line + 1,
          excerpt: lines[line].trim().slice(0, 500),
        });
        if (matches.length >= 100) return { matches, incomplete: true };
      }
    } catch {
      incomplete = true;
    }
  }
  return { matches, incomplete };
}
