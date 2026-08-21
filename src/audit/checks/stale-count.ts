import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { CountClaim } from "../types.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

const MEMBERS_CAP = 50;

interface CountSource {
  actual: number;
  countedFrom: string;
  members: string[];
}

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function countGradleModules(root: string): Promise<CountSource | null> {
  for (const name of ["settings.gradle.kts", "settings.gradle"]) {
    const content = await readIfExists(path.join(root, name));
    if (content === null) continue;
    // include(":a", ":b") — count quoted project strings, not include() calls.
    const members: string[] = [];
    for (const call of content.matchAll(/include\s*\(([^)]*)\)/g)) {
      for (const proj of call[1].matchAll(/["']([^"']+)["']/g)) {
        members.push(proj[1]);
      }
    }
    if (members.length === 0) return null;
    return { actual: members.length, countedFrom: name, members };
  }
  return null;
}

async function countNpmWorkspaces(root: string): Promise<CountSource | null> {
  const pkgRaw = await readIfExists(path.join(root, "package.json"));
  if (pkgRaw !== null) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const globs: string[] = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : Array.isArray(pkg.workspaces?.packages)
          ? pkg.workspaces.packages
          : [];
      if (globs.length > 0) {
        const matched = await fg(
          globs.map((g) => `${g.replace(/\/+$/, "")}/package.json`),
          { cwd: root, ignore: ["**/node_modules/**"] }
        );
        return {
          actual: matched.length,
          countedFrom: "package.json workspaces",
          members: matched.map((m) => path.dirname(m)).sort(),
        };
      }
    } catch {
      // Malformed package.json — nothing provable here.
    }
  }

  const pnpmRaw = await readIfExists(path.join(root, "pnpm-workspace.yaml"));
  if (pnpmRaw !== null) {
    const globs: string[] = [];
    let inPackages = false;
    for (const line of pnpmRaw.split("\n")) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const entry = line.match(/^\s*-\s*["']?([^"'#\s]+)/);
        if (entry) {
          if (!entry[1].startsWith("!")) globs.push(entry[1]);
        } else if (line.trim().length > 0 && !line.startsWith(" ")) {
          inPackages = false;
        }
      }
    }
    if (globs.length > 0) {
      const matched = await fg(
        globs.map((g) => `${g.replace(/\/+$/, "")}/package.json`),
        { cwd: root, ignore: ["**/node_modules/**"] }
      );
      return {
        actual: matched.length,
        countedFrom: "pnpm-workspace.yaml",
        members: matched.map((m) => path.dirname(m)).sort(),
      };
    }
  }
  return null;
}

async function countCargoCrates(root: string): Promise<CountSource | null> {
  const content = await readIfExists(path.join(root, "Cargo.toml"));
  if (content === null) return null;
  const membersBlock = content.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!membersBlock) return null;
  const entries = [...membersBlock[1].matchAll(/["']([^"']+)["']/g)].map(
    (m) => m[1]
  );
  if (entries.length === 0) return null;

  // Workspace members may be globs ("crates/*") — resolve them against
  // directories that actually contain a Cargo.toml.
  const members = new Set<string>();
  for (const entry of entries) {
    if (/[*?[\]{}]/.test(entry)) {
      const matched = await fg(`${entry.replace(/\/+$/, "")}/Cargo.toml`, {
        cwd: root,
        ignore: ["**/target/**"],
      });
      for (const m of matched) members.add(path.dirname(m));
    } else if (
      (await readIfExists(path.join(root, entry, "Cargo.toml"))) !== null
    ) {
      members.add(entry);
    }
  }
  if (members.size === 0) return null;
  return {
    actual: members.size,
    countedFrom: "Cargo.toml workspace members",
    members: [...members].sort(),
  };
}

/**
 * Map a claim's unit to the ecosystem that can prove it. When the mapped
 * ecosystem has no workspace manifest in this repo, the claim is skipped —
 * "12 packages" in a Gradle repo proves nothing either way.
 */
async function resolveCountSource(
  root: string,
  claim: CountClaim
): Promise<CountSource | null> {
  const unit = claim.unit.replace(/s$/, "");
  if (unit === "module") return countGradleModules(root);
  if (unit === "workspace") return countNpmWorkspaces(root);
  if (unit === "crate") return countCargoCrates(root);
  // "packages" is ecosystem-ambiguous — first manifest that resolves wins.
  return (
    (await countNpmWorkspaces(root)) ??
    (await countCargoCrates(root)) ??
    (await countGradleModules(root))
  );
}

export async function checkStaleCounts(
  ctx: CheckContext
): Promise<CheckResult> {
  const result = emptyResult();

  for (const doc of ctx.docs) {
    for (const claim of doc.claims.counts) {
      const source = await resolveCountSource(ctx.root, claim);
      if (source === null || source.actual === claim.count) continue;
      result.issues.push({
        type: "stale-count",
        message: `says "${claim.excerpt}" but ${source.countedFrom} resolves to ${source.actual}`,
        anchor: { doc: doc.path, line: claim.line, excerpt: claim.excerpt },
        confidence: "certain",
        evidence: {
          kind: "count-mismatch",
          claimed: claim.count,
          actual: source.actual,
          unit: claim.unit,
          countedFrom: source.countedFrom,
          members: source.members.slice(0, MEMBERS_CAP),
        },
      });
    }
  }

  return result;
}
