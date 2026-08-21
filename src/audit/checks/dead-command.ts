import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

const AVAILABLE_SCRIPTS_CAP = 30;

async function scriptsOf(absManifest: string): Promise<string[] | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(absManifest, "utf-8"));
    return pkg && typeof pkg.scripts === "object" && pkg.scripts !== null
      ? Object.keys(pkg.scripts)
      : [];
  } catch {
    return null;
  }
}

/**
 * `npm run <script>` claims checked against package.json scripts — the one
 * ecosystem where task discovery is a single JSON parse. A script missing
 * from the root manifest is searched in every workspace manifest before
 * being flagged; docs legitimately say "in packages/foo run `npm run build`".
 */
export async function checkDeadCommands(
  ctx: CheckContext
): Promise<CheckResult> {
  const result = emptyResult();

  const commandClaims = ctx.docs.flatMap((doc) =>
    doc.claims.commands.map((claim) => ({ doc, claim }))
  );
  if (commandClaims.length === 0) return result;

  const rootScripts = await scriptsOf(path.join(ctx.root, "package.json"));
  if (rootScripts === null) {
    result.skipped.push({
      check: "dead-command",
      reason: "no package.json at the repo root",
    });
    return result;
  }
  const rootSet = new Set(rootScripts);

  let workspaceScripts: Set<string> | null = null;
  let manifestsChecked: string[] = ["package.json"];
  const loadWorkspaceScripts = async (): Promise<Set<string>> => {
    if (workspaceScripts !== null) return workspaceScripts;
    workspaceScripts = new Set<string>();
    const manifests = await fg("**/package.json", {
      cwd: ctx.root,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "package.json",
      ],
    });
    manifestsChecked = ["package.json", ...manifests.sort()];
    for (const manifest of manifests) {
      const scripts = await scriptsOf(path.join(ctx.root, manifest));
      for (const name of scripts ?? []) workspaceScripts.add(name);
    }
    return workspaceScripts;
  };

  for (const { doc, claim } of commandClaims) {
    if (rootSet.has(claim.scriptName)) continue;
    const elsewhere = await loadWorkspaceScripts();
    if (elsewhere.has(claim.scriptName)) continue;

    result.issues.push({
      type: "dead-command",
      message: `\`${claim.invocation}\` refers to script "${claim.scriptName}", which exists in no package.json`,
      anchor: { doc: doc.path, line: claim.line, excerpt: claim.excerpt },
      confidence: "certain",
      evidence: {
        kind: "missing-script",
        scriptName: claim.scriptName,
        invocation: claim.invocation,
        manifestsChecked,
        availableScripts: rootScripts.slice(0, AVAILABLE_SCRIPTS_CAP),
      },
    });
  }

  return result;
}
