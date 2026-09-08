# Project knowledge and tool reference

[← Mason](../README.md)

- [Give the next task the context it needs](#give-the-next-task-the-context-it-needs)
- [Decision records](#decision-records)
- [MCP tools](#mcp-tools)
- [Change impact](#change-impact)
- [Drift detection](#drift-detection)
- [Confluence sync](#confluence-sync)
- [Language support](#language-support)
- [Security](#security)

## Give the next task the context it needs

Mason connects to your assistant through MCP. A task's `get_context` call retrieves matching decisions, their rationale and review status, relevant files and tests, and freshness evidence. `get_impact` adds references and historical change partners before an edit.

Record the reason behind a constraint when you learn it: an incident, a failed approach, a workaround, or a convention settled in review. A later session can retrieve that reason when it touches the same area. Proposals, accepted decisions, and retired knowledge remain distinct as the project evolves.

Once configured and trusted, Claude Code and Codex hooks preserve documentation audit evidence during work and verify it at task completion. Status reports which events and context requests were actually observed. Other MCP clients can use the context and review tools through their own instruction workflows.

Audit, review, decision capture, and task context work without a concept map. Add a map when feature and flow navigation would help. See the [setup guide](setup.md#unified-project-setup) for installation and the [roadmap](../ROADMAP.md) for the broader context-engineering direction.

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
| `mason_init` | Read-only audit/review findings by default; optional `base`, CI `evidence`, and `mode: "map"`. `mode: "setup", host: "codex"` (or `"claude"`) configures MCP, instructions, and hooks using `mason` on PATH using the shared setup engine. |
| `mason_repair` | Prepare an audit repair baseline; verify the same original findings after edits. Reports unresolved advisories and unavailable checks. |
| `mason_automation` | Inspect configured hooks and observed events, or capture/resume and verify retained repair evidence across sessions. |
| `mason_complete_init` | Records assistant instruction setup in ignored local state, with feature settings in shared configuration; preserves prior settings on repeated calls. |
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

Setup adds host-appropriate project instructions that route assistants to decisions and impact, with map navigation when available. The [setup guide](setup.md#unified-project-setup) explains instruction files, native imports, and observed activation.

### How the concept map is built

An optional concept map connects feature names and flows to their implementing files:

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

Your assistant creates the map from source evidence surfaced by Mason. Mason stores it, checks for drift, and provides file previews for correctness spot-checks. Inspect source when the available context leaves questions unanswered.

Map builds use a **Map-Reduce** workflow with bounded source batches:

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

## Confluence sync

Keep a Confluence wiki in sync with the concept map, in plain product language that PMs and designers can read. Each sync rewrites the snapshot through your assistant into PM-friendly descriptions, pushes one page per feature, and posts a "what changed since last sync" entry to a changelog page. Mason owns these pages and overwrites each one on every sync, so edit the code, not the page — manual edits to a page body are replaced. Re-running a sync with no code change is a no-op: it makes no Confluence edits at all.

Configure this separately by asking your assistant *"set up Confluence for this project."* The assistant walks you through the Atlassian site URL, your account email, and an API token from id.atlassian.com, then lets you pick which space to use. To sync, ask *"sync the wiki to Confluence."*

> ⚠️ **Token in chat history.** The API token is pasted into your assistant chat, not a terminal. It will appear in your chat history. If that's not acceptable, skip Confluence sync.

## Language support

Language-agnostic. Mason works from file naming patterns and git history rather than language-specific parsing, so it runs on any project with a git repo — TypeScript, Kotlin, Python, Go, Rust, Swift, Java, C#, Dart, and more.

## Security

- **The snapshot stores:** assistant-authored feature names, relative file paths, descriptions, and verification metadata. Review that prose before committing it; do not record secrets.
- **Shared file policy:** mapping, sampling, verification, impact analysis, and test discovery respect Git ignores and `.mason/config.json` exclusions. Sensitive filenames are denied, and source reads are limited to 1 MiB.
- **Path protection:** source reads check canonical paths and reject symlinks escaping the project root. Metadata paths reject symlinks, including parent directories.
- **Mapping is local:** source previews go to the connected assistant through MCP. Mason itself makes no model API calls for mapping. Optional Confluence sync uses network access and can call a configured model provider.
