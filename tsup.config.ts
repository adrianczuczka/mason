import { defineConfig } from "tsup";
import pkg from "./package.json";

export default defineConfig({
  entry: ["bin/mason.ts", "bin/mason-mcp.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
