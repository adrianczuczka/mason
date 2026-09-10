import path from "node:path";
import { documentScope } from "../docs.js";
import { auditGlob, readAuditInput } from "../inputs.js";
import type { CountClaim } from "../types.js";
import type { CheckContext, CheckResult } from "./index.js";
import { emptyResult } from "./index.js";

const MEMBERS_CAP = 50;

interface CountSource {
  actual: number;
  countedFrom: string;
  members: string[];
}

async function countGradleModules(root: string): Promise<CountSource | null> {
  for (const name of ["settings.gradle.kts", "settings.gradle"]) {
    const content = await readAuditInput(root, name);
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
  const pkgRaw = await readAuditInput(root, "package.json");
  if (pkgRaw !== null) {
    let globs: string[] = [];
    try {
      const pkg = JSON.parse(pkgRaw);
      globs = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : Array.isArray(pkg.workspaces?.packages)
          ? pkg.workspaces.packages
          : [];
    } catch {
      // Malformed package.json — nothing provable here.
    }
    if (globs.length > 0) {
      const matched = await auditGlob(root,
        globs.map((g) => `${g.replace(/\/+$/, "")}/package.json`),
        { ignore: ["**/node_modules/**"], label: "npm workspace discovery" }
      );
      return {
        actual: matched.length,
        countedFrom: "package.json workspaces",
        members: matched.map((m) => path.dirname(m)).sort(),
      };
    }
  }

  const pnpmRaw = await readAuditInput(root, "pnpm-workspace.yaml");
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
      const matched = await auditGlob(root,
        globs.map((g) => `${g.replace(/\/+$/, "")}/package.json`),
        { ignore: ["**/node_modules/**"], label: "pnpm workspace discovery" }
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
  const content = await readAuditInput(root, "Cargo.toml");
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
      const matched = await auditGlob(root, `${entry.replace(/\/+$/, "")}/Cargo.toml`, {
        ignore: ["**/target/**"],
        label: "Cargo workspace discovery",
      });
      for (const m of matched) members.add(path.dirname(m));
    } else if (
      (await readAuditInput(root, path.posix.join(entry, "Cargo.toml"))) !== null
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
export async function resolveCountSource(
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

/** Nested documents cannot assert the root workspace's count implicitly. */
export async function resolveDocCountSource(root: string, doc: string, claim: CountClaim): Promise<CountSource | null> {
  const scope = documentScope(doc);
  const source = await resolveCountSource(path.join(root, scope), claim);
  if (!source || scope === ".") return source;
  return { ...source, countedFrom: scope + "/" + source.countedFrom,
    members: source.members.map(member => scope + "/" + member) };
}

export async function checkStaleCounts(
  ctx: CheckContext
): Promise<CheckResult> {
  const result = emptyResult();

  for (const doc of ctx.docs) {
    for (const claim of doc.claims.counts) {
      const source = await resolveDocCountSource(ctx.root, doc.path, claim);
      if (source === null) {
        result.skipped.push({ check: "stale-count", doc: doc.path,
          reason: `${doc.path}: cannot resolve a workspace manifest for "${claim.excerpt}"` });
        continue;
      }
      if (source.actual === claim.count) continue;
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
