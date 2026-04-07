import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["bin/foreman.ts", "src/cli.ts"],
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
