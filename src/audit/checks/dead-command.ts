import path from "node:path";
import { auditGlob, readAuditInput } from "../inputs.js";
import { documentScope } from "../docs.js";
import { scopedPath } from "../scope.js";
import type { ClaimScope, CommandClaim } from "../types.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

const AVAILABLE_SCRIPTS_CAP = 30;
function scriptsOf(raw: string): string[] | null {
  try {
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return null;
    if (pkg.scripts === undefined) return [];
    return pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
      && Object.values(pkg.scripts).every(value => typeof value === "string") ? Object.keys(pkg.scripts) : null;
  } catch { return null; }
}

interface Resolution {
  doc: string; claim: CommandClaim; scope: ClaimScope; manifest: string | null;
  scripts: string[]; elsewhere: string[]; problem?: string;
}

/** Shared dependency resolver: the cache records every manifest actually consulted. */
export async function commandInputs(root: string, docs: Array<{ path: string; claims: { commands: CommandClaim[] } }>) {
  const contents = new Map<string, string | null>();
  const read = async (file: string) => {
    if (!contents.has(file)) contents.set(file, await readAuditInput(root, file));
    return contents.get(file)!;
  };
  await read("package.json");
  let inventory: string[] | undefined;
  const resolutions: Resolution[] = [];
  for (const doc of docs) for (const claim of doc.claims.commands) {
    const base = documentScope(doc.path);
    const directory = scopedPath(base, claim.directory ?? ".");
    const scope: ClaimScope = { basis: claim.directory === undefined ? "document" : "explicit",
      directory: directory ?? base, candidates: [] };
    const resolution: Resolution = { doc: doc.path, claim, scope, manifest: null, scripts: [], elsewhere: [] };
    resolutions.push(resolution);
    if (claim.scopeUnknown || directory === null) {
      resolution.problem = claim.scopeUnknown ?? "The command's directory leaves the repository.";
      continue;
    }
    let cursor = directory;
    while (true) {
      const manifest = path.posix.join(cursor, "package.json");
      scope.candidates.push(manifest);
      const raw = await read(manifest);
      if (raw !== null) {
        resolution.manifest = manifest;
        const scripts = scriptsOf(raw);
        if (scripts === null) resolution.problem = "Invalid package manifest: " + manifest;
        else resolution.scripts = scripts;
        break;
      }
      // An explicit directory is a declared execution scope, never silently use a sibling.
      if (claim.directory !== undefined || cursor === ".") break;
      cursor = path.posix.dirname(cursor);
    }
    if (!resolution.manifest && !resolution.problem) {
      resolution.problem = `No package.json for the command's scope (${directory}).`;
    }
    if (resolution.problem || resolution.scripts.includes(claim.scriptName) || claim.directory !== undefined) continue;
    inventory ??= await commandManifests(root);
    for (const manifest of [...new Set(["package.json", ...inventory])].sort()) {
      if (scope.candidates.includes(manifest)) continue;
      scope.candidates.push(manifest);
      const raw = await read(manifest);
      if (raw === null) continue;
      const scripts = scriptsOf(raw);
      if (scripts === null) resolution.problem = "Cannot establish script availability: invalid manifest " + manifest;
      else if (scripts.includes(claim.scriptName)) resolution.elsewhere.push(manifest);
    }
  }
  return { manifests: [...contents].sort(([a], [b]) => a.localeCompare(b)), resolutions };
}

export async function checkDeadCommands(ctx: CheckContext): Promise<CheckResult> {
  const result = emptyResult();
  const { resolutions } = await commandInputs(ctx.root, ctx.docs);
  for (const { doc, claim, scope, scripts, elsewhere, problem, manifest } of resolutions) {
    if (problem) {
      result.skipped.push({ check: "dead-command", doc, reason: problem });
      continue;
    }
    if (scripts.includes(claim.scriptName)) continue;
    const evidence = { kind: "missing-script" as const, scriptName: claim.scriptName, invocation: claim.invocation,
      manifestsChecked: scope.candidates, availableScripts: scripts.slice(0, AVAILABLE_SCRIPTS_CAP), scope };
    const anchor = { doc, line: claim.line, excerpt: claim.excerpt };
    const message = `\`${claim.invocation}\` names script "${claim.scriptName}", which is absent from ${manifest}`;
    // Nested docs imply a package, but may describe commands run from another cwd.
    const certain = documentScope(doc) === "." && (scope.basis === "explicit" || !elsewhere.length);
    if (certain) result.issues.push({ type: "dead-command", message, anchor, confidence: "certain", evidence });
    else result.advisories.push({ resolution: "recheck", type: "dead-command", message: message + (elsewhere.length
      ? `; it exists in ${elsewhere.join(", ")}. Clarify the intended working directory.`
      : "; the intended working directory needs review."), anchor, evidence });
  }
  return result;
}

/** Ignored workspace manifests may still be explicit command dependencies. */
export function commandManifests(root: string): Promise<string[]> {
  return auditGlob(root, "**/package.json", {
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", ".mason/reports/**", "package.json"],
    label: "Command manifest discovery",
  });
}
