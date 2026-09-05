import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration suites spawn many Git processes; bound fan-out on developer machines and CI.
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    exclude: ["test/fixtures/**"],
  },
});
