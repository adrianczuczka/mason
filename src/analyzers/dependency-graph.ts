import fs from "node:fs/promises";
import path from "node:path";
import { BaseAnalyzer } from "./base.js";
import type { AnalyzerContext, AnalyzerResult, Finding, Gap } from "../types.js";

interface PackageInfo {
  name: string;
  path: string;
  dependencies: string[];
  devDependencies: string[];
}

export class DependencyGraphAnalyzer extends BaseAnalyzer {
  name = "dependency-graph";

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    const workspaces = await this.detectWorkspaces(context);

    if (workspaces.length <= 1) {
      // Single package — still analyze external deps
      if (context.packageJson) {
        const depFindings = this.analyzeExternalDeps(context.packageJson, context.rootDir);
        findings.push(...depFindings);
      }
      return this.createResult(findings, gaps, startTime);
    }

    // Monorepo analysis
    const packages = await this.loadPackages(workspaces, context.rootDir);

    const boundaryFindings = this.detectBoundaryViolations(packages, context.rootDir);
    findings.push(...boundaryFindings);

    const cycleFindings = this.detectCycles(packages, context.rootDir);
    findings.push(...cycleFindings);

    const [isolatedFindings, isolatedGaps] = this.detectIsolatedPackages(packages);
    findings.push(...isolatedFindings);
    gaps.push(...isolatedGaps);

    // Structure overview
    if (packages.length >= 2) {
      findings.push(
        this.createFinding({
          category: "boundary",
          confidence: 0.95,
          summary: `Monorepo with ${packages.length} packages: ${packages.map((p) => p.name).join(", ")}`,
          evidence: packages.map((p) => ({
            filePath: path.relative(context.rootDir, p.path),
            detail: `${p.dependencies.length} internal deps`,
          })),
          ruleCandidate: `This is a monorepo with ${packages.length} packages. Respect package boundaries — import through the package's public API, not internal files.`,
        })
      );
    }

    // Also check external deps
    if (context.packageJson) {
      const depFindings = this.analyzeExternalDeps(context.packageJson, context.rootDir);
      findings.push(...depFindings);
    }

