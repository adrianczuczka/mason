import path from "node:path";
import fg from "fast-glob";

const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.gradle/**",
  "**/target/**",
  "**/.git/**",
  "**/vendor/**",
  "**/__pycache__/**",
  "**/venv/**",
  "**/.venv/**",
  "**/*.min.*",
  "**/*.map",
];

export interface TestPair {
  test: string;
  source: string;
  confidence: string;
}

export interface TestMapResult {
  totalTestFiles: number;
  paired: TestPair[];
  unmatched: string[];
}

export async function buildTestMap(dir: string): Promise<TestMapResult> {
  const rootDir = path.resolve(dir);

  // Find all test files
  const testPatterns = [
    "**/*.test.*", "**/*.spec.*",
    "**/*Test.kt", "**/*Test.java", "**/*Tests.kt", "**/*Tests.java",
    "**/test_*.py", "**/*_test.py",
    "**/*_test.go",
    "**/*Tests.swift", "**/*Test.swift",
    "**/*_test.rs",
  ];
  const testFiles = await fg(testPatterns, { cwd: rootDir, ignore: IGNORE });

  // Find all source files
  const sourceFiles = await fg(
    "**/*.{ts,tsx,js,jsx,kt,kts,java,py,go,rs,swift,rb,cs,cpp,dart}",
    { cwd: rootDir, ignore: IGNORE }
  );

  // Build source file index by base name (without extension)
  const sourceByBaseName = new Map<string, string[]>();
  for (const file of sourceFiles) {
    if (testFiles.includes(file)) continue; // Skip test files
    const baseName = path.basename(file).replace(/\.[^.]+$/, "");
    const existing = sourceByBaseName.get(baseName) ?? [];
    existing.push(file);
    sourceByBaseName.set(baseName, existing);
  }

  // Match test files to source files by name
  const paired: TestPair[] = [];
  const unmatched: string[] = [];

  for (const testFile of testFiles) {
    const testBaseName = path.basename(testFile).replace(/\.[^.]+$/, "");

    // Strip test suffixes/prefixes to get the source name
    const sourceName = testBaseName
      .replace(/Test$|Tests$|Spec$|\.test$|\.spec$/, "")
      .replace(/^test_|_test$/, "");

    if (!sourceName) {
      unmatched.push(testFile);
      continue;
    }

    const candidates = sourceByBaseName.get(sourceName);
    if (candidates && candidates.length > 0) {
      // If multiple candidates, prefer one in a similar directory path
      const testDir = path.dirname(testFile);
      const bestMatch = candidates.reduce((best, candidate) => {
        const candidateDir = path.dirname(candidate);
        const bestDir = path.dirname(best);
        const candidateOverlap = commonSegments(testDir, candidateDir);
        const bestOverlap = commonSegments(testDir, bestDir);
        return candidateOverlap > bestOverlap ? candidate : best;
      });

      paired.push({
        test: testFile,
        source: bestMatch,
        confidence: candidates.length === 1 ? "exact" : "best-guess",
      });
    } else {
      unmatched.push(testFile);
    }
  }

  return { totalTestFiles: testFiles.length, paired, unmatched };
}

function commonSegments(pathA: string, pathB: string): number {
  const segsA = pathA.split("/");
  const segsB = pathB.split("/");
  let count = 0;
  for (let i = 0; i < Math.min(segsA.length, segsB.length); i++) {
    if (segsA[i] === segsB[i]) count++;
    else break;
  }
  return count;
}
