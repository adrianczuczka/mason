import path from "node:path";
import { Project, SyntaxKind, Node } from "ts-morph";
import { BaseAnalyzer } from "./base.js";
import type { AnalyzerContext, AnalyzerResult, Finding, Gap } from "../types.js";

const MAX_FILES = 500;
const SAMPLE_SIZE = 200;

export class PatternDetectionAnalyzer extends BaseAnalyzer {
  name = "pattern-detection";

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    const tsFiles = await this.findFiles(
      ["**/*.{ts,tsx,js,jsx}"],
      context.rootDir
    );

    if (tsFiles.length === 0) {
      return this.createResult([], [], startTime);
    }

    const filesToAnalyze =
      tsFiles.length > MAX_FILES ? sampleEvenly(tsFiles, SAMPLE_SIZE) : tsFiles;

    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: { allowJs: true },
    });

    for (const file of filesToAnalyze) {
      try {
        project.addSourceFileAtPath(file);
      } catch {
        // Skip files that can't be parsed
      }
    }

    const sourceFiles = project.getSourceFiles();

    const exportFindings = this.analyzeExportStyle(sourceFiles, context.rootDir);
    findings.push(...exportFindings);

    const namingFindings = this.analyzeNamingConventions(sourceFiles, context.rootDir);
    findings.push(...namingFindings);

    const errorFindings = this.analyzeErrorHandling(sourceFiles, context.rootDir);
    findings.push(...errorFindings);

    const reactFindings = this.analyzeReactPatterns(sourceFiles, context.rootDir);
    findings.push(...reactFindings);
    if (reactFindings.length > 0) {
      gaps.push(...this.reactGaps(sourceFiles));
    }

    const asyncFindings = this.analyzeAsyncPatterns(sourceFiles, context.rootDir);
    findings.push(...asyncFindings);

    return this.createResult(findings, gaps, startTime);
  }

  private analyzeExportStyle(
    sourceFiles: ReturnType<Project["getSourceFiles"]>,
    rootDir: string
  ): Finding[] {
    let namedExports = 0;
    let defaultExports = 0;

    for (const sf of sourceFiles) {
      const hasDefault = sf.getDefaultExportSymbol() !== undefined;
      const namedCount = sf.getExportedDeclarations().size;

      if (hasDefault) defaultExports++;
      if (namedCount > (hasDefault ? 1 : 0)) namedExports++;
    }

    const total = namedExports + defaultExports;
    if (total < 5) return [];

    const namedRatio = namedExports / total;
    const defaultRatio = defaultExports / total;

    if (namedRatio > 0.7) {
      return [
        this.createFinding({
          category: "convention",
          confidence: Math.min(namedRatio, 0.95),
          summary: `${Math.round(namedRatio * 100)}% of modules use named exports over default exports`,
          evidence: [
            {
              filePath: rootDir,
              detail: `${namedExports} named vs ${defaultExports} default export files`,
            },
          ],
          ruleCandidate:
            "Prefer named exports over default exports for better refactoring support and explicit imports.",
        }),
      ];
    }

    if (defaultRatio > 0.7) {
      return [
        this.createFinding({
          category: "convention",
          confidence: Math.min(defaultRatio, 0.95),
          summary: `${Math.round(defaultRatio * 100)}% of modules use default exports`,
          evidence: [
            {
              filePath: rootDir,
              detail: `${defaultExports} default vs ${namedExports} named export files`,
            },
          ],
          ruleCandidate:
            "Use default exports for the primary export of each module.",
        }),
      ];
    }

    return [];
  }

  private analyzeNamingConventions(
    sourceFiles: ReturnType<Project["getSourceFiles"]>,
    rootDir: string
  ): Finding[] {
    const findings: Finding[] = [];
    let camelCaseFunctions = 0;
    let nonCamelFunctions = 0;
    let pascalCaseClasses = 0;
    let upperSnakeConstants = 0;
    let totalConstants = 0;

    for (const sf of sourceFiles) {
      // Functions
      for (const fn of sf.getFunctions()) {
        const name = fn.getName();
        if (!name) continue;
        if (/^[a-z][a-zA-Z0-9]*$/.test(name)) {
          camelCaseFunctions++;
        } else {
          nonCamelFunctions++;
        }
      }

      // Classes
      for (const cls of sf.getClasses()) {
        const name = cls.getName();
        if (name && /^[A-Z][a-zA-Z0-9]*$/.test(name)) {
          pascalCaseClasses++;
        }
      }

      // Top-level const declarations
      for (const stmt of sf.getVariableStatements()) {
        if (stmt.getDeclarationKind().toString() === "const") {
          for (const decl of stmt.getDeclarations()) {
            const name = decl.getName();
            // Only count top-level module-scoped constants
            if (Node.isSourceFile(decl.getParent()?.getParent() as Node)) {
              totalConstants++;
              if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
                upperSnakeConstants++;
              }
            }
          }
        }
      }
    }

    const totalFunctions = camelCaseFunctions + nonCamelFunctions;
    if (totalFunctions >= 5) {
      const camelRatio = camelCaseFunctions / totalFunctions;
      if (camelRatio > 0.8) {
        findings.push(
          this.createFinding({
            category: "convention",
            confidence: Math.min(camelRatio, 0.95),
            summary: `${Math.round(camelRatio * 100)}% of functions use camelCase naming`,
            evidence: [
              {
                filePath: rootDir,
                detail: `${camelCaseFunctions} of ${totalFunctions} functions`,
              },
            ],
            ruleCandidate:
              "Use camelCase for function names.",
          })
        );
      }
    }

    if (totalConstants >= 5) {
      const upperRatio = upperSnakeConstants / totalConstants;
      if (upperRatio > 0.5) {
        findings.push(
          this.createFinding({
            category: "convention",
            confidence: Math.min(upperRatio + 0.1, 0.95),
            summary: `${Math.round(upperRatio * 100)}% of top-level constants use UPPER_SNAKE_CASE`,
            evidence: [
              {
                filePath: rootDir,
                detail: `${upperSnakeConstants} of ${totalConstants} constants`,
              },
            ],
            ruleCandidate:
              "Use UPPER_SNAKE_CASE for top-level constants and configuration values.",
          })
        );
      }
    }

    return findings;
  }

  private analyzeErrorHandling(
    sourceFiles: ReturnType<Project["getSourceFiles"]>,
    rootDir: string
  ): Finding[] {
    let tryCatchCount = 0;
    let catchCallbackCount = 0;

    for (const sf of sourceFiles) {
      sf.forEachDescendant((node) => {
        if (node.getKind() === SyntaxKind.TryStatement) {
          tryCatchCount++;
        }
        if (
          node.getKind() === SyntaxKind.CallExpression &&
          node.getText().includes(".catch(")
        ) {
          catchCallbackCount++;
        }
      });
    }

    const total = tryCatchCount + catchCallbackCount;
    if (total < 3) return [];

    if (tryCatchCount > catchCallbackCount * 2) {
      return [
        this.createFinding({
          category: "pattern",
          confidence: 0.7,
          summary: `Error handling prefers try/catch (${tryCatchCount}) over .catch() callbacks (${catchCallbackCount})`,
          evidence: [
            {
              filePath: rootDir,
              detail: `${tryCatchCount} try/catch vs ${catchCallbackCount} .catch()`,
            },
          ],
          ruleCandidate:
            "Use try/catch blocks for error handling rather than .catch() callbacks.",
        }),
      ];
    }

    if (catchCallbackCount > tryCatchCount * 2) {
      return [
        this.createFinding({
          category: "pattern",
          confidence: 0.7,
          summary: `Error handling prefers .catch() callbacks (${catchCallbackCount}) over try/catch (${tryCatchCount})`,
          evidence: [
            {
              filePath: rootDir,
              detail: `${catchCallbackCount} .catch() vs ${tryCatchCount} try/catch`,
            },
          ],
          ruleCandidate:
            "Use .catch() for promise error handling rather than wrapping in try/catch.",
        }),
      ];
    }

    return [];
  }

  private analyzeReactPatterns(
    sourceFiles: ReturnType<Project["getSourceFiles"]>,
    rootDir: string
  ): Finding[] {
    const findings: Finding[] = [];
    let functionComponents = 0;
    let classComponents = 0;
    let arrowComponents = 0;
    let forwardRefCount = 0;
    let totalComponents = 0;

    const tsxFiles = sourceFiles.filter((sf) =>
      sf.getFilePath().endsWith(".tsx") || sf.getFilePath().endsWith(".jsx")
    );

    if (tsxFiles.length < 3) return [];

    for (const sf of tsxFiles) {
      // Check for React imports as a signal
      const hasReact = sf.getImportDeclarations().some(
        (imp) => imp.getModuleSpecifierValue() === "react"
      );
      if (!hasReact) continue;

      for (const fn of sf.getFunctions()) {
        if (returnsJSX(fn)) {
          functionComponents++;
          totalComponents++;
        }
      }

      for (const stmt of sf.getVariableStatements()) {
        for (const decl of stmt.getDeclarations()) {
          const init = decl.getInitializer();
          if (init && Node.isArrowFunction(init)) {
            if (returnsJSX(init)) {
              arrowComponents++;
              totalComponents++;
            }
          }
        }
      }

      for (const cls of sf.getClasses()) {
        const ext = cls.getExtends();
        if (ext && ext.getText().includes("Component")) {
          classComponents++;
          totalComponents++;
        }
      }

      // forwardRef usage
      const text = sf.getFullText();
      if (text.includes("forwardRef")) {
        forwardRefCount++;
      }
    }

    if (totalComponents < 3) return findings;

    if (functionComponents + arrowComponents > 0 && classComponents === 0) {
      findings.push(
        this.createFinding({
          category: "convention",
          confidence: 0.9,
          summary: `All ${totalComponents} React components are functional (no class components)`,
          evidence: [
            {
              filePath: rootDir,
              detail: `${functionComponents} function declarations, ${arrowComponents} arrow functions`,
            },
          ],
          ruleCandidate:
            "Use functional components exclusively — no class components.",
        })
      );
    }

    if (arrowComponents > functionComponents * 2 && arrowComponents >= 3) {
      findings.push(
        this.createFinding({
          category: "convention",
          confidence: 0.8,
          summary: `React components prefer arrow functions (${arrowComponents}) over function declarations (${functionComponents})`,
          evidence: [
            {
              filePath: rootDir,
              detail: `${arrowComponents} arrow vs ${functionComponents} function declaration components`,
            },
          ],
          ruleCandidate:
            "Define React components as arrow functions assigned to const variables.",
        })
      );
    }

    if (forwardRefCount > 0 && tsxFiles.length > 0) {
      const refRatio = forwardRefCount / tsxFiles.length;
      if (refRatio > 0.3) {
        findings.push(
          this.createFinding({
            category: "convention",
            confidence: 0.75,
            summary: `${Math.round(refRatio * 100)}% of component files use forwardRef`,
            evidence: [
              {
                filePath: rootDir,
                detail: `${forwardRefCount} of ${tsxFiles.length} TSX/JSX files`,
              },
            ],
            ruleCandidate:
              "Use React.forwardRef when creating reusable components to support ref forwarding.",
          })
        );
      }
    }

    return findings;
  }

  private reactGaps(
    sourceFiles: ReturnType<Project["getSourceFiles"]>
  ): Gap[] {
    // Check for state management signals
    const gaps: Gap[] = [];
    let usesRedux = false;
    let usesContext = false;
    let usesZustand = false;

    for (const sf of sourceFiles) {
      const text = sf.getFullText();
      if (text.includes("@reduxjs/toolkit") || text.includes("react-redux"))
        usesRedux = true;
      if (text.includes("createContext") || text.includes("useContext"))
        usesContext = true;
      if (text.includes("zustand")) usesZustand = true;
    }

    const stateLibs = [
      usesRedux && "Redux",
      usesContext && "React Context",
      usesZustand && "Zustand",
    ].filter(Boolean);

    if (stateLibs.length > 1) {
      gaps.push({
        analyzer: this.name,
        question: `Multiple state management approaches detected: ${stateLibs.join(", ")}. Which should be preferred for new code?`,
        context: `Found usage of ${stateLibs.join(" and ")}`,
        answerKey: "state-management-preference",
      });
    }

    return gaps;
  }

  private analyzeAsyncPatterns(
    sourceFiles: ReturnType<Project["getSourceFiles"]>,
    rootDir: string
  ): Finding[] {
    let asyncAwaitCount = 0;
    let thenChainCount = 0;

    for (const sf of sourceFiles) {
      sf.forEachDescendant((node) => {
        if (
          node.getKind() === SyntaxKind.AwaitExpression
        ) {
          asyncAwaitCount++;
        }
        if (
          node.getKind() === SyntaxKind.CallExpression &&
          node.getText().includes(".then(")
        ) {
          thenChainCount++;
        }
      });
    }

    const total = asyncAwaitCount + thenChainCount;
    if (total < 5) return [];

    const awaitRatio = asyncAwaitCount / total;
    if (awaitRatio > 0.7) {
      return [
        this.createFinding({
          category: "convention",
          confidence: Math.min(awaitRatio, 0.95),
          summary: `Async code uses async/await (${asyncAwaitCount}) over .then() chains (${thenChainCount})`,
          evidence: [
            {
              filePath: rootDir,
              detail: `${asyncAwaitCount} await vs ${thenChainCount} .then()`,
            },
          ],
          ruleCandidate:
            "Use async/await for asynchronous code instead of .then() chains.",
        }),
      ];
    }

    return [];
  }
}

function returnsJSX(node: Node): boolean {
  let found = false;
  node.forEachDescendant((child) => {
    if (
      child.getKind() === SyntaxKind.JsxElement ||
      child.getKind() === SyntaxKind.JsxSelfClosingElement ||
      child.getKind() === SyntaxKind.JsxFragment
    ) {
      found = true;
    }
  });
  return found;
}

function sampleEvenly(files: string[], count: number): string[] {
  const step = Math.floor(files.length / count);
  const sampled: string[] = [];
  for (let i = 0; i < files.length && sampled.length < count; i += step) {
    sampled.push(files[i]);
  }
  return sampled;
}