    return this.createResult(findings, gaps, startTime);
  }

  private async detectWorkspaces(
    context: AnalyzerContext
  ): Promise<string[]> {
    // npm/yarn workspaces from package.json
    if (context.packageJson) {
      const workspaces = context.packageJson.workspaces;
      if (Array.isArray(workspaces)) {
        return this.resolveWorkspaceGlobs(workspaces as string[], context.rootDir);
      }
      if (workspaces && typeof workspaces === "object" && "packages" in workspaces) {
        return this.resolveWorkspaceGlobs(
          (workspaces as { packages: string[] }).packages,
          context.rootDir
        );
      }
    }

    // pnpm-workspace.yaml
    try {
      const pnpmConfig = await fs.readFile(
        path.join(context.rootDir, "pnpm-workspace.yaml"),
        "utf-8"
      );
      const match = pnpmConfig.match(/packages:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (match) {
        const globs = match[1]
          .split("\n")
          .map((l) => l.replace(/^\s+-\s+['"]?/, "").replace(/['"]?\s*$/, ""))
          .filter(Boolean);
        return this.resolveWorkspaceGlobs(globs, context.rootDir);
      }
    } catch {
      // No pnpm workspace
    }

    // lerna.json
    try {
      const lernaRaw = await fs.readFile(
        path.join(context.rootDir, "lerna.json"),
        "utf-8"
      );
      const lerna = JSON.parse(lernaRaw);
      if (Array.isArray(lerna.packages)) {
        return this.resolveWorkspaceGlobs(lerna.packages, context.rootDir);
      }
    } catch {
      // No lerna
    }

    return [];
  }

  private async resolveWorkspaceGlobs(
    globs: string[],
    rootDir: string
  ): Promise<string[]> {
    const packageJsonPaths = await this.findFiles(
      globs.map((g) => `${g}/package.json`),
      rootDir
    );
    return packageJsonPaths.map((p) => path.dirname(p));
  }

  private async loadPackages(
    workspacePaths: string[],
    rootDir: string
  ): Promise<PackageInfo[]> {
    const packages: PackageInfo[] = [];
    const packageNames = new Set<string>();

    // First pass: collect all package names
    for (const wsPath of workspacePaths) {
      try {
        const raw = await fs.readFile(
          path.join(wsPath, "package.json"),
          "utf-8"
        );
        const pkg = JSON.parse(raw);
        if (pkg.name) packageNames.add(pkg.name);
      } catch {
        // Skip
      }
    }

    // Second pass: build package info with internal deps
    for (const wsPath of workspacePaths) {
      try {
        const raw = await fs.readFile(
          path.join(wsPath, "package.json"),
          "utf-8"
        );
        const pkg = JSON.parse(raw);
        if (!pkg.name) continue;

        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        const internalDeps = Object.keys(allDeps).filter((d) =>
          packageNames.has(d)
        );
        const internalDevDeps = Object.keys(pkg.devDependencies ?? {}).filter(
          (d) => packageNames.has(d)
        );

        packages.push({
          name: pkg.name,
          path: wsPath,
          dependencies: internalDeps,
          devDependencies: internalDevDeps,
        });
      } catch {
        // Skip
      }
    }

    return packages;
  }

  private detectBoundaryViolations(
    packages: PackageInfo[],
    rootDir: string
  ): Finding[] {
    // In a well-structured monorepo, packages should only depend on each other
    // through declared dependencies, not through file-level imports to internals
    // For now, we just report the dependency structure
    const findings: Finding[] = [];
    const depMap = new Map<string, string[]>();

    for (const pkg of packages) {
      if (pkg.dependencies.length > 0) {
        depMap.set(pkg.name, pkg.dependencies);
      }
    }

    if (depMap.size > 0) {
      const edges: string[] = [];
      for (const [from, deps] of depMap) {
        for (const dep of deps) {
          edges.push(`${from} → ${dep}`);
        }
      }

      findings.push(
        this.createFinding({
          category: "boundary",
          confidence: 0.9,
          summary: `Package dependency graph: ${edges.length} internal dependencies`,
          evidence: edges.map((e) => ({
            filePath: rootDir,
            detail: e,
          })),
          ruleCandidate: `Internal package dependencies: ${edges.join("; ")}. Only import from packages listed as dependencies.`,
        })
      );
    }

    return findings;
  }

  private detectCycles(
    packages: PackageInfo[],
    rootDir: string
  ): Finding[] {
    const graph = new Map<string, string[]>();
    for (const pkg of packages) {
      graph.set(pkg.name, pkg.dependencies);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (node: string, pathSoFar: string[]): void => {
      if (inStack.has(node)) {
        const cycleStart = pathSoFar.indexOf(node);
        cycles.push([...pathSoFar.slice(cycleStart), node]);
        return;
      }
      if (visited.has(node)) return;

      visited.add(node);
      inStack.add(node);

      for (const dep of graph.get(node) ?? []) {
        dfs(dep, [...pathSoFar, node]);
      }

      inStack.delete(node);
    };

    for (const pkg of packages) {
      dfs(pkg.name, []);
    }

    if (cycles.length > 0) {
      return [
        this.createFinding({
          category: "risk",
          confidence: 0.95,
          summary: `${cycles.length} circular dependency cycle(s) detected between packages`,
          evidence: cycles.map((c) => ({
            filePath: rootDir,
            detail: c.join(" → "),
          })),
          ruleCandidate: `Circular dependencies exist between packages: ${cycles.map((c) => c.join(" → ")).join("; ")}. Avoid adding new cross-dependencies that deepen these cycles.`,
        }),
      ];
    }

    return [];
  }

  private detectIsolatedPackages(
    packages: PackageInfo[]
  ): [Finding[], Gap[]] {
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    const dependedOn = new Set<string>();
    for (const pkg of packages) {
      for (const dep of pkg.dependencies) {
        dependedOn.add(dep);
      }
    }

    const isolated = packages.filter(
      (p) => p.dependencies.length === 0 && !dependedOn.has(p.name)
    );

    for (const pkg of isolated) {
      gaps.push({
        analyzer: this.name,
        question: `Package "${pkg.name}" has no internal dependencies and nothing depends on it. Is it deprecated or standalone?`,
        context: `Located at ${pkg.path}`,
        answerKey: `isolated-pkg-${pkg.name}`,
      });
    }

    return [findings, gaps];
  }

  private analyzeExternalDeps(
    packageJson: Record<string, unknown>,
    rootDir: string
  ): Finding[] {
    const findings: Finding[] = [];

    const deps = packageJson.dependencies as Record<string, string> | undefined;
    const devDeps = packageJson.devDependencies as Record<string, string> | undefined;

    if (!deps && !devDeps) return findings;

    const allDeps = { ...deps };
    const allDevDeps = { ...devDeps };

    // Detect misplaced dependencies (runtime deps that look like dev deps)
    const devishPatterns = [
      /^@types\//,
      /^eslint/,
      /^prettier/,
      /^typescript$/,
      /^ts-node$/,
      /^tsx$/,
      /^vitest$/,
      /^jest$/,
      /^mocha$/,
      /lint/,
    ];

    const misplaced = Object.keys(allDeps).filter((dep) =>
      devishPatterns.some((p) => p.test(dep))
    );

    if (misplaced.length > 0) {
      findings.push(
        this.createFinding({
          category: "risk",
          confidence: 0.8,
          summary: `${misplaced.length} potentially misplaced dependencies (dev tools in production deps)`,
          evidence: misplaced.map((dep) => ({
            filePath: "package.json",
            detail: `"${dep}" is in dependencies but looks like a devDependency`,
          })),
          ruleCandidate: `These packages should likely be in devDependencies: ${misplaced.join(", ")}. Only production runtime dependencies belong in "dependencies".`,
        })
      );
    }

    // Report total dependency count as context
    const totalDeps = Object.keys(allDeps).length;
    const totalDevDeps = Object.keys(allDevDeps).length;

    if (totalDeps + totalDevDeps > 50) {
      findings.push(
        this.createFinding({
          category: "risk",
          confidence: 0.6,
          summary: `Large dependency footprint: ${totalDeps} production + ${totalDevDeps} dev dependencies`,
          evidence: [
            {
              filePath: "package.json",
              detail: `${totalDeps} deps + ${totalDevDeps} devDeps = ${totalDeps + totalDevDeps} total`,
            },
          ],
          ruleCandidate:
            "This project has many dependencies. Avoid adding new ones unless necessary — check if existing deps already cover the need.",
        })
      );
    }

    return findings;
  }
}
