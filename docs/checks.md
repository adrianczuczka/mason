# Audits, repairs, and CI review

[← Mason](../README.md)

- [Context-file audit](#context-file-audit)
- [Diff review (mason-review)](#diff-review-mason-review)

## Context-file audit

Your repo's AI context files — `CLAUDE.md`, `AGENTS.md` — are read by every agent on every task, and nobody owns them. Each merge makes them a little more wrong, and agents act on what they read: a stale claim becomes a misinformed edit. `mason-audit` keeps those files true. It finds claims that are provably out of date — deterministically, no LLM, no network — and works on any repo with a context file. No Mason setup required.

```bash
npx -p mason-context mason-audit --dir .           # exit 0 clean · 1 issues · 2 error
npx -p mason-context mason-audit --json            # full report as JSON (additive-only schema)
npx -p mason-context mason-audit --fix-prompt      # issues? print a work order for any agent
npx -p mason-context mason-audit --checks deleted-reference,stale-count,dead-command
```

What it checks:

| Check | Flags | Confidence |
|---|---|---|
| `deleted-reference` | a referenced path that no longer exists — including paths inside ASCII directory trees; renames resolve to the new path | certain (git history proves it) / likely (never tracked) |
| `new-module` | a directory with source files that no context file mentions | likely |
| `stale-count` | "6 packages" vs what the workspace manifest actually resolves to | certain |
| `dead-command` | `npm run <script>` naming a script no package.json has | certain |
| `deps-changed` | dependency manifests committed after the doc's last commit, excluding proven Android release metadata | advisory |
| `decision-anchor-drift` | a decision record whose anchor files changed (only when `.mason/decisions/` exists) | advisory |

The dependency advisory omits only recognized literal `versionName`/`versionCode` changes inside an Android `defaultConfig` block when every touched manifest qualifies. Dependency edits, computed values, unfamiliar syntax, and unrecognized metadata stay advisory. This filter does not approve or remove advisories already retained in a repair baseline.

Issues drive the exit code; **advisories never do** — they're facts an agent can't close by editing the doc, so they're reported for humans instead. Every issue carries a `doc:line` anchor and git-derived evidence (the deleting commit, the rename target, the actual count and its source). A claim you want left alone — say, a deliberate reference to a removed directory — gets an ignore marker: `<!-- mason:ignore -->` on the line, or `<!-- mason:ignore-start -->` / `<!-- mason:ignore-end -->` around a block.

### Track a repair through verification

Ask your assistant: *"Use Mason to prepare a repair, fix the documented issues within scope, and verify against the original findings."* The assistant calls `mason_repair` with `action: "prepare"`, makes grounded edits, and then calls it with `action: "verify"` and the returned `baselinePath`. Setup alone only installs assistant instructions; repairing existing claims needs to be part of your request.

The CLI provides the same workflow:

```bash
mason-audit --dir . --prepare-repair --fix-prompt
# After applying the work order, use the exact baseline path it returned:
mason-audit --dir . --verify-repair .mason/reports/repairs/<id>.json
```

Preparation saves the full original audit under `.mason/reports/repairs/`; it does not edit documentation. Ordinary audits and verification remain read-only. Add `.mason/reports/` to your ignore rules if you want these local artifacts excluded from commits. Keep the same baseline through any final documentation commit, then verify again. Do not regenerate it to clear unresolved findings. `--json` is supported for preparation and verification; use `--checks` only during preparation to select a scope.

Each original finding is **resolved** (its check no longer reports it), **unresolved**, **review-required**, or **unverified**. New findings are separate. A shifted line number does not erase the original claim, and a missing document, unavailable history, or skipped check cannot count as a fix. Inspect the edit for meaning: these deterministic checks do not establish complete documentation correctness. README files and arbitrary build commands are outside this audit's current scope.

Dependency evidence suppressed by local edits is retained in `suppressedAdvisories`, including when setup has already dirtied the document. Committing that document does not prove the dependency change was reviewed: the original advisory stays in the repair report. Record your assessment separately; this workflow does not approve advisories or decisions. Baselines are validated local evidence with a checksum to detect accidental edits, not authenticated attestations.

Ordinary audit exit codes remain **0** for no issues (advisories may exist), **1** for issues, and **2** for errors. Explicit `--verify-repair` uses **0** for verified scope, **1** for remaining/new issues, and **2** for incomplete verification, including advisories needing review or skipped checks. Incomplete verification takes precedence when both issues and unavailable evidence remain.

### Repair pull requests in CI

`--fix-prompt` emits a work order scoped to the flagged claims and the user's authorization. The reusable workflow below prepares a baseline, checks that the agent touched only context files, and verifies the original issues both before and after the documentation commit. It opens a PR only when those issues are resolved by their checks and no new issues appear. Advisories and skipped checks remain visible in the PR; their review is not a condition for proposing documentation repairs. The workflow never commits to the audited branch and skips when an audit PR is already open:

```yaml
name: Context audit
on:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:
permissions: { contents: write, pull-requests: write }
jobs:
  audit:
    uses: adrianczuczka/mason/.github/workflows/mason-audit.yml@main
    with:
      agent-command: >-
        claude -p "$MASON_AUDIT_PROMPT" --allowedTools "Read,Grep,Glob,Edit"
    secrets: inherit
```

Omit `agent-command` for detect-only mode: no agent, no credentials — the job fails when the context files have drifted, which is a reasonable default for repos that want the signal before the automation. Two GitHub notes: the repo setting **"Allow GitHub Actions to create and approve pull requests"** (Settings → Actions → General) must be enabled for the PR step, and PRs created with the default `GITHUB_TOKEN` don't trigger the repo's own CI — run your agent with PAT-backed auth if you need that.

## Diff review (mason-review)

A classic agent failure mode is the local edit that misses its coupled update — the serializer without the migration, the config without its consumer. The coupling is invisible to static analysis, but it's sitting in git history. `mason-review` diffs the current branch against a base ref and reports two things:

```bash
npx -p mason-context mason-review --base origin/main
```

- **Missing co-change partners** — files that changed together with a changed file in ≥60% of its commits (≥4 shared, 1500-commit window) but are absent from this diff. Evidence-based but heuristic-grade: a missing partner is a question to ask the diff, not proof of a bug. These drive exit 1.
- **Touched decisions** — decision records whose file or directory anchors the diff touches, including deleted paths and both sides of renames, listed with approval, owner, sources, last review, and freshness. Proposals and legacy records are distinguished from accepted constraints. Informational; never affect the exit code.

Deterministic, no LLM, one pass over git history. Run it locally before pushing, or wire it into CI as an advisory check (`mason-review || true` if you want the signal without the gate).

### Combine CI evidence with project knowledge

Import existing check results into the same review:

```bash
npx -p mason-context mason-review --base origin/main \
  --evidence .mason/reports/evidence.json
```

The review shows each check's outcome, command, source, and tested commit. Findings link to changed files and relevant **accepted, active decisions**, including their owner and freshness. Failing tests can also link through Mason's test-to-source pairs, with the pairing confidence shown. These associations give reviewers context; they do not establish that a decision was violated. Proposed and legacy decisions remain visible separately in the touched-decision list.

Supported artifacts are [Vitest JSON reporter output](https://vitest.dev/guide/reporters#json-reporter) for tests and [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html) for static analysis, security, complexity, or duplication findings. Mason imports results from those tools; it does not run their commands or infer a score for checks you have not supplied. JUnit and tool-specific non-SARIF analysis formats are not yet supported.

Create a manifest beside your artifacts. Replace the example commit and checkout path with values captured **when the check ran**, and record its actual exit code:

```json
{
  "version": 1,
  "checks": [
    {
      "id": "unit-tests",
      "kind": "tests",
      "tool": "vitest",
      "command": "npm test -- --reporter=json --outputFile=.mason/reports/vitest.json",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "workingTreeClean": true,
      "sourceRoot": "/runner/work/project",
      "source": "https://ci.example.com/runs/42",
      "exitCode": 0,
      "report": { "format": "vitest-json", "path": ".mason/reports/vitest.json" }
    },
    {
      "id": "security",
      "kind": "security",
      "tool": "your-security-scanner",
      "command": "your scanner command",
      "status": "skipped",
      "reason": "Security scanning is not configured in this job."
    }
  ]
}
```

For a completed analysis check, use `report.format: "sarif"`, its report path, and the same run provenance fields. Give every expected check a unique `id`; use `status: "skipped"` or `"unavailable"` with a reason when it did not run. Omitted checks cannot be detected. `status` defaults to `"completed"`. A successful SARIF invocation can supply completion evidence when an exit code is absent; Vitest imports require a recorded exit code for complete evidence.

Manifest and report paths are relative to the repository root, even when the manifest lives in a subdirectory. Absolute paths inside that root also work. `sourceRoot` maps file locations from the CI checkout to this checkout; it defaults to the local repository root. `source` is an optional CI run link or description. Artifacts must be regular files inside the repository, without symlinks, and at most 10 MiB each. Commands and links are displayed as imported provenance, never executed or fetched, and are not authenticated attestations.

Outcome and freshness are separate. A full tested commit matching the reviewed HEAD and `workingTreeClean: true` establish **current** commit evidence; a different commit is **stale**, while missing commit or dirty/unrecorded checkout state is **unknown**. Record cleanliness before and after the run, and invalidate attribution if HEAD changes during execution. A passing report for another commit cannot establish a pass for this one. Local uncommitted edits remain outside the review's committed scope.

Empty or entirely skipped test runs do not pass; partially skipped runs are incomplete. Malformed or missing artifacts stay unavailable. SARIF active `fail` results count as failures at every severity; explicitly accepted suppressions and results marked absent are retained separately. Failed analysis invocations and omitted results stay unavailable. Open/review results, unresolved locations, and unresolved suppression states preserve uncertainty. The JSON report retains overall counts even when findings are abbreviated (10 manifests, 50 checks, 200 findings per check, 5 related decisions per finding); MCP and text summaries have smaller previews and flag truncation.

Imports are advisory under the existing exit-code contract. Opt into a gate with:

```bash
npx -p mason-context mason-review --base origin/main \
  --evidence .mason/reports/evidence.json --require-evidence --json
```

| Exit | With `--require-evidence` |
| --- | --- |
| 0 | All declared checks are current, complete, and passing; no missing co-change partners. |
| 1 | A current check failed, or co-change partners are missing. |
| 2 | Evidence is missing, skipped, stale, unknown, or incomplete, or the review cannot run. Current failures take precedence over incomplete evidence. |

Through MCP, pass `evidence: [".mason/reports/evidence.json"]` to `mason_init`. No map or initialization is required. A passing import only describes the supplied checks, not complete coverage or overall correctness.

Mason's own checkout produces real test artifacts with `npm run test:evidence`, using [scripts/test-evidence.mjs](../scripts/test-evidence.mjs). It records the observed exit code and checkout state and invalidates previous evidence before starting a fresh run. After `npm run build`, inspect them with `node dist/mason-review.js --base HEAD --evidence .mason/reports/evidence.json`. A local run with uncommitted edits correctly has unknown commit attribution. The repository CI uses this producer and posts the combined review to its job summary. Add `.mason/reports/` to your ignore file when using that output directory; keep the decisions and map tracked.
