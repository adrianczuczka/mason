# Mason – the system of record for your codebase's AI assistants 👷

[![npm version](https://img.shields.io/npm/v/mason-context)](https://www.npmjs.com/package/mason-context)
[![CI](https://img.shields.io/github/actions/workflow/status/adrianczuczka/mason/ci.yml?branch=main)](https://github.com/adrianczuczka/mason/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/mason-context)](https://www.npmjs.com/package/mason-context)
[![license](https://img.shields.io/github/license/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/blob/main/LICENSE)
[![issues](https://img.shields.io/github/issues/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/issues)

### Give coding assistants the lessons your team already learned, the changes they might miss, and evidence of what is still current.

Project direction and remaining evidence gaps are recorded in [the roadmap](ROADMAP.md).

Start with useful checks in an existing Git repository — no setup, map build, or model calls:

```bash
npx -p mason-context mason-audit --dir .
npx -p mason-context mason-review --dir . --base origin/main
```

The audit checks claims in `AGENTS.md` and `CLAUDE.md` against the repository. The review checks committed changes from the merge base to HEAD for missing historical change partners and touched decisions. Choose the base branch you normally review against. Missing context files, unavailable history, and skipped checks are reported explicitly; these commands do not certify a patch's correctness.

To capture and retrieve lessons while coding, connect Mason to your assistant:

```bash
claude mcp add mason --scope user -- npx -p mason-context mason-mcp
```

Restart Claude Code, then ask: *"Use Mason to check this project and set up decision capture."* `mason_init` returns the audit and review findings plus a short guide for adding Mason instructions to the project's existing `AGENTS.md` or `CLAUDE.md`. It does not build a map by default.

After resolving a real incident or settling a constraint, ask your assistant to record the reason with `save_decision`. On the next related task, `get_context` retrieves it as a proposal with file impact, tests, and trust evidence. Use `review_decision` when you are ready to record acceptance. Both work immediately, even without running setup.

For architecture navigation, ask: *"Build a Mason concept map."* The assistant calls `mason_init` with `mode: "map"` for the full Map-Reduce workflow.

> **0.10.1 decision fix:** Accepted constraints remain visible while their replacement revisions are proposed. Update every client sharing the decision store to `mason-context@0.10.1` and restart it; no data migration is needed. See the [release notes](CHANGELOG.md#0101--2026-09-05).

> **Upgrading from 0.9.x:** Update Mason in every client that shares decision records, then re-run `mason_init` and refresh the marker-delimited assistant instructions. New decisions are version 2 proposals; legacy records stay explicitly unreviewed until reviewed. Use `review_decision` for acceptance or reaffirmation; saving unchanged content no longer refreshes evidence. Map builds now require `mode: "map"`. See the [migration notes](CHANGELOG.md#upgrading-from-090).

> **0.4.0 note:** The previous `mason <command>` CLI was removed in v0.4.0. Setup and map editing use MCP; dedicated drift, audit, hook, and review binaries support automation. See [0.4.0 migration](#040-migration) below if you used the old CLI.

---

## The pain

Agentic search keeps getting better at re-deriving what's *in* the code — but three kinds of context can't be re-derived, and today they evaporate:

- **Decisions.** "We tried retrying 401s in 2023; it locked accounts." Your assistant re-suggests it next sprint, in every teammate's session.
- **History.** Which files change together, which dirs are dead — knowledge that lives in thousands of commits, too expensive to mine per session.
- **Freshness.** Any cached understanding — a wiki, a CLAUDE.md, a map — rots silently, and a confidently wrong assistant is worse than a slow one.

## The fix

Mason is an MCP server that assembles repository knowledge per task and checks it against source and Git evidence:

- **Decision records** (`.mason/decisions/`) — lessons and constraints captured by `save_decision`, ready for normal code review and commit
- **Optional concept map** (`.mason/snapshot.json`) — features and flows → files, built by your assistant, spot-checked by `verify_snapshot`
- **Drift engine** — LLM-free evidence of what changed, per entry, with a self-maintaining refresh loop for CI

One `get_context` call retrieves matching decisions with their full rationale and trust evidence. Known file paths or matched decision anchors provide tests and impact; an available map adds relevant features and flows. An optional map looks like:

```json
{
  "features": {
    "home screen": {
      "files": ["HomeScreen.kt", "HomeViewModel.kt", "GetWeatherDataUseCase.kt"]
    }
  },
  "flows": {
    "weather fetch": {
      "chain": ["HomeViewModel.kt", "WeatherRepositoryImpl.kt", "WeatherServiceImpl.kt"]
    }
  }
}
```

The assistant jumps straight to the relevant files instead of exploring.

**Where the map comes from:** Mason doesn't parse your code. Your assistant reads the project through Mason's analysis tools and writes the map itself — capturing architectural intent, not just symbols and call edges. Setup adds a short section to your project's assistant instructions so future sessions consult the available knowledge.

## What the numbers say

Measured with real headless agent sessions in A/B arms (baseline always has a populated CLAUDE.md — beating a context-free agent is not a result). Full harness, pinned commits, and losses included: [bench/harness/](bench/harness/).

These measurements concern read-only answers. The new [patch benchmark](bench/harness/patches/README.md) grades actual code changes, companion updates, and constraint preservation. Its offline checks validate the harness; improved patch outcomes and an acceptable false-positive rate have not yet been established.

- **Where Mason wins — knowledge that isn't in the code.** On tasks whose correct answer hinges on a recorded engineering decision (seeded fairly: the baseline had the same facts in a discoverable doc), Mason averaged **9.0/10 vs 7.0/10**. The baseline missed the constraint entirely half the time, and needed ~3× the turns when it found it; Mason surfaced it in one `get_context` call, every time.
- **Stale-map safety.** Against a deliberately stale map, the drift flag + changed-file previews led the agent to verify and answer current-code truth — the "confidently wrong from a stale cache" failure did not occur.
- **Where it's a wash — and we say so.** On questions agents can answer by reading code, quality is parity across hono (186 files), vuejs/core (483), and nestjs/nest (1676): 8.7–8.8 both arms, with Mason slightly *behind* on nest (8.5 vs 8.8). If your only questions are "how does X work", modern agents don't need a map.
- **Cost of ownership, measured.** Map builds scale linearly at ~$1.20 per 100 files (Sonnet): $3.22 for hono, $5.63 for vue-core, $19.52 for nest. Incremental refreshes after drift are cents.

## Decision records

Capture a lesson with `save_decision`: what happened, why it matters, and the files or directories it applies to. Add `owner`, `sources`, and `actor` when known. None are required to capture a proposal, and missing attribution stays explicit.

| Approval | How assistants should use it |
|---|---|
| `proposed` | A suggestion that needs review; the default for new records. |
| `accepted` | A recorded team constraint, still subject to freshness checks. |
| `unreviewed` | Legacy knowledge with no recorded acceptance. Check its source before treating it as adopted. |

Acceptance is separate from lifecycle: retired and superseded records remain in history but leave active retrieval. `get_context`, `get_snapshot`, hooks, and `mason-review` expose approval and provenance alongside freshness. A hook session also receives changes in approval and withdrawals of records it previously saw.

For example, an assistant can call `save_decision` with:

```json
{
  "dir": "/path/to/project",
  "title": "Delivery retries require an idempotency key",
  "body": "Unkeyed retries duplicated customer orders during incident 42. Retry only when the request carries an idempotency key.",
  "category": "gotcha",
  "files": ["src/delivery.ts"],
  "owner": "Delivery team",
  "sources": [{ "kind": "incident", "reference": "incidents/42" }]
}
```

Then ask your assistant to **review that decision**. `review_decision` with its `id` returns the full record, revision and review history, changes since its evidence baseline, local edits, and bounded source/diff previews. Source references are citations to inspect; Mason does not fetch or validate their contents. Supported source kinds are `pull_request`, `issue`, `incident`, `discussion`, `document`, and `other`.

After the user or cited team review authorizes a verdict, call `review_decision` again with `action: "accept"`, the actual `reviewer`, a `note` explaining the reason, and the returned `reviewToken`. Acceptance needs an owner, at least one source, readable Git HEAD, and no uncommitted changes to the anchors. Unrelated local work can remain. If the decision or code revision changed since preparation, prepare and inspect it again.

When anchored code changes later, use the same preparation flow and `action: "reaffirm"` to record that the accepted decision still holds, or `action: "retire"` to withdraw it. Retirement preserves history and can be recorded when Git history is unavailable. A reviewer may establish a new acceptance baseline when old history is unreachable; that gap stays recorded in the review event. Anchorless knowledge retains unknown code freshness even after acceptance.

Tools preserve earlier content and review events in each `.mason/decisions/<id>.json` file. Reviews record the reviewer, reason, timestamp, revision, and code baseline. Editing content, anchors, owner, or sources creates a new proposed revision. The last accepted revision remains the operative constraint while that draft is reviewed. Context, hooks, map indexes, and diff reviews show the accepted content and a separate `pendingProposal`, each with its own anchors, attribution, and freshness. CI findings continue to associate with the accepted revision's anchors. This is derived from existing version 2 history without rewriting stored records.

Preparing a review shows the draft and its `operativeDecision`, with evidence covering both sets of anchors. Accepting the draft replaces the operative revision; retiring the record withdraws the accepted constraint and its draft together. Saving identical content is a no-op: it does not silently reaffirm or refresh the decision. A proposal cannot supersede a record that has an operative accepted revision. When creating a replacement under a different id, review it and explicitly retire the original separately.

**Existing records:** Version 1 records remain readable and explicitly unreviewed, without automatic file rewrites or invented attribution. Their first revision or review upgrades them to version 2 with an import event marking the missing earlier history. Old clients that only understand version 1 must be upgraded before consuming new records. Use the tools to revise records; inconsistent content/history is reported as invalid.

Mason records assertions of review; it does not authenticate reviewer identity, verify approval in linked systems, or commit files. Review and commit these records through your normal PR process. The history is a review trail, not a tamper-proof approval service.

## MCP tools

| Tool | Purpose |
|---|---|
| `mason_init` | Read-only audit/review findings and quickstart guide; optional `base` for review, `evidence` for local CI manifests, `mode: "map"` for an architecture build. |
| `mason_repair` | Prepare an audit repair baseline; verify the same original findings after edits. Reports unresolved advisories and unavailable checks. |
| `mason_automation` | Inspect configured hooks and observed events, or capture/resume and verify retained repair evidence across sessions. |
| `mason_complete_init` | Records assistant instruction setup; preserves prior settings on repeated calls. |
| `generate_snapshot_batch` | Map step — returns one batch of files for the assistant to summarize. |
| `save_partial_snapshot` | Persists the partial map for one batch. |
| `reduce_snapshot` | Reduce step — returns every partial + instructions to merge into a unified map. |
| `save_snapshot` | Persist the final unified map. Clears partials. |
| `mason_set_confluence` | Configure Confluence credentials — two-step: list spaces, then persist. |
| `export_to_confluence` | Sync the concept map to Confluence as PM-readable wiki pages. |
| `get_snapshot` | Architecture navigation when a map is available. Loads the concept map — feature → file lookup — in one LLM-free call. |
| `get_context` | Decisions with approval, provenance, file impact, tests, and trust for a task; adds features/flows when a map exists. No setup required. |
| `save_decision` | Capture or revise proposals with rationale, anchors, owner, sources, and history. Prior accepted revisions remain operative while drafts are reviewed. |
| `review_decision` | Prepare draft and operative decision evidence, then record authorized acceptance, reaffirmation, or retirement against that revision. |
| `mason_check_drift` | Feature-level staleness report — what changed since the snapshot, and whether to refresh incrementally or rebuild. |
| `verify_snapshot` | Spot-check map correctness — sampled entries + file skeletons for the assistant to judge, least-recently-verified first. |
| `save_verification` | Record verification verdicts — failures flag entries for re-mapping until fixed. |
| `get_impact` | **Call before editing a file.** Traces what's affected — co-change history + references + related tests. |
| `analyze_project` | Git stats — hot files, stale dirs, commit conventions. |
| `full_analysis` | One-shot orientation for unmapped projects: structure + samples + tests + git. |
| `get_code_samples` | Smart file previews selected by architectural role. |

Tools operate on the data they need; none require the initialization marker. Decision capture and impact need no concept map. Map verification and drift require a map; Confluence export requires credentials and a map.

Setup installs a short marker-delimited section in the existing `AGENTS.md`, otherwise `CLAUDE.md` or `.claude/CLAUDE.md`; if none exists, it creates `AGENTS.md`. It routes assistants to decisions and impact, with map navigation when available.

### How the concept map is built

To stay accurate on codebases of any size, Mason uses a **Map-Reduce** pattern instead of stuffing the whole codebase into one LLM call:

- **Map**: `generate_snapshot_batch` returns ~50 files at a time (skeletons of every file in the batch plus a few deeper-read bodies for grounding). Your assistant produces a partial concept map for that batch and persists it with `save_partial_snapshot`. Repeat until every file in the project has been visited.
- **Reduce**: `reduce_snapshot` returns all the partials plus instructions to merge them into one product-shaped catalog — combining platform variants ("home Android" + "home iOS" → "home screen"), deduplicating, and ensuring no file is dropped.
- **Save**: `save_snapshot` persists the unified map and cleans up the partials.

The goal is complete source coverage. Drift checking reports eligible committed source files omitted from the snapshot, including omissions from a map saved at HEAD. A 200-file project takes ~5 batches; a 1000-file monorepo takes ~20.

## Change impact

Before editing a file, Mason tells you what else might be affected. Three signals you'd normally need a dozen tool calls to gather, in one call:

- **Co-change history** — files that historically change together in commits
- **References** — files that import or mention the target by name
- **Related tests** — test files paired by naming convention

Ask your assistant *"what would be affected if I changed WeatherRepository?"* and it'll call `get_impact` for you.

## Drift detection

A concept map that silently goes stale is worse than no map — your assistant confidently jumps to files that no longer do what the map says. `mason_check_drift` compares the map against HEAD (pure git + filesystem, no LLM call) and reports drift at the **feature level**: which features are stale and which files changed under them, new source files not yet mapped, ghost files the map still references, and renames. It ends with a recommendation — `up-to-date`, `incremental` (re-map just the stale entries), or `full-rebuild` (re-run the Map-Reduce playbook).

Ask your assistant *"is the concept map still fresh?"* — and if it isn't, the same report tells it exactly which entries to regenerate. `get_snapshot` includes the same drift report whenever it detects a stale map, so the assistant can inspect and refresh affected entries.

Incremental refreshes are safe against partial updates: every entry a refresh touches is stamped with the commit it was verified against, so entries skipped in one refresh keep reporting as stale instead of silently riding along on the map's new hash. Features that disappear from the codebase can be deleted from the map with `save_snapshot`'s `removeFeatures`/`removeFlows` — renames stop leaving zombie entries behind.

When a lot of files drifted at once, the assistant runs a **scoped refresh** instead of a full rebuild: `generate_snapshot_batch` accepts a `files` list, so the Map-Reduce loop walks only the drifted files and the reduce step merges the result into the existing map. 60 drifted files in a 1000-file monorepo means ~2 batches, not 20.

### Reading trust signals

`get_context` reports `map.status` as `available`, `missing`, or `invalid`. The legacy `exists` field indicates usable map availability only: `exists: false` can still include decisions, impact, and tests. Without a usable map, map freshness is `null`, and an invalid map produces diagnostics while valid decisions remain retrievable. An empty decision match is not a clean audit. Impact covers up to three unique targets, expanding directory anchors to eligible source files; use `get_impact` for a larger explicit file list.

Freshness and correctness are separate. `get_context` returns a `trust` object for each matched entry; `get_snapshot` includes a trust index for features, flows, and decisions.

| Field | Meaning |
|---|---|
| `freshness: current` | No changes detected in the inspected anchors. This does not prove the description is correct. |
| `freshness: changed` | Anchored files changed, including edits in the working tree. Inspect the current code. |
| `freshness: unknown` | Evidence is unavailable, such as missing history or an anchorless decision. Verify before relying on it. |
| `verification: unverified` | No correctness verdict has been recorded. |
| `verification: passed` | An assistant recorded a passing verdict; check its freshness and verification point before reuse. |
| `verification: failed` | A known incorrect entry. The failure and its reason remain visible until corrected. |

Git commit distance is informational: unrelated commits and committing the refreshed map do not make the map stale. `mason-drift` exit codes still describe **committed map drift**; working-tree changes, decision warnings, and verification results are reported separately. A clean drift exit is not a correctness approval.

Snapshot, decision, and partial stores are validated on load and replaced atomically on save. Invalid snapshots produce errors. Invalid decision records appear in diagnostics while valid records remain available; repair the invalid records before writing more decisions.

### Drift checks in CI

Because the check is deterministic, it also ships as a tiny standalone binary — read-only and LLM-free:

```bash
npx -p mason-context mason-drift --dir .          # exit 0 fresh · 1 stale · 2 error
npx -p mason-context mason-drift --json           # full report as JSON
npx -p mason-context mason-drift --refresh-prompt # stale? print refresh instructions for any agent
```

Run it on merges to main to catch a rotting map before your assistant does. Note: the diff is computed against the snapshot's base commit, so shallow CI checkouts need enough `fetch-depth` to reach it — when they don't, `mason-drift` reports stale with `full-rebuild` rather than guessing.

### The map maintains itself

Detection is free and deterministic; the fix needs an LLM — but not any particular one. `mason-drift --refresh-prompt` emits provider-neutral instructions that any coding agent with the Mason MCP server connected can execute. Pipe it to whichever headless CLI your team runs:

```bash
# Claude Code
claude -p "$(mason-drift --refresh-prompt)" --dangerously-skip-permissions \
  --mcp-config '{"mcpServers":{"mason":{"command":"npx","args":["-y","-p","mason-context","mason-mcp"]}}}'

# OpenAI Codex CLI (mason configured in ~/.codex/config.toml)
codex exec --full-auto "$(mason-drift --refresh-prompt)"

# Gemini CLI (mason configured in .gemini/settings.json)
gemini --yolo -p "$(mason-drift --refresh-prompt)"
```

To close the loop in CI, this repo ships a reusable GitHub Actions workflow — detect on every push, refresh with your agent of choice, verify that only the snapshot changed, commit it, check freshness again, and push the updated map:

```yaml
jobs:
  mason:
    uses: adrianczuczka/mason/.github/workflows/mason-refresh.yml@main
    with:
      agent-command: >-
        claude -p "$MASON_REFRESH_PROMPT" --dangerously-skip-permissions
        --strict-mcp-config --mcp-config
        '{"mcpServers":{"mason":{"command":"npx","args":["-y","-p","mason-context","mason-mcp"]}}}'
    secrets: inherit
```

Omit `agent-command` for detect-only mode: free, no credentials, fails the check when the map goes stale.

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
| `deps-changed` | dependency manifests committed after the doc's last commit | advisory |
| `decision-anchor-drift` | a decision record whose anchor files changed (only when `.mason/decisions/` exists) | advisory |

Issues drive the exit code; **advisories never do** — they're facts an agent can't close by editing the doc, so they're reported for humans instead. Every issue carries a `doc:line` anchor and git-derived evidence (the deleting commit, the rename target, the actual count and its source). A claim you want left alone — say, a deliberate reference to a removed directory — gets an ignore marker: `<!-- mason:ignore -->` on the line, or `<!-- mason:ignore-start -->` / `<!-- mason:ignore-end -->` around a block.

### The context files maintain themselves

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

## Automatic documentation checks (mason-auto)

Mason can preserve documentation audit evidence and resume unfinished repairs through Claude Code or Codex lifecycle hooks. A shared engine owns the evidence, verification, and cache; each host adapter handles its event format. No concept map or model call is required for the checks.

After installing a version that includes this feature:

```bash
npm install -D mason-context
npx mason-auto install --host claude   # Claude Code
npx mason-auto install --host codex    # Codex; review/trust the hooks using /hooks
npx mason-auto status
```

Install only the adapters you use. Installation merges the project's `.claude/settings.json` or `.codex/hooks.json`, preserves other hooks/settings, and records its own handler in `.mason/automation.json`. Repeating installation updates only those handlers. Add `.mason/reports/` to your ignore rules. Start a new assistant session after installation. The default handler uses the locally installed package with `npx --no-install`; `--command` accepts an executable prefix for an existing installation.

`status` distinguishes configuration from observed events. Host versions, project trust, policy, and specialized tool paths can prevent hooks from running. Configuration alone is not evidence of automatic use. Codex requires review/trust of new or changed non-managed hooks. See the [Claude Code hook reference](https://code.claude.com/docs/en/hooks) and [Codex hook reference](https://learn.chatgpt.com/docs/hooks).

On session start, Mason recovers the current branch/worktree's evidence. Before and after tools, it checks for changed audit inputs and retains newly observed findings before another documentation edit can hide them. Shell and unknown tool calls are included because edits can happen outside a file-edit tool. At turn completion it verifies the retained findings. A relevant unresolved issue can request **one continuation per session**; advisories and unavailable checks never create a repair loop. Fixes remain the assistant's responsibility within the user's task scope.

Checks reuse cached results only when their dependencies match. Documentation and history, file inventory, manifests, and decision evidence have separate invalidation keys. Changes to a dirty manifest invalidate its checks even when Git's status text is unchanged. Skipped checks are retried. Cache corruption causes recomputation; invalid original baselines or active state remain errors. Concurrent events serialize writes, and interrupted local writers' locks are recovered only when their process is gone. New reports are written atomically. Unchanged tool events reuse the existing full report.

```bash
npx mason-auto check --json   # Capture/resume the active evidence and verify it
# After any final documentation commit:
npx mason-auto check
```

The equivalent MCP operation is `mason_automation(action: "check")`. Its response is concise and links the full local report. `status` is read-only; `check` writes evidence. Exit codes are 0 for verified checks, 1 for unresolved issues, and 2 for incomplete/unavailable checks. Original `mason_repair` baselines remain separately verifiable by their paths. Hook errors are visible and advisory; the existing `mason-hook` decision injector keeps its previous behavior.

Evidence is local to the worktree and branch. Switching assistants in that worktree resumes the same repair; another worktree or branch has separate state. Detached-HEAD commits retain evidence; moving that checkout to a different history requires inspection. Hooks follow the Git worktree of the event's working directory. Reports are not automatically transferred to CI. CI can call `mason-auto check` on retained local artifacts, or `mason-audit --verify-repair <baseline>` after restoring the original artifacts at their recorded root. A fresh checkout cannot reconstruct missing pre-edit evidence. Audited instruction files remain limited to `AGENTS.md`, `CLAUDE.md`, and `.claude/CLAUDE.md`. Automation bounds inventory at 100,000 paths and retained baselines at 128; exceeding a bound reports unavailable evidence without evicting unresolved findings. Symbolic links in the inspected inventory require an explicit audit instead of cached automation. This is not proof of arbitrary repository scale or universal tool interception.

The [automation evaluation](bench/harness/automation/README.md) compares ordinary module-renaming requests and unrelated edits across hosts, with baseline, instructions, and hooks arms. Deterministic replay verifies the mechanism; live sessions measure actual activation.

## Decision injection (mason-hook)

Recorded knowledge only helps if it shows up. Retrieval tools depend on the model deciding to call them — and it often doesn't. `mason-hook` removes the gamble: it's a Claude Code `PostToolUse` hook that fires when a session reads or edits a file, looks up the decision records anchored to that file (exact path or directory prefix), and injects them into the model's context. Deterministic lookup, no LLM call, ~100ms, silent when nothing matches. Each decision is injected at most once per session, and records whose anchors drifted since verification carry a verify-before-relying marker.

```bash
npx -p mason-context mason-hook --print-config   # the settings block to add
```

Add the printed block to `.claude/settings.json` — the *committed* project settings, so every teammate's sessions get the same rail. The loop this closes: someone captures a proposal with `save_decision` and records acceptance with `review_decision` ("this screen has a v1 and v2 — new work goes in v2 behind flag X"), and from then on any session that touches those files gets told, whether or not it thought to ask.

For faster fires than `npx` resolution allows, install the package (`npm i -D mason-context`) and point the command at `node_modules/.bin/mason-hook`.

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

Mason's own checkout produces real test artifacts with `npm run test:evidence`, using [scripts/test-evidence.mjs](scripts/test-evidence.mjs). It records the observed exit code and checkout state and invalidates previous evidence before starting a fresh run. After `npm run build`, inspect them with `node dist/mason-review.js --base HEAD --evidence .mason/reports/evidence.json`. A local run with uncommitted edits correctly has unknown commit attribution. The repository CI uses this producer and posts the combined review to its job summary. Add `.mason/reports/` to your ignore file when using that output directory; keep the decisions and map tracked.

## Confluence sync

Keep a Confluence wiki in sync with the concept map, in plain product language that PMs and designers can read. Each sync rewrites the snapshot through your assistant into PM-friendly descriptions, pushes one page per feature, and posts a "what changed since last sync" entry to a changelog page. Mason owns these pages and overwrites each one on every sync, so edit the code, not the page — manual edits to a page body are replaced. Re-running a sync with no code change is a no-op: it makes no Confluence edits at all.

Configure this separately by asking your assistant *"set up Confluence for this project."* The assistant walks you through the Atlassian site URL, your account email, and an API token from id.atlassian.com, then lets you pick which space to use. To sync, ask *"sync the wiki to Confluence."*

> ⚠️ **Token in chat history.** The API token is pasted into your assistant chat, not a terminal. It will appear in your chat history. If that's not acceptable, skip Confluence sync.

## Other clients

Mason's MCP server is client-agnostic. Pick yours:

<details>
<summary><strong>Cursor</strong></summary>

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in your project):

```json
{
  "mcpServers": {
    "mason": {
      "command": "npx",
      "args": ["-p", "mason-context", "mason-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Windsurf</strong></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mason": {
      "command": "npx",
      "args": ["-p", "mason-context", "mason-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>OpenAI Codex CLI</strong></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.mason]
command = "npx"
args = ["-p", "mason-context", "mason-mcp"]
```
</details>

<details>
<summary><strong>VS Code</strong></summary>

Add to your VS Code settings (`settings.json`):

```json
{
  "mcp": {
    "servers": {
      "mason": {
        "command": "npx",
        "args": ["-p", "mason-context", "mason-mcp"]
      }
    }
  }
}
```
</details>

## Language support

Language-agnostic. Mason works from file naming patterns and git history rather than language-specific parsing, so it runs on any project with a git repo — TypeScript, Kotlin, Python, Go, Rust, Swift, Java, C#, Dart, and more.

## Security

- **The snapshot stores:** assistant-authored feature names, relative file paths, descriptions, and verification metadata. Review that prose before committing it; do not record secrets.
- **Shared file policy:** mapping, sampling, verification, impact analysis, and test discovery respect Git ignores and `.mason/config.json` exclusions. Sensitive filenames are denied, and source reads are limited to 1 MiB.
- **Path protection:** source reads check canonical paths and reject symlinks escaping the project root. Metadata paths reject symlinks, including parent directories.
- **Mapping is local:** source previews go to the connected assistant through MCP. Mason itself makes no model API calls for mapping. Optional Confluence sync uses network access and can call a configured model provider.

## 0.4.0 migration

If you used Mason before v0.4.0, the standalone `mason <command>` CLI has been removed. Everything now runs through MCP tools, called by your assistant.

| Old CLI | New flow |
|---|---|
| `mason set-llm <provider>` | Not needed — your assistant *is* the LLM. |
| `mason snapshot` | Ask your assistant: *"build a Mason concept map"* → `mason_init` with `mode: "map"` → the Map-Reduce workflow. |
| `mason generate` (CLAUDE.md) | Removed. Use your assistant directly. |
| `mason analyze` | Ask your assistant: *"give me git stats for this repo"* — it calls `analyze_project`. |
| `mason impact File.kt` | Ask your assistant: *"what would changing File.kt affect?"* — it calls `get_impact`. |
| `mason snapshot --install-hook` | Removed. The map auto-refreshes when the assistant detects stale state. |

The package provides `mason-mcp`, `mason-drift`, `mason-audit`, `mason-auto`, `mason-hook`, and `mason-review`. Running `mason` directly prints a migration message and exits.

## License

MIT
