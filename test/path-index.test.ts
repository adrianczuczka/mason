import { expect, it } from "vitest";
import { indexMatchingPaths, matchingPaths } from "../src/utils/paths.js";

it("preserves prefix boundaries, overlapping anchors, normalization and inventory order", () => {
  const scopes = [
    [],
    ["src"],
    ["src", "src/nested", "src/a.ts", "src"],
    ["src/nested"],
    ["src-other"],
    ["src\\nested\\b.ts"],
    ["../escape", "/absolute", ".", "C:/outside"],
    ["src/./nested/"],
  ];
  const files = [
    "src/nested/b.ts",
    "src-other/a.ts",
    "src/a.ts",
    "src/nested/b.ts",
    "src2/a.ts",
    "src\\nested\\b.ts",
    "src",
    "src/nested",
    "../escape/a.ts",
    "src/../outside",
    "/absolute/a.ts",
  ];
  expect(indexMatchingPaths(scopes, files)).toEqual(
    scopes.map((scope) => matchingPaths(scope, files)),
  );
});

it("matches the existing predicate across a broad inventory and many distinct scopes", () => {
  const scopes = Array.from({ length: 150 }, (_, i) => [
    `packages/pkg-${i}/src`,
    `packages/pkg-${i}/src/file-1.ts`,
  ]);
  const files = Array.from(
    { length: 10000 },
    (_, i) => `packages/pkg-${i % 200}/src/file-${Math.floor(i / 200)}.ts`,
  );
  // Bound the slow reference comparison; scaling timings belong in benchmarks.
  const referenceFiles = files.slice(0, 1000);
  expect(indexMatchingPaths(scopes, referenceFiles)).toEqual(
    scopes.map((scope) => matchingPaths(scope, referenceFiles)),
  );
  // The full inventory contains 50 ordered files per package. Overlapping
  // file anchors must not duplicate the directory's matches.
  expect(indexMatchingPaths(scopes, files)).toEqual(
    scopes.map((_, i) =>
      Array.from({ length: 50 }, (_, j) => `packages/pkg-${i}/src/file-${j}.ts`),
    ),
  );
});
