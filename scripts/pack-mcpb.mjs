#!/usr/bin/env node
// Builds mason.mcpb — a Smithery-compatible MCP bundle.
//
// We don't use `mcpb pack` because it validates against MCPB's manifest
// spec, which forbids `inputSchema` in tool entries. Smithery doesn't
// validate against MCPB — it parses the bundled manifest and forwards
// `tools` straight into a `serverCard` payload that requires full MCP
// `Tool` objects (name + description + inputSchema). Building the zip
// ourselves keeps inputSchema intact.

import { execSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

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

execSync("npm ci --omit=dev --ignore-scripts", {
  cwd: BUNDLE_DIR,
  stdio: "inherit",
});

execSync(`zip -r -q -9 -X ../${OUTPUT} .`, {
  cwd: BUNDLE_DIR,
  stdio: "inherit",
});

rmSync(BUNDLE_DIR, { recursive: true, force: true });
console.log(`✓ Built ${OUTPUT} (mason@${pkg.version})`);
