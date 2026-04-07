import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["bin/mason.ts", "bin/mason-mcp.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
