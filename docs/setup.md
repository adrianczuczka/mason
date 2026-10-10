# Setup and integrations

[← Mason](../README.md)

Install the [standalone CLI](distribution.md) to use Mason without system Node or npm. npm installation remains supported below.

- [Unified project setup](#unified-project-setup)
- [Disconnect a project](#disconnect-a-project)
- [Automatic documentation checks (mason)](#automatic-documentation-checks-mason)
- [Decision injection (mason-hook)](#decision-injection-mason-hook)
- [Other clients](#other-clients)
- [Upgrading from earlier versions](#upgrading-from-earlier-versions)
- [0.4.0 migration](#040-migration)

## Unified project setup

Run setup from the target Git repository, choosing the assistant you use:

```bash
mason setup --host codex
# Use --host claude for Claude Code; add --dir /absolute/path/to/project to target another repository.
mason status
```

With npm instead (requires Node 20.17+ and npm):

```bash
npm install -g mason-context
mason setup --host codex
mason status
```

Run setup once for each host in a fresh clone or primary checkout. Linked Git worktrees inherit that checkout’s local host activation unless they have their own setup record; separate clones still need setup. Mason must be installed on PATH before setup; a temporary `npx` invocation alone does not install a persistent command. For a local source build, run `npm run build` and `npm link` in Mason's checkout, then use `mason setup --dir /absolute/path/to/project --host codex`.

**For teams:** committing Mason's configuration does not activate hooks for everyone. Each developer installs Mason and runs `mason setup --host claude` or `--host codex` in their own checkout, then completes the host activation steps below. Until local setup, the shared automatic hooks stay silent. Once configured, normal upgrades require restarting the assistant; rerun setup when release notes require a configuration update or when repairing configuration.

Setup retains the initial audit before editing instruction files and configures MCP and lifecycle hooks to call the installed `mason` command. It creates no project launch scripts, runtime copy, or npm dependencies. Git is required. Standalone installations include Node in the user installation; npm installations use system Node. Neither hooks nor MCP download packages when they run.

The setup CLI shows progress while checking configuration, retaining the original audit, reviewing context, and configuring the selected assistant. Interactive terminals show a spinner and elapsed time; redirected output uses plain stderr lines. `mason setup --json` and MCP setup keep their structured output without human progress. A completed setup still needs the activation steps below.

Existing project guidance is preserved outside marked Mason blocks. Codex receives an `AGENTS.md` entry point; Claude Code receives or reuses a `CLAUDE.md` entry point, using a native `@AGENTS.md` import when that is the shared document (or `@../AGENTS.md` from `.claude/CLAUDE.md`). See [Claude Code memory imports](https://code.claude.com/docs/en/memory#agentsmd). Setup merges the named Mason MCP server and its recorded hooks while retaining unrelated settings and explicit disable options. It refuses malformed or ambiguous configuration and concurrent edits. Repeating setup resumes interrupted configuration without replacing the retained original audit.

Commit assistant instructions, `.gitignore`, the selected host's configuration (`.codex/config.toml` and `.codex/hooks.json`, or `.mcp.json` and `.claude/settings.json`), and any shared `.mason/config.json`, decisions, or optional snapshot. Setup receipts and hook ownership live in ignored `.mason/local/`; repair evidence and observed activation remain in ignored `.mason/reports/`. Setup does not create a top-level `.mason/project.json` marker. Explicit `mason_complete_init` records its timestamp locally and saves the Confluence feature flag in shared configuration.

A fresh clone with Mason installed and its MCP configuration trusted can connect and retrieve context before local setup. MCP instructions and `get_context` explain how to run setup; automatic hooks remain inactive and no local setup or activation is created by connecting. A linked worktree can inherit activation through Git’s common directory; its audit baselines, observations, and reports still belong to that worktree and branch. A local setup record takes precedence, including a record left by teardown to keep the worktree disconnected. All projects use the installed Mason version on their next launch. After upgrading, restart running assistants; setup is needed again only to change or repair project configuration. This layout replaces the earlier generated launchers and per-project runtime pins; there is no automatic migration from those setups. Remove the earlier Mason host entries and generated setup files before setting up again, preserving decisions and repair evidence.

The generated Git ignore block excludes `.mason/` contents by default and allows shared `decisions/`, `reviews/`, `config.json`, and `snapshot.json`. Unexpected scratch or cache files stay ignored. Already tracked files retain Git's normal tracking behavior. Repeating setup with unchanged templates leaves committed configuration unchanged; upgrading the executable alone does not rewrite it. Claude MCP entries explicitly use `type: "stdio"`.

Setup checks that its process can find a compatible `mason` on PATH. A desktop assistant may have a different environment: restart it after installation, then check MCP and hook activation. If it still cannot find Mason, check the PATH inherited by that application. Terminal discovery alone does not prove desktop activation.

Finish activation in the host:

1. Review the project's MCP and hook configuration through the host's native trust controls. Codex provides `/hooks` in its CLI; Claude Code requires approval for project MCP servers. Setup never changes trust on your behalf. See the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks) and [Claude Code project MCP documentation](https://code.claude.com/docs/en/mcp).
2. Start a new assistant session in that project and give it a normal task. The project instructions direct the assistant to request Mason context; hooks preserve and verify audit evidence during work.
3. Run `mason status` using the same installed build. Interactive output shows runtime/configuration health, observed events, task context requests, and verification. Use `--json` for structured output; piped status remains JSON.

`pending` means setup needs evidence of use. `active` requires a `get_context` call through the configured MCP server and all five lifecycle events in one session for the current Mason version, setup revision and worktree/branch. `attention` identifies missing PATH command, changed configuration, disabled settings, or a failed verification attempt. Verification remains a separate result: observed activation does not prove a repair was correct or that Mason improved the task. Local receipts store counts, event names, and hashed session identifiers, not prompts or tool arguments. Higher-priority host settings can still prevent execution.

Status labels recognized older hook commands `compatible` and offers a template update separately. Disabled hooks, narrowed event matchers, and commands for another operating system still require attention. Status never rewrites configuration.

For an assistant already connected to this build, `mason_init` with `mode: "setup"` and `host: "codex"` or `"claude"` invokes the same engine. Its default quickstart remains read-only. Setup does not build a concept map, approve advisories, or create decision records; decisions should capture actual lessons from subsequent work.

## Disconnect a project

Available from **0.16.0**:

```bash
mason teardown --dry-run       # Preview without changing files
mason teardown --host codex    # Disconnect one assistant
mason teardown                 # Disconnect all project assistants
```

Run from the Git repository or a subdirectory, or pass `--dir /path/to/project`. Teardown removes identifiable Mason MCP entries, lifecycle hooks, and local setup records. Shared Mason instruction blocks stay while another configured host needs them. After the last host is disconnected, unchanged Mason blocks are removed too. Restart running assistants to unload their existing sessions, then review and commit the configuration changes normally.

User settings, unrelated hooks and instruction text are preserved. Setup records file ownership in ignored `.mason/local/integration.json` before changing shared files, so teardown can remove files Mason created when no user content remains. With missing receipts, only recognizable entries and blocks are removed; empty files remain because their creation cannot be attributed to Mason. Edited or ambiguous entries are retained with diagnostics. Fix or remove those entries manually and rerun teardown to finish. Repeating a completed teardown is harmless.

Decisions, shared configuration, optional maps, repair baselines and reports remain, along with their Git ignore rules. Teardown removes setup receipts across this checkout’s local branch records and keeps a local opt-out record in linked worktrees. It preserves verification history. Disconnecting the primary checkout also stops inherited activation in worktrees without their own setup; independently configured worktrees remain connected. It never uninstalls Mason or changes global host settings. There is no purge option.

Use `--json` for a structured list of planned or applied `changes` and retained-entry `diagnostics`. Exit code **0** means cleanup is complete or there was nothing to remove; **2** means cleanup needs attention, including in a dry run. `--dry-run` creates no files or locks.

To reconnect, run `mason setup --host codex` or `--host claude`. To remove the standalone application as well, run `mason uninstall` after tearing down the projects you want to disconnect. For an npm installation, use `npm uninstall -g mason-context` instead.

## Local usefulness tracking

`mason setup` enables local stats automatically and explains where they are stored. An explicit `mason stats --disable` choice survives repeated setup and adding another host. Running `mason stats` only reads observations; it does not enable collection. For an existing checkout, rerun setup or use `--enable`.

```sh
mason stats
mason stats --json
mason stats --session <session-id>
mason stats --disable
```

Tracking uses installed lifecycle hooks. `mason stats` shows aggregate counts for retained sessions in the current branch; `--session <id>` shows one session and its findings. `--json` includes the aggregate summary and session details. Counts are summed per session, so the same finding or record can appear in more than one session. Retrieval coverage distinguishes sessions with observed responses from unknown activity. The summary shows distinct findings emitted to the agent or completion channel, their latest observed check status, supplied feedback, decision records returned by observed `get_context` calls, and time spent in successful automation observations. Existing quiet backlog and undisplayed notification overflow do not count as delivered findings. Missing evidence is unknown, not resolved; review-required advisories remain open. Summaries are available on demand and do not add another automatic completion notice.

Add an optional rating using the session and finding IDs from `--json`; the session's `reportPath` links the IDs to audit evidence:

```sh
mason stats --session <session-id> --finding <finding-id> --rating helpful
# Other ratings: already-knew, irrelevant, deferred
```

Ratings are supplied feedback, not authenticated human judgments. A deferred rating does not close an audit finding. A repair after a notice is an observation, not proof that Mason caused it. Retrieval counts require a successful `mcp__mason__get_context` response exposed by the host's PostToolUse hook. Other tool names, missing receipts, and unsupported response shapes are not inferred from calls. Returned records do not establish that a lesson was applied or reused in a later session. Model-token cost is not available from these hooks. Timing includes audit orchestration and cache reuse, but excludes optional tracking writes, read-only tool observations, and failed checks.

Data stays under `.mason/local/usefulness/`, with its own Git ignore rule. It contains hashed session and decision IDs, finding IDs/types/statuses, channels, ratings, timestamps, counts, timing, and report paths—not prompts, tool arguments, decision bodies, or source contents. Nothing is uploaded. Each branch/worktree retains up to 50 sessions and each session up to 200 findings and 200 returned decision IDs; truncated sessions are marked. Disabling stops collection and retains observations. To erase them, disable tracking and remove `.mason/local/usefulness/` while no Mason process is writing. Removing that directory also clears the preference, so a later setup enables stats again. Historical summaries describe the last observed check, not a fresh verification.

Tracking errors do not suppress audits, existing findings, or setup. Setup reports unavailable stats and preserves unreadable preferences. `mason stats --disable` can reset a malformed preference even when observation files are unreadable; it retains those files. Delayed delivery records use newer retained audit evidence, or report an unknown outcome if that evidence is unavailable. At task end, unavailable tracking produces a short diagnostic; `mason stats --json` reports invalid storage explicitly.

## Automatic documentation checks (mason)

Mason can preserve documentation audit evidence and resume unfinished repairs through Claude Code or Codex lifecycle hooks. A shared engine owns the evidence, verification, and cache; each host adapter handles its event format. No concept map or model call is required for the checks.

Unified setup already installs these hooks. For manual npm hook installation (available from 0.12.0), install or upgrade the package in each project:

```bash
npm install -D mason-context@0.16.2
mason auto install --host claude   # Claude Code
mason auto install --host codex    # Codex; review/trust the hooks using /hooks
mason status
```

Install only the adapters you use. Installation merges the project's `.claude/settings.json` or `.codex/hooks.json`, preserves other hooks/settings, and records its own handler in ignored `.mason/local/automation.json`. Repeating installation updates only those handlers. Commit the host configuration. Installation adds ignore rules for `.mason/local/` and `.mason/reports/`; shared configuration and decision records remain available to Git. Start a new assistant session after installation. The default handler uses the locally installed package with `npx --no-install`; `--command` accepts an executable prefix for an existing installation.

When upgrading an existing MCP setup, update any separately pinned server command to `mason-context@0.16.2`, restart the server, and refresh the Mason instruction block through `mason_init`. Existing decisions and repair baselines need no migration. Upgrading the package alone does not install hooks.

`status` distinguishes configuration from observed events. Host versions, project trust, policy, and specialized tool paths can prevent hooks from running. Configuration alone is not evidence of automatic use. Codex requires review/trust of new or changed non-managed hooks. See the [Claude Code hook reference](https://code.claude.com/docs/en/hooks) and [Codex hook reference](https://learn.chatgpt.com/docs/hooks).

Mason checks documentation as you work. It gives the assistant new or worsened findings after tool calls and when you submit a prompt. At the end of a response, a separate notice shows you any remaining new findings. Existing findings normally stay quiet. Claude Stop can continue the assistant once when outstanding decision drift overlaps anchor edits observed during that session.

Claude Stop review blocking defaults to `drift`. Mason compares paired pre-tool and post-tool anchor content, including directory additions/deletions, separately for each session and branch/worktree. Existing drift becomes eligible when the session changes the affected content again. Commits alone, read-only tools, and unmatched captures do not establish session edits. Intervals where HEAD moves are conservatively excluded from new edit attribution, so pulls/merges/checkouts stay advisory; an edit committed within one tool may therefore lack attributable evidence. Earlier observed edits survive later commits. Missing or unreadable evidence stays advisory. Concurrent writes during a tool can contribute; observed changes do not prove authorship.

The reminder names each decision and asks the assistant to run `review_decision(action: "prepare", id: "...")`, inspect the claims against source and diff, and record `action: "inspect"` with supporting evidence when no contradiction is found. Conflicts or uncertainty require an explanation and user direction. Acceptance, reaffirmation, and retirement still require authorized human review. Editing a proposal does not silently replace the accepted revision.

The same decision revision and observed content block only once; repeat Stops and `stop_hook_active: true` return advisory context. Delivery does not resolve a finding. Inspection, authorized review, or a check confirming resolution clears covered drift; later observed edits can prompt again, including another edit to the same dirty file. An unrelated commit or external edit to another anchor does not repeat the block. Codex retains advisory behavior. This is a bounded inspection reminder, not proof of correctness or a guarantee of human approval.

```sh
mason auto config --stop-block off   # Disable Claude Stop review blocking in this checkout
mason auto config --stop-block drift # Restore the default
mason auto status                   # Shows stopBlock, including before hooks run
```

The local preference and session receipts live under `.mason/reports/automation/`. Host hook generation with `mason auto config --host claude|codex` remains read-only and separate. Body-length warnings remain advisory.

Run `mason check` to see all outstanding findings, including the quiet backlog. Exit codes are 0 for verified checks, 1 for outstanding issues, and 2 for incomplete or unavailable verification. A quiet completion notice does not mean the audit passed.

Mason compares the underlying condition, so changes to wording, line numbers, or commit metadata do not repeat a notice. A finding can notify again if it worsens or returns after a confirmed resolution. Delivery history survives restarts and is shared within the branch/worktree. Assistant feedback and user notices have separate histories; explicit checks consume neither. Each notice shows up to four findings, with overflow kept for later delivery.

Use `mason status` or `mason_automation(action: "status")` to review uncommitted decision records and pending proposals, with the oldest proposals first. Assistants retrieve relevant proposals through `get_context`. Proposals require explicit review before acceptance; their presence alone does not fail a check.

Checks preserve original repair evidence before later edits can obscure it. Known read-only tools record activity without rescanning. If an old notification report cannot be loaded, Mason starts notification tracking from the current audit and reports the recovery; original repair evidence remains intact. Verification warnings are deduplicated per session.

Limits: hooks depend on host support and observed events. Some checks need committed changes or defer judgment during document edits. Findings may include concurrent edits, and a whole-file decision anchor cannot identify which edit affects a decision. Use a full check before committing, inspect relevant evidence, and keep repairs within the authorized task.

Unified setup generates an inline availability guard. Hooks stay quiet if Mason is absent from PATH or the checkout has neither local nor inherited setup for that host; `mason status` explains inactive setup. Invalid records and failures after activation remain visible. After upgrading to these guards, rerun setup and review the generated changes. Custom commands from manual `install --command` are not automatically guarded. See [data and network behavior](data-and-network.md) and [hook performance](hook-performance.md).

Checks reuse cached results only when their dependencies match. Documentation and history, module candidates, documented workspace counts, command manifests, and decision evidence have separate invalidation keys. Unrelated generated build output does not invalidate these checks; explicitly documented generated files and workspace members still do. Changes to a dirty manifest invalidate its checks even when Git's status text is unchanged. Skipped checks are retried. Cache corruption causes recomputation; invalid original baselines or active state remain errors. Concurrent events serialize writes, and interrupted local writers' locks are recovered only when their process is gone. New reports are written atomically. Unchanged tool events reuse the existing full report.

```bash
mason check --json   # Capture/resume the active evidence and verify it
# After any final documentation commit:
mason check
```

The equivalent MCP operation is `mason_automation(action: "check")`. Its response is concise and links the full local report. `status` is read-only; `check` writes evidence. Exit codes are 0 for verified checks, 1 for unresolved issues, and 2 for incomplete/unavailable checks. When only advisory assessments remain, the human summary says “advisories awaiting review”; the JSON status and exit code remain `incomplete` and 2. Summaries use current finding evidence when available and identify historical conditions that no longer appear in the current check. Original `mason_repair` baselines remain separately verifiable by their paths. Hook errors are visible and advisory; exit 0 from a hook does not mean verification passed. Claude Stop can return JSON `decision: "block"` with exit 0 to request one continuation for decision inspection. CLI JSON and MCP failures include a category (`inputs-changed`, `storage-full`, `busy`, `invalid-input`, `history-unavailable`, `invalid-evidence`, `io-error`, or `internal`), retryability, and whether a failure receipt was saved. Changing inputs require another check on a stable checkout; they never produce a cached pass.

`status` includes a bounded history of the latest 32 execution attempts, their duration after lock acquisition, and the number of older receipts omitted. A completed attempt includes its verification outcome. A started attempt without a matching live local lock owner is unknown, and a failed or unfinished latest attempt prevents an older report from being presented as current verification. Storage exhaustion can prevent even a failure receipt from being saved; the caller reports that explicitly. Receipts contain no prompts or tool arguments. The existing `mason-hook` decision injector keeps its previous behavior.

Evidence is local to the worktree and branch. Switching assistants in that worktree resumes the same repair; another worktree or branch has separate state. Detached-HEAD commits retain evidence; moving that checkout to a different history requires inspection. Hooks select the active checkout from the event payload’s working directory, including subdirectories and linked worktrees. A linked worktree without a local setup record can inherit host activation from the primary checkout identified by Git’s common directory; it never borrows the primary checkout’s audit evidence or ownership records. Status includes `activationRoot` when setup is present. If Git cannot identify a primary checkout (for example, a bare repository or separately stored metadata without a recorded checkout location), run setup in the linked worktree explicitly. If a tool changes checkouts between its pre- and post-hooks, pairing remains unknown and the diagnostic says so; this does not prevent subsequent worktree checks. For managed hooks installed by setup, an event outside Git can use the launch directory or Claude's `CLAUDE_PROJECT_DIR` as a fallback only when there is one unambiguous checkout. Conflicting roots, unavailable project history, or multiple worktrees remain unverified: return to the intended checkout and run `mason check`. Standalone `mason auto hook` calls retain their explicit payload directory. Claude's project environment variable stays at the original checkout after entering a worktree, so it cannot safely override the payload. See the [Claude hook directory contract](https://code.claude.com/docs/en/hooks).

Reports are not automatically transferred to CI. CI can call `mason check` on retained local artifacts, or `mason-audit --verify-repair <baseline>` after restoring the original artifacts at their recorded root. A fresh checkout cannot reconstruct missing pre-edit evidence. Audits discover README and instruction files at any depth, preserving filename case and respecting exclusions; see [audit scope](checks.md#context-file-audit). Setup continues to write only its host instruction entry points. References into `.git/` are reported as skipped Git metadata, whose layout varies between checkouts; they do not abort setup or count as verified repository references.

Automation reads each check's dependencies rather than inventorying every file and directory. Module discovery uses Git's tracked and non-ignored source paths, then applies Mason's built-in exclusions and `.mason/config.json` `ignore` patterns. Tracked source remains visible under Git ignore rules. Explicit documentation references and workspace declarations still observe ignored paths; exclusions cannot silently remove those claims from verification. Workspace command discovery runs only when a documented script is absent from the root manifest.

Each scoped glob is bounded at 100,000 relevant results and 100,000 traversed directories; errors name the discovery operation and its scope. Input reads are bounded too. Retained baselines remain capped at 128, with unresolved findings preserved on failure. Symlinks in inputs actually read or traversed remain unsupported evidence; unrelated ignored symlinks do not block setup. These bounds are not proof of arbitrary repository scale or universal tool interception.

The [automation evaluation](../bench/harness/automation/README.md) compares ordinary module-renaming requests and unrelated edits across hosts, with baseline, instructions, and hooks arms. Deterministic replay verifies the mechanism; live sessions measure actual activation.

## Decision injection (mason-hook)

Recorded knowledge only helps if it shows up. Retrieval tools depend on the model deciding to call them — and it often doesn't. `mason-hook` removes the gamble: it's a Claude Code `PostToolUse` hook that fires when a session reads or edits a file, looks up the decision records anchored to that file (exact path or directory prefix), and injects them into the model's context. Deterministic lookup, no LLM call, ~100ms, silent when nothing matches. Each decision is injected at most once per session, and records whose anchors drifted since verification carry a verify-before-relying marker.

```bash
npx -p mason-context mason-hook --print-config   # the settings block to add
```

Add the printed block to `.claude/settings.json` — the *committed* project settings, so every teammate's sessions get the same rail. The loop this closes: someone captures a proposal with `save_decision` and records acceptance with `review_decision` ("this screen has a v1 and v2 — new work goes in v2 behind flag X"), and from then on any session that touches those files gets told, whether or not it thought to ask.

For faster fires than `npx` resolution allows, install the package (`npm i -D mason-context`) and point the command at `node_modules/.bin/mason-hook`.

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

## Upgrading from earlier versions

**0.17.1:** Upgrade Mason and restart running assistants to receive the audit, MCP and hook fixes. Rerun `mason setup --host codex` or `--host claude` to refresh the Git ignore allowlist and Claude's explicit stdio entry; review and commit those configuration changes. A fresh clone can connect to MCP before local setup, but automatic hooks still require setup in each checkout. Existing decisions and repair evidence are retained.

**0.17.0:** Upgrade Mason and restart running assistants. Existing PATH-based integrations immediately use the upgraded binary. Rerun `mason setup --host codex` or `--host claude` in each project to refresh the managed guidance for revising existing lessons and the Git ignore rules that retain `.mason/reviews/`. Review and commit these project changes. Existing decisions and repair evidence are preserved; no decision-store migration is required, and setup does not approve findings or decisions.

**0.15.0:** Project integrations use the global `mason` command. Earlier generated setup layouts have no automatic migration: remove their Mason MCP/hook entries and generated setup files, preserve decisions and repair reports, then follow the fresh setup flow above. Once configured, global upgrades apply on the next launch; restart running assistants and review any changed native trust settings.

**0.10.1 decision fix:** Accepted constraints remain visible while replacement revisions are proposed. Clients sharing a decision store should use a version containing this fix. See the [release notes](../CHANGELOG.md#0101--2026-09-05).

**From 0.9.x:** Update every client sharing decision records and refresh the marker-delimited project instructions. New decisions are version 2 proposals; legacy records remain unreviewed until explicitly reviewed. Saving unchanged content does not refresh its evidence. Map builds require `mode: "map"`. See the [migration notes](../CHANGELOG.md#upgrading-from-090).

## 0.4.0 migration

The pre-v0.4.0 LLM-driven CLI workflows were removed. MCP tools handle assistant-driven workflows; the current `mason` CLI provides setup and deterministic checks.

| Old CLI | New flow |
|---|---|
| `mason set-llm <provider>` | Not needed — your assistant *is* the LLM. |
| `mason snapshot` | Ask your assistant: *"build a Mason concept map"* → `mason_init` with `mode: "map"` → the Map-Reduce workflow. |
| `mason generate` (CLAUDE.md) | Removed. Use your assistant directly. |
| `mason analyze` | Ask your assistant: *"give me git stats for this repo"* — it calls `analyze_project`. |
| `mason impact File.kt` | Ask your assistant: *"what would changing File.kt affect?"* — it calls `get_impact`. |
| `mason snapshot --install-hook` | Removed. The map auto-refreshes when the assistant detects stale state. |

Use `mason` for `setup`, `teardown`, `status`, `check`, `stats`, `audit`, `review`, `drift`, and `mcp`. Hook configuration and execution use `mason auto`. The package also provides `mason-mcp`, `mason-drift`, `mason-audit`, `mason-hook`, and `mason-review`. The removed pre-0.4 workflows stay removed.
