import { describe, it, expect } from "vitest";
import { extractClaims, normalizePathToken } from "../src/audit/claims.js";
import { extractTreeClaims } from "../src/audit/tree.js";

function pathsOf(content: string): string[] {
  return extractClaims(content).paths.map((p) => p.path);
}

describe("normalizePathToken", () => {
  it("accepts repo-relative paths and strips line suffixes", () => {
    expect(normalizePathToken("src/foo.ts")).toBe("src/foo.ts");
    expect(normalizePathToken("src/foo.ts:189")).toBe("src/foo.ts");
    expect(normalizePathToken("src/foo.ts:10-20")).toBe("src/foo.ts");
    expect(normalizePathToken("src/legacy/")).toBe("src/legacy");
  });

  it("rejects URLs, globs, placeholders, and relative examples", () => {
    expect(normalizePathToken("https://example.com/a")).toBeNull();
    expect(normalizePathToken("src/**/*.test.ts")).toBeNull();
    expect(normalizePathToken("path/to/<name>")).toBeNull();
    expect(normalizePathToken("$HOME/config")).toBeNull();
    expect(normalizePathToken("./relative.js")).toBeNull();
    expect(normalizePathToken("../up/one.ts")).toBeNull();
    expect(normalizePathToken("/absolute/path")).toBeNull();
    expect(normalizePathToken("~/home/path")).toBeNull();
    expect(normalizePathToken("C:\\windows\\path")).toBeNull();
  });

  it("accepts bare names only from the root-file allowlist", () => {
    expect(normalizePathToken("package.json")).toBe("package.json");
    expect(normalizePathToken("Makefile")).toBe("Makefile");
    expect(normalizePathToken("config.ts")).toBeNull();
    expect(normalizePathToken("foo")).toBeNull();
  });
});

describe("extractClaims: paths", () => {
  it("extracts backtick and quoted paths with line numbers", () => {
    const claims = extractClaims(
      'Line one.\nSee `src/audit/cli.ts` and "src/drift/drift.ts" here.\n'
    );
    expect(claims.paths).toEqual([
      { path: "src/audit/cli.ts", line: 2, excerpt: "src/audit/cli.ts" },
      { path: "src/drift/drift.ts", line: 2, excerpt: "src/drift/drift.ts" },
    ]);
  });

  it("dedupes repeated paths, keeping the first occurrence", () => {
    const claims = extractClaims("`src/a.ts` first\n`src/a.ts` again\n");
    expect(claims.paths).toHaveLength(1);
    expect(claims.paths[0].line).toBe(1);
  });

  it("skips prose-y backtick tokens", () => {
    expect(
      pathsOf("Run `npm install` and name your file `config.ts` or `words and/or more`.\n")
    ).toEqual([]);
  });

  it("claims exact-token path lines inside fences, but not code", () => {
    const content = [
      "```",
      "src/deep/file.ts",
      'import { x } from "./foo.js";',
      "```",
    ].join("\n");
    expect(pathsOf(content)).toEqual(["src/deep/file.ts"]);
  });
});

describe("extractClaims: counts", () => {
  it("extracts count claims outside fences", () => {
    const claims = extractClaims("The repo has 6 packages in one workspace.\n");
    expect(claims.counts).toEqual([
      { count: 6, unit: "packages", line: 1, excerpt: "6 packages" },
    ]);
  });

  it("ignores counts inside fences and denylisted noun phrases", () => {
    expect(extractClaims("```\n6 packages\n```\n").counts).toEqual([]);
    expect(extractClaims("We support 3 package managers.\n").counts).toEqual([]);
  });
});

describe("extractClaims: commands", () => {
  it("extracts npm-family run commands from prose and shell fences", () => {
    const content = [
      "Run `npm run build` first.",
      "```bash",
      "pnpm run lint",
      "```",
    ].join("\n");
    const claims = extractClaims(content);
    expect(claims.commands.map((c) => c.scriptName).sort()).toEqual([
      "build",
      "lint",
    ]);
  });

  it("ignores bare invocations and non-shell fences", () => {
    expect(extractClaims("Run `yarn build` here.\n").commands).toEqual([]);
    expect(extractClaims("```python\nnpm run x\n```\n").commands).toEqual([]);
  });

  it("dedupes commands by script name", () => {
    const claims = extractClaims("`npm run test` and `npm run test` twice\n");
    expect(claims.commands).toHaveLength(1);
  });
});

describe("extractClaims: ignore markers", () => {
  it("suppresses claims on a line with an end-of-line marker", () => {
    expect(
      pathsOf("`src/kept.ts`\n`src/dropped.ts` <!-- mason:ignore -->\n")
    ).toEqual(["src/kept.ts"]);
  });

  it("suppresses the next non-blank line for an own-line marker", () => {
    const content = [
      "<!-- mason:ignore -->",
      "",
      "`src/dropped.ts`",
      "`src/kept.ts`",
    ].join("\n");
    expect(pathsOf(content)).toEqual(["src/kept.ts"]);
  });

  it("suppresses a marked region", () => {
    const content = [
      "`src/kept.ts`",
      "<!-- mason:ignore-start -->",
      "`src/dropped.ts`",
      "We removed 12 packages.",
      "<!-- mason:ignore-end -->",
      "`src/also-kept.ts`",
    ].join("\n");
    const claims = extractClaims(content);
    expect(claims.paths.map((p) => p.path)).toEqual([
      "src/kept.ts",
      "src/also-kept.ts",
    ]);
    expect(claims.counts).toEqual([]);
  });
});

describe("extractTreeClaims", () => {
  const TREE = [
    "src/",
    "├── audit/          # The audit engine",
    "│   ├── cli.ts      # CLI entry",
    "│   └── checks/",
    "│       └── index.ts",
    "├── drift.ts        # Drift detection",
    "└── types.ts",
  ];

  it("reconstructs nested paths under a root prefix", () => {
    const claims = extractTreeClaims(TREE, 10);
    expect(claims.map((c) => c.path)).toEqual([
      "src",
      "src/audit",
      "src/audit/cli.ts",
      "src/audit/checks",
      "src/audit/checks/index.ts",
      "src/drift.ts",
      "src/types.ts",
    ]);
    expect(claims[2].line).toBe(12);
  });

  it("works without a root prefix", () => {
    const claims = extractTreeClaims(
      ["├── a/", "│   └── b.ts", "└── c.ts"],
      1
    );
    expect(claims.map((c) => c.path)).toEqual(["a", "a/b.ts", "c.ts"]);
  });

  it("requires at least three glyph lines", () => {
    expect(extractTreeClaims(["├── a.ts", "└── b.ts"], 1)).toEqual([]);
  });

  it("aborts below a malformed line, keeping earlier claims", () => {
    const claims = extractTreeClaims(
      ["├── a.ts", "├── not a path at all", "├── b.ts", "└── c.ts"],
      1
    );
    expect(claims.map((c) => c.path)).toEqual(["a.ts"]);
  });

  it("is reachable through a fenced block in extractClaims", () => {
    const content = ["Intro.", "```", ...TREE, "```"].join("\n");
    const paths = pathsOf(content);
    expect(paths).toContain("src/audit/checks/index.ts");
    expect(paths).toContain("src/drift.ts");
  });

  it("treats an ignored tree line as a spacer, keeping the rest", () => {
    const content = [
      "```",
      "src/",
      "├── a.ts",
      "├── gone.ts <!-- mason:ignore -->",
      "├── b.ts",
      "└── c.ts",
      "```",
    ].join("\n");
    const paths = pathsOf(content);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths).not.toContain("src/gone.ts");
  });
});
