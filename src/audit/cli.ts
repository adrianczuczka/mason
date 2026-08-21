import path from "node:path";
import { computeAudit } from "./audit.js";
import { ALL_CHECKS } from "./types.js";
import type { AuditIssue, AuditReport, CheckName } from "./types.js";

export const USAGE = `Usage: mason-audit [--dir <path>] [--json | --fix-prompt] [--checks <list>]

Audits the repo's AI context files (CLAUDE.md, .claude/CLAUDE.md, AGENTS.md)
against repo reality: referenced paths that no longer exist, undocumented
modules, stale counts, dead npm scripts, and manifests newer than the doc.
Deterministic: no LLM call, no network – safe for CI. Works on any repo with
a context file; no Mason setup required.

Options:
  --dir <path>     Project root to audit (default: current directory)
  --json           Print the full audit report as JSON (additive-only schema)
  --fix-prompt     When issues exist, print a work order for ANY coding agent
                   (Claude, Codex, Gemini, ...) – pipe it to your agent CLI to
                   close the loop. Prints the clean summary when there are none.
  --checks <list>  Comma-separated subset of checks to run (default: all):
                   ${ALL_CHECKS.join(", ")}
  --help           Show this help

Exit codes:
  0  no issues (advisories may still be present)
  1  provable issues found
  2  error (no context file, not a git repository, bad arguments)`;

export interface AuditCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

interface ParsedArgs {
  dir: string;
  json: boolean;
  fixPrompt: boolean;
  help: boolean;
  checks: CheckName[] | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dir: process.cwd(),
    json: false,
    fixPrompt: false,
    help: false,
    checks: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--fix-prompt") {
      parsed.fixPrompt = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dir") {
      const value = argv[++i];
      if (!value) throw new Error("--dir requires a path argument");
      parsed.dir = value;
    } else if (arg === "--checks") {
      const value = argv[++i];
      if (!value) throw new Error("--checks requires a comma-separated list");
      const names = value.split(",").map((n) => n.trim()).filter(Boolean);
      for (const name of names) {
        if (!ALL_CHECKS.includes(name as CheckName)) {
          throw new Error(
            `Unknown check: ${name} (valid: ${ALL_CHECKS.join(", ")})`
          );
        }
      }
      parsed.checks = names as CheckName[];
    } else if (!arg.startsWith("-") && parsed.dir === process.cwd()) {
      parsed.dir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function issueLine(issue: AuditIssue): string {
  const where =
    issue.anchor.line !== null ? `line ${issue.anchor.line}` : "doc-level";
  const likely = issue.confidence === "likely" ? " (likely)" : "";
  return `  [${issue.type}]${likely} ${where}: ${issue.message}`;
}

export function formatAuditSummary(report: AuditReport): string {
  const lines: string[] = [];

  for (const doc of report.docs) {
    const docIssues = report.issues.filter((i) => i.anchor.doc === doc.path);
    const committed = doc.lastCommit
      ? `last committed ${doc.lastCommit.date.slice(0, 10)}, ${doc.lastCommit.hash.slice(0, 7)}`
      : "untracked";
    if (docIssues.length === 0) {
      lines.push(`${doc.path} – clean (${committed})`);
      continue;
    }
    lines.push(
      `${doc.path} – ${docIssues.length} issue${docIssues.length === 1 ? "" : "s"} (${committed})`
    );
    for (const issue of docIssues) lines.push(issueLine(issue));
  }

  // Issues anchored outside the docs list (defensive; new-module anchors to
  // the primary doc, so this should stay empty).
  const docPaths = new Set(report.docs.map((d) => d.path));
  for (const issue of report.issues) {
    if (!docPaths.has(issue.anchor.doc)) lines.push(issueLine(issue));
  }

  if (report.advisories.length > 0) {
    lines.push("Advisories (do not affect the exit code):");
    for (const advisory of report.advisories) {
      lines.push(`  [${advisory.type}] ${advisory.anchor.doc}: ${advisory.message}`);
    }
  }
  if (report.skippedChecks.length > 0) {
    for (const skip of report.skippedChecks) {
      lines.push(`  [skipped] ${skip.check}: ${skip.reason}`);
    }
  }

  lines.push(
    report.clean
      ? `Context files are clean (${report.docs.length} doc${report.docs.length === 1 ? "" : "s"} audited).`
      : `${report.issues.length} issue${report.issues.length === 1 ? "" : "s"} across ${report.docs.length} doc${report.docs.length === 1 ? "" : "s"}.`
  );
  return lines.join("\n");
}

/**
 * Provider-neutral work order: any coding agent can execute it. The evidence
 * is deterministic; the agent's job is judgment scoped to exactly these
 * claims – never a free-form doc rewrite.
 */
export function formatFixPrompt(report: AuditReport): string {
  const flaggedDocs = [...new Set(report.issues.map((i) => i.anchor.doc))];
  const lines: string[] = [];
  lines.push(
    "The AI context files in this repository contain claims that are provably out of date. Fix ONLY the flagged claims. Work autonomously; do not ask questions."
  );
  lines.push("");
  lines.push("RULES:");
  lines.push(
    `- Edit ONLY these files: ${flaggedDocs.join(", ")}. Never modify source code, configs, or anything else – the docs must be brought to match the code, not the other way around.`
  );
  lines.push(
    "- Keep diffs minimal: change the smallest span that makes each claim true."
  );
  lines.push(
    "- Never invent content. Every replacement must be grounded in the evidence below or in files you read from this repository."
  );
  lines.push(
    "- deleted-reference: if evidence shows renamedTo, update the path; otherwise remove the reference, or rephrase to past tense if the sentence is about history. Deleted paths inside directory trees: delete the tree line."
  );
  lines.push(
    "- stale-count: replace the number with the actual count from the evidence."
  );
  lines.push(
    "- dead-command: replace with the correct script from availableScripts if an obvious rename exists; otherwise remove the command mention."
  );
  lines.push(
    "- new-module: add a one-line factual mention of the directory where sibling modules are described; read the directory's files first and describe only what you verified."
  );
  lines.push(
    "- Do NOT touch anything listed under ADVISORIES – list them in your summary for human review instead."
  );
  lines.push("");
  lines.push("AUDIT REPORT (deterministic, computed against git HEAD):");
  lines.push(
    JSON.stringify(
      { issues: report.issues, advisories: report.advisories },
      null,
      2
    )
  );
  lines.push("");
  lines.push(
    "Finish by summarizing each edit and citing the evidence item it resolves."
  );
  return lines.join("\n");
}

export async function runAuditCli(
  argv: string[],
  io: AuditCliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
    if (args.json && args.fixPrompt) {
      throw new Error("--json and --fix-prompt are mutually exclusive");
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }

  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  const rootDir = path.resolve(args.dir);
  const report = await computeAudit(rootDir, { checks: args.checks });

  if (!report) {
    io.err(
      `No CLAUDE.md, .claude/CLAUDE.md, or AGENTS.md found in ${rootDir}.`
    );
    return 2;
  }

  if (!report.gitAvailable) {
    io.err(
      `Could not determine git HEAD in ${rootDir} – not a git repository, or git is unavailable.`
    );
    return 2;
  }

  if (args.fixPrompt) {
    io.out(
      report.clean ? formatAuditSummary(report) : formatFixPrompt(report)
    );
    return report.clean ? 0 : 1;
  }

  if (args.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatAuditSummary(report));
  }
  return report.clean ? 0 : 1;
}
