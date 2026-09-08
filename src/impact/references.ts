import path from "node:path";

export interface ReferenceEntry {
  file: string;
  matches: string[];
  /** Literal relative JS/TS paths or named JVM imports tied to declared symbols. */
  kind: "import" | "mention";
  evidence: "resolved-import" | "explicit-path" | "name-candidate";
}

const jsExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const genericNames = new Set(["index", "main", "app", "init", "config", "settings", "types", "utils", "test", "tests"]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![\\w$])${escape(s)}(?![\\w$])`);

/** Treat templates (including nested interpolation strings) as opaque syntax. */
function templateEnd(content: string, start: number): number {
  let i = start + 1, interpolation = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === "\\") { i += 2; continue; }
    if (!interpolation) {
      if (c === "`") return i + 1;
      if (c === "$" && content[i + 1] === "{") { interpolation = 1; i += 2; continue; }
    } else {
      if (c === "`") { i = templateEnd(content, i); continue; }
      if (c === '"' || c === "'") {
        const quote = c;
        for (i++; i < content.length; i++) { if (content[i] === "\\") i++; else if (content[i] === quote) { i++; break; } }
        continue;
      }
      if (content.startsWith("//", i)) { const end = content.indexOf("\n", i + 2); i = end < 0 ? content.length : end; continue; }
      if (content.startsWith("/*", i)) { const end = content.indexOf("*/", i + 2); i = end < 0 ? content.length : end + 2; continue; }
      if (c === "{") interpolation++;
      if (c === "}") interpolation--;
    }
    i++;
  }
  return content.length;
}

/** Skip comments and string bodies before inspecting JS/TS import syntax. */
function tokens(content: string): { value: string; string?: boolean }[] {
  const result: { value: string; string?: boolean }[] = [];
  const re = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const value = match[0];
    if (value.startsWith("//") || value.startsWith("/*")) continue;
    if (/^["'`]/.test(value)) {
      if (value[0] === "`") {
        re.lastIndex = templateEnd(content, match.index);
        result.push({ value: "<opaque>" });
        continue;
      }
      // Escaped or interpolated module strings require runtime/language resolution.
      result.push({ value: value.slice(1, -1), string: !value.includes("\\") && value[0] !== "`" });
      // Keep opaque strings opaque even if their content equals import/from.
      if (!result.at(-1)!.string) result[result.length - 1] = { value: "<opaque>" };
    } else result.push({ value });
  }
  return result;
}

function imports(content: string): string[] {
  const ts = tokens(content), found: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.string || ts[i - 1]?.value === ".") continue;
    if (["require", "import"].includes(t.value) && ts[i + 1]?.value === "(" && ts[i + 2]?.string && ts[i + 3]?.value === ")") {
      found.push(ts[i + 2].value);
    }
    if (!["import", "export"].includes(t.value) || ts[i + 1]?.value === "(") continue;
    if (t.value === "import" && ts[i + 1]?.string) { found.push(ts[i + 1].value); continue; }
    for (let j = i + 1; j < Math.min(ts.length, i + 150); j++) {
      if ([";", "=", "import", "export"].includes(ts[j].value) && !ts[j].string) break;
      if (ts[j].value === "from" && !ts[j].string && ts[j + 1]?.string) { found.push(ts[j + 1].value); break; }
    }
  }
  return found;
}

function qualifiedName(ts: ReturnType<typeof tokens>, start: number): string {
  let name = "";
  for (let i = start; i < ts.length; i++) {
    if (ts[i].string || !/^[A-Za-z_$][\w$]*$/.test(ts[i].value)) break;
    name += ts[i].value;
    if (ts[i + 1]?.value !== "." || !/^[A-Za-z_$][\w$]*$/.test(ts[i + 2]?.value ?? "")) break;
    name += "."; i++;
  }
  return name;
}

