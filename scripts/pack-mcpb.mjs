#!/usr/bin/env node
// Builds mason.mcpb — a bundle for Smithery / Anthropic Desktop Extensions.
// Creates a clean .mcpb-bundle/ dir with manifest + dist + production deps,
// runs `mcpb pack`, then cleans up. Manifest version is synced from package.json.

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const BUNDLE_DIR = ".mcpb-bundle";
const OUTPUT = "mason.mcpb";

rmSync(BUNDLE_DIR, { recursive: true, force: true });
rmSync(OUTPUT, { force: true });
mkdirSync(BUNDLE_DIR);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = pkg.version;
writeFileSync(`${BUNDLE_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));

cpSync("package.json", `${BUNDLE_DIR}/package.json`);
cpSync("package-lock.json", `${BUNDLE_DIR}/package-lock.json`);
cpSync("dist", `${BUNDLE_DIR}/dist`, { recursive: true });

execSync("npm ci --omit=dev --ignore-scripts", { cwd: BUNDLE_DIR, stdio: "inherit" });
execSync(`npx -y @anthropic-ai/mcpb pack ${BUNDLE_DIR} ${OUTPUT}`, { stdio: "inherit" });

rmSync(BUNDLE_DIR, { recursive: true, force: true });
console.log(`\n✓ Built ${OUTPUT} (mason@${pkg.version})`);
