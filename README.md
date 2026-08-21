# Mason – the system of record for your codebase's AI assistants 👷

[![npm version](https://img.shields.io/npm/v/mason-context)](https://www.npmjs.com/package/mason-context)
[![CI](https://img.shields.io/github/actions/workflow/status/adrianczuczka/mason/ci.yml?branch=main)](https://github.com/adrianczuczka/mason/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/mason-context)](https://www.npmjs.com/package/mason-context)
[![license](https://img.shields.io/github/license/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/blob/main/LICENSE)
[![issues](https://img.shields.io/github/issues/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/issues)

### Persistent, provably-fresh context your assistant can't grep for: team decisions, change history, and a feature-to-file map — assembled per task in one call.

**Modern agents are good at reading code. They're terrible at knowing what your team learned the hard way, what changes together, and whether yesterday's understanding still holds. Mason owns exactly that.**

```bash
claude mcp add mason --scope user -- npx -p mason-context mason-mcp
```

Restart Claude Code, then ask: *"use mason to set up this project."* The assistant calls `mason_init`, walks you through a quick Q&A to build the concept map, and you're done.

Next session, your assistant loads the map instead of grepping 8 files to figure out what your app does.

> **0.6.0 note:** Mason 0.6 adds decision records (`save_decision`), task-scoped assembly (`get_context`), map verification (`verify_snapshot`), the self-maintaining refresh loop, and richer uninitialized responses. If you set Mason up before 0.6, re-run setup once (ask your assistant to "run mason_init again") — it refreshes the marker-delimited CLAUDE.md section that routes assistants to the new tools.

> **0.4.0 note:** Mason is MCP-only as of v0.4.0. The previous `mason <command>` CLI has been removed — everything runs through MCP tools, driven by your assistant. See [0.4.0 migration](#040-migration) below if you used the old CLI.

---

## The pain

Agentic search keeps getting better at re-deriving what's *in* the code — but three kinds of context can't be re-derived, and today they evaporate:

- **Decisions.** "We tried retrying 401s in 2023; it locked accounts." Your assistant re-suggests it next sprint, in every teammate's session.
- **History.** Which files change together, which dirs are dead — knowledge that lives in thousands of commits, too expensive to mine per session.
- **Freshness.** Any cached understanding — a wiki, a CLAUDE.md, a map — rots silently, and a confidently wrong assistant is worse than a slow one.

## The fix

Mason is an MCP server that maintains three git-committed, deterministic stores and assembles them per task:

- **Concept map** (`.mason/snapshot.json`) — features and flows → files, built by your assistant, spot-checked by `verify_snapshot`
- **Decision records** (`.mason/decisions/`) — team knowledge the code can't express, captured by `save_decision`, PR-reviewed like code
- **Drift engine** — LLM-free proof of what's stale, per entry, with a self-maintaining refresh loop for CI

Ask your assistant to do a task and one `get_context` call returns the relevant features, files, tests, blast radius (git co-change + references), matching decisions, and a freshness verdict. The map itself:

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

**Where the map comes from:** Mason doesn't parse your code. Your assistant reads the project through Mason's analysis tools and writes the map itself — capturing architectural intent, not just symbols and call edges. Setup also adds a short section to your CLAUDE.md so every future session (any assistant, any teammate) consults the stores before exploring.

## What the numbers say

Measured with real headless agent sessions in A/B arms (baseline always has a populated CLAUDE.md — beating a context-free agent is not a result). Full harness, pinned commits, and losses included: [bench/harness/](bench/harness/).

- **Where Mason wins — knowledge that isn't in the code.** On tasks whose correct answer hinges on a recorded engineering decision (seeded fairly: the baseline had the same facts in a discoverable doc), Mason averaged **9.0/10 vs 7.0/10**. The baseline missed the constraint entirely half the time, and needed ~3× the turns when it found it; Mason surfaced it in one `get_context` call, every time.
- **Stale-map safety.** Against a deliberately stale map, the drift flag + changed-file previews led the agent to verify and answer current-code truth — the "confidently wrong from a stale cache" failure did not occur.
- **Where it's a wash — and we say so.** On questions agents can answer by reading code, quality is parity across hono (186 files), vuejs/core (483), and nestjs/nest (1676): 8.7–8.8 both arms, with Mason slightly *behind* on nest (8.5 vs 8.8). If your only questions are "how does X work", modern agents don't need a map.
- **Cost of ownership, measured.** Map builds scale linearly at ~$1.20 per 100 files (Sonnet): $3.22 for hono, $5.63 for vue-core, $19.52 for nest. Incremental refreshes after drift are cents.

## Decision records

The store that makes Mason more than a map. When your assistant learns something the code can't express — a failed approach, a deprecation, a workaround's reason, a review-settled convention — it records it with `save_decision`:

- One JSON file per record in `.mason/decisions/` — concurrent additions merge cleanly; conflicting edits to the same record surface to a human, which is the point
- Git-committed and PR-reviewed: nothing enters team knowledge without the normal review gate
- Anchored to files and drift-checked: when the anchor files change, the record is flagged for re-verification instead of silently going stale
- Surfaced by `get_context` as constraints exactly when a task touches them — for every teammate, in every session, on any assistant

## MCP tools

| Tool | Purpose |
|---|---|
| `mason_init` | **Start here.** Returns the Map-Reduce setup playbook. Idempotent. |
| `mason_complete_init` | Marks the project as initialized once the playbook is done. |
| `generate_snapshot_batch` | Map step — returns one batch of files for the assistant to summarize. |
| `save_partial_snapshot` | Persists the partial map for one batch. |
| `reduce_snapshot` | Reduce step — returns every partial + instructions to merge into a unified map. |
| `save_snapshot` | Persist the final unified map. Clears partials. |
| `mason_set_confluence` | Configure Confluence credentials — two-step: list spaces, then persist. |
| `export_to_confluence` | Sync the concept map to Confluence as PM-readable wiki pages. |
| `get_snapshot` | **First call for any architecture question.** Loads the concept map — feature → file lookup — in one LLM-free call. |
| `get_context` | **First call for any task or bug.** Matching features + files + tests + blast radius + freshness + recorded decisions, in one call. |
| `save_decision` | Record knowledge the code can't express — failed approaches, deprecations, conventions. Git-committed, PR-reviewed, drift-checked. |
| `mason_check_drift` | Feature-level staleness report — what changed since the snapshot, and whether to refresh incrementally or rebuild. |
| `verify_snapshot` | Spot-check map correctness — sampled entries + file skeletons for the assistant to judge, least-recently-verified first. |
| `save_verification` | Record verification verdicts — failures flag entries for re-mapping until fixed. |
| `get_impact` | **Call before editing a file.** Traces what's affected — co-change history + references + related tests. |
| `analyze_project` | Git stats — hot files, stale dirs, commit conventions. |
| `full_analysis` | One-shot orientation for unmapped projects: structure + samples + tests + git. |
| `get_code_samples` | Smart file previews selected by architectural role. |

The init / write tools refuse to run until `mason_init` has completed. The read-only diagnostics (`analyze_project`, `full_analysis`, `get_code_samples`) work without init.

Setup also offers to add a short marker-delimited section to your project's CLAUDE.md telling assistants to consult the map before exploring — assistants follow project instructions far more reliably than they discover MCP tools on their own.

### How the concept map is built

To stay accurate on codebases of any size, Mason uses a **Map-Reduce** pattern instead of stuffing the whole codebase into one LLM call:

- **Map**: `generate_snapshot_batch` returns ~50 files at a time (skeletons of every file in the batch plus a few deeper-read bodies for grounding). Your assistant produces a partial concept map for that batch and persists it with `save_partial_snapshot`. Repeat until every file in the project has been visited.
- **Reduce**: `reduce_snapshot` returns all the partials plus instructions to merge them into one product-shaped catalog — combining platform variants ("home Android" + "home iOS" → "home screen"), deduplicating, and ensuring no file is dropped.
- **Save**: `save_snapshot` persists the unified map and cleans up the partials.

The result: every source file is represented exactly once in the final snapshot. A 200-file project takes ~5 batches; a 1000-file monorepo takes ~20.

## Change impact

Before editing a file, Mason tells you what else might be affected. Three signals you'd normally need a dozen tool calls to gather, in one call:

- **Co-change history** — files that historically change together in commits
- **References** — files that import or mention the target by name
- **Related tests** — test files paired by naming convention

Ask your assistant *"what would be affected if I changed WeatherRepository?"* and it'll call `get_impact` for you.

## Drift detection

A concept map that silently goes stale is worse than no map — your assistant confidently jumps to files that no longer do what the map says. `mason_check_drift` compares the map against HEAD (pure git + filesystem, no LLM call) and reports drift at the **feature level**: which features are stale and which files changed under them, new source files not yet mapped, ghost files the map still references, and renames. It ends with a recommendation — `up-to-date`, `incremental` (re-map just the stale entries), or `full-rebuild` (re-run the Map-Reduce playbook).

Ask your assistant *"is the concept map still fresh?"* — and if it isn't, the same report tells it exactly which entries to regenerate. `get_snapshot` includes the same drift report whenever it detects a stale map, so a stale map self-heals in the course of normal use.

Incremental refreshes are safe against partial updates: every entry a refresh touches is stamped with the commit it was verified against, so entries skipped in one refresh keep reporting as stale instead of silently riding along on the map's new hash. Features that disappear from the codebase can be deleted from the map with `save_snapshot`'s `removeFeatures`/`removeFlows` — renames stop leaving zombie entries behind.

When a lot of files drifted at once, the assistant runs a **scoped refresh** instead of a full rebuild: `generate_snapshot_batch` accepts a `files` list, so the Map-Reduce loop walks only the drifted files and the reduce step merges the result into the existing map. 60 drifted files in a 1000-file monorepo means ~2 batches, not 20.

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

To close the loop in CI, this repo ships a reusable GitHub Actions workflow — detect on every push, refresh with your agent of choice, commit the updated map back:

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

Same split as the concept map: detection is deterministic and free, the fix is any agent you already run. `--fix-prompt` emits a work order scoped to exactly the flagged claims — fix only these, minimal diffs, never invent content, never touch source code. The reusable workflow runs the audit, hands the work order to your agent, verifies the audit is clean afterwards (and that the agent touched nothing but the context files), then opens a PR citing the evidence — it never commits to the audited branch, and it skips cleanly when an audit PR is already open:

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

## Confluence sync

Keep a Confluence wiki in sync with the concept map, in plain product language that PMs and designers can read. Each sync rewrites the snapshot through your assistant into PM-friendly descriptions, pushes one page per feature, and posts a "what changed since last sync" entry to a changelog page. Mason owns these pages and overwrites each one on every sync, so edit the code, not the page — manual edits to a page body are replaced. Re-running a sync with no code change is a no-op: it makes no Confluence edits at all.

Setup happens during `mason_init` (you'll be asked) or any time later by asking your assistant *"set up Confluence for this project."* The assistant walks you through the Atlassian site URL, your account email, and an API token from id.atlassian.com, then lets you pick which space to use. To sync, ask *"sync the wiki to Confluence."*

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

- **The snapshot contains:** feature names, relative file paths, flow descriptions. No source code, no secrets, no business logic.
- **Respects `.gitignore`** via `git ls-files`. A deny-list blocks `.env`, `.pem`, `.key`, credentials, and other sensitive files from being sampled.
- **Path traversal protection** keeps all file access inside the project root.
- **MCP tools are local-only.** Generating a snapshot via MCP uses your assistant's existing LLM context — Mason itself makes no API calls.

## 0.4.0 migration

If you used Mason before v0.4.0, the standalone `mason <command>` CLI has been removed. Everything now runs through MCP tools, called by your assistant.

| Old CLI | New flow |
|---|---|
| `mason set-llm <provider>` | Not needed — your assistant *is* the LLM. |
| `mason snapshot` | Ask your assistant: *"set up Mason here"* → it calls `mason_init` → `generate_snapshot` → `save_snapshot`. |
| `mason generate` (CLAUDE.md) | Removed. Use your assistant directly. |
| `mason analyze` | Ask your assistant: *"give me git stats for this repo"* — it calls `analyze_project`. |
| `mason impact File.kt` | Ask your assistant: *"what would changing File.kt affect?"* — it calls `get_impact`. |
| `mason snapshot --install-hook` | Removed. The map auto-refreshes when the assistant detects stale state. |

The npm package is still published, but only the `mason-mcp` binary is meaningful now. Running `mason` directly prints a migration message and exits.

## License

MIT
