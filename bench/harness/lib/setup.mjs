import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runSession } from "./session.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** Clone (local path or URL) into clonesDir and pin to the configured commit. */
export function ensureClone(config, clonesDir) {
  const dest = path.join(clonesDir, config.name);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(clonesDir, { recursive: true });
    execFileSync("git", ["clone", config.git, dest], { encoding: "utf-8" });
  }
  const head = git(dest, "rev-parse", "HEAD");
  if (config.commit && head !== config.commit) {
    git(dest, "fetch", "--all", "--quiet");
    git(dest, "checkout", "--quiet", config.commit);
  }
  return dest;
}

/**
 * Baseline fairness: both arms get a populated CLAUDE.md. If the repo has
 * none, generate one with headless /init. Returns the setup cost (0 if it
 * already existed).
 */
export async function ensureClaudeMd(repoDir, model) {
  const existing = [
    path.join(repoDir, "CLAUDE.md"),
    path.join(repoDir, ".claude", "CLAUDE.md"),
  ].some((p) => fs.existsSync(p));
  if (existing) return { costUsd: 0, generated: false };
  const res = await runSession({
    cwd: repoDir,
    prompt: "/init",
    model,
    maxTurns: 40,
    timeoutMs: 15 * 60 * 1000,
  });
  if (!fs.existsSync(path.join(repoDir, "CLAUDE.md"))) {
    throw new Error(`/init did not produce a CLAUDE.md in ${repoDir}: ${res.stderr}`);
  }
  return { costUsd: res.costUsd, generated: true };
}

/** Historical map evaluations require a pre-existing snapshot; no paid build fallback. */
export async function ensureSnapshot(repoDir) {
  if (!fs.existsSync(path.join(repoDir, ".mason", "snapshot.json"))) {
    throw new Error("This historical map benchmark requires an existing snapshot. Managed map creation has been removed; prepare a map with the older release before running this evaluation.");
  }
  return { costUsd: 0, generated: false, reused: true, originalBuildCostUsd: null };
}