/** Match explicit package/symbol identity; package wildcards stay unresolved. */
function declaredSymbols(content: string): string[] {
  const ts = tokens(content);
  const packageAt = ts.findIndex(t => !t.string && t.value === "package");
  if (packageAt < 0) return [];
  const pkg = qualifiedName(ts, packageAt + 1), names: string[] = [];
  let depth = 0;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].string) continue;
    if (ts[i].value === "{") depth++;
    if (ts[i].value === "}") depth--;
    if (depth === 0 && ["class", "interface", "object", "enum", "typealias", "fun"].includes(ts[i].value) &&
      /^[A-Za-z_$][\w$]*$/.test(ts[i + 1]?.value ?? "") && ts[i + 1].value !== "class") names.push(pkg + "." + ts[i + 1].value);
  }
  return names;
}

function jvmImports(content: string): string[] {
  const ts = tokens(content), result: string[] = [];
  for (let i = 0; i < ts.length; i++) if (!ts[i].string && ts[i].value === "import") {
    const name = qualifiedName(ts, i + (ts[i + 1]?.value === "static" ? 2 : 1));
    if (name) result.push(name);
  }
  return result;
}

function resolveImport(file: string, specifier: string, available: Set<string>): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (relative.startsWith("../")) return null;
  if (available.has(relative)) return relative;
  const ext = path.posix.extname(relative);
  const replacements: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
  const candidates = ext ? (replacements[ext] ?? []).map(e => relative.slice(0, -ext.length) + e) :
    jsExtensions.flatMap(e => [relative + e, relative + "/index" + e]);
  const found = candidates.filter(f => available.has(f));
  // Resolution depends on compiler configuration when multiple candidates exist.
  return found.length === 1 ? found[0] : null;
}

/** Explicit paths are textual evidence, not proof of a dependency. */
function mentionsPath(content: string, target: string): boolean {
  return new RegExp(`(?<![\\w./\\\\-])(?:\\./)?${escape(target)}(?![\\w./\\\\-])`).test(content);
}

export function createReferenceMatcher(targets: string[], available: Set<string>, targetContents = new Map<string, string>()) {
  const counts = new Map<string, number>();
  for (const file of available) {
    const name = path.posix.basename(file, path.posix.extname(file));
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const jvmTargets = new Map([...targetContents].filter(([file]) => /\.(?:kt|kts|java)$/.test(file)).map(([file, content]) => [file, declaredSymbols(content)]));
  return (source: { path: string; content: string }): ReferenceEntry[] => {
    if (targets.includes(source.path)) return [];
    const resolved = new Set(jsExtensions.includes(path.posix.extname(source.path)) ?
      imports(source.content).map(s => resolveImport(source.path, s, available)).filter(Boolean) : []);
    if (/\.(?:kt|kts|java)$/.test(source.path)) {
      const imported = jvmImports(source.content);
      for (const [target, symbols] of jvmTargets) if (symbols.some(symbol => imported.some(name => name === symbol || name.startsWith(symbol + ".")))) resolved.add(target);
    }
    // Keep each evidence class separate: one resolved import must not promote
    // another target's ambiguous name match in the same source file.
    const groups = new Map<ReferenceEntry["evidence"], string[]>();
    const add = (evidence: ReferenceEntry["evidence"], match: string) => groups.set(evidence, [...(groups.get(evidence) ?? []), match]);
    for (const target of targets) {
      if (resolved.has(target)) { add("resolved-import", target); continue; }
      if (mentionsPath(source.content, target)) {
        add("explicit-path", target);
        continue;
      }
      const ext = path.posix.extname(target), name = path.posix.basename(target, ext);
      // A config/doc name, generic symbol, or duplicate basename has too little identity.
      if (!/\.(?:[cm]?[jt]sx?|py|kt|java|go|rs|swift|rb|cs|cpp|c|h|hpp|dart|php)$/.test(ext) ||
        name.startsWith(".") || name.length < 3 || genericNames.has(name.toLowerCase()) || counts.get(name) !== 1) continue;
      if (word(name).test(source.content)) {
        add("name-candidate", name);
      }
    }
    return [...groups].map(([evidence, matches]) => ({ file: source.path, matches, kind: evidence === "resolved-import" ? "import" : "mention", evidence }));
  };
}

export function sortReferences(result: ReferenceEntry[]): ReferenceEntry[] {
  const rank = { "resolved-import": 0, "explicit-path": 1, "name-candidate": 2 };
  return result.sort((a, b) => rank[a.evidence] - rank[b.evidence] || b.matches.length - a.matches.length || a.file.localeCompare(b.file));
}
