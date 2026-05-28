import { defineConfig } from "tsup";
import pkg from "./package.json";

export default defineConfig({
  entry: ["bin/mason.ts", "bin/mason-mcp.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["@anthropic-ai/sdk", "openai"],
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
