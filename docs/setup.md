# Setup and integrations

[← Mason](../README.md)

Install the [standalone CLI](distribution.md) to use Mason without system Node or npm. npm installation remains supported below.

- [Unified project setup](#unified-project-setup)
- [Disconnect a project](#disconnect-a-project)
- [Decision hooks and explicit audit checks](#automatic-documentation-checks-mason)
- [Decision injection (mason-hook)](#decision-injection-mason-hook)
- [Other clients](#other-clients)
- [Upgrading from earlier versions](#upgrading-from-earlier-versions)
- [0.4.0 migration](#040-migration)

## Unified project setup

The CLI separates shared repository configuration from local activation:

| Command | Purpose | Files it may change |
|---|---|---|
| `mason init --host claude` | Prepare or update shared integration for an MR | Agent instructions, MCP and hooks configuration, ignore rules; local ownership bookkeeping |
| `mason setup --host claude` | Activate compatible existing integration | Ignored local activation records only |
| `mason status` | Inspect configuration, compatibility and observed use | None |
| `mason teardown --host claude` | Disconnect this developer locally | Local activation records only |
| `mason teardown --project --host claude` | Remove shared integration for an MR | Identifiable shared integration entries and their local records |

Use `--host codex` for Codex. Commands run in the current Git checkout; `--dir /absolute/path/to/project` selects another checkout. Installing or upgrading the executable is separate from configuring a repository.

For a new project, a maintainer runs:

```bash
mason init --host claude --dry-run
mason init --host claude
# Review and commit the shared configuration through the project's normal workflow.
```

Each developer, including the maintainer, then runs:

```bash
mason setup --host claude
mason status
```

With npm, first run `npm install -g mason-context`. A temporary `npx` invocation alone does not install the persistent `mason` command required for activation. A local source build uses `npm run build` and `npm link` in Mason's checkout.

`init` prepares configuration without activating the checkout or running audits. Repeating it is idempotent. `setup` validates compatibility and writes local records; it never repairs shared files. If configuration is absent or incompatible, it explains that a maintainer must run `init`. Compatible older guidance, known supported hook commands and alternate JSON formatting do not require a template update. Status reports available template updates separately from incompatibility. Compatibility checks recognize supported integrations; they do not establish that prose guidance is correct or that host trust has been granted.

For teams, pin a common release when reproducibility matters. Initialize once per desired host and review the resulting MR. Teammates activate the committed configuration locally without an MR. Separate clones need local setup; linked Git worktrees inherit primary-checkout activation unless locally overridden. An executable upgrade does not rewrite tracked files. Required shared migrations use `mason init` and an MR; ordinary activation remains `mason setup`.

Shared mutation commands support `--dry-run`, including `teardown --project`. Previews create no files or locks and list the files that would change. `--json` emits one structured result to stdout, including action, status and planned/applied changes; human progress uses stderr. Invalid arguments and failed operations return exit code 2, successful operations/previews return 0, and no command prompts for input. Setup and initialization do not grant host trust, approve decisions, run documentation audits, prepare repairs or enable stats. Explicit checks remain available through `mason audit`, `mason review` and `mason check`.

Initialization preserves guidance outside marked Mason blocks, unrelated host settings and explicit disable options. Codex receives an `AGENTS.md` entry point; Claude receives or reuses `CLAUDE.md`, with native `@AGENTS.md` imports where appropriate. Malformed configuration and concurrent edits are rejected. Interrupted initialization can be resumed with `mason init`; interrupted local activation uses `mason setup`.

Commit assistant instructions, `.gitignore`, the selected host's configuration (`.codex/config.toml` and `.codex/hooks.json`, or `.mcp.json` and `.claude/settings.json`), and shared decisions/configuration as appropriate. Local ownership and activation live under ignored `.mason/local/`; observations and receipts are in ignored `.mason/reports/`. Local operations refuse tracked private-state files. Existing repair evidence is retained.

A fresh clone with Mason installed and its MCP configuration trusted can retrieve context before local setup. Shared automatic hooks remain inactive until local or inherited activation exists. Connecting does not create local setup. Native host trust is a separate step; status distinguishes configured from observed use.

The generated Git ignore block excludes `.mason/` contents by default and allows shared `decisions/`, `reviews/`, `config.json`, and `snapshot.json`. Unexpected scratch or cache files stay ignored. Already tracked files retain Git's normal tracking behavior. Repeating initialization with unchanged templates leaves committed configuration unchanged; upgrading the executable alone does not rewrite it. Claude MCP entries explicitly use `type: "stdio"`.

Setup checks that its process can find a compatible `mason` on PATH. A desktop assistant may have a different environment: restart it after installation, then check MCP and hook activation. If it still cannot find Mason, check the PATH inherited by that application. Terminal discovery alone does not prove desktop activation.

Finish activation in the host:

1. Review the project's MCP and hook configuration through the host's native trust controls. Codex provides `/hooks` in its CLI; Claude Code requires approval for project MCP servers. Setup never changes trust on your behalf. See the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks) and [Claude Code project MCP documentation](https://code.claude.com/docs/en/mcp).
2. Start a new assistant session in that project and give it a normal task. The project instructions direct the assistant to request Mason context; hooks preserve and verify audit evidence during work.
3. Run `mason status` using the same installed build. Interactive output shows runtime/configuration health, observed events, task context requests, and verification. Use `--json` for structured output; piped status remains JSON.

`pending` means setup needs evidence of use. `active` requires a `get_context` call through the configured MCP server and all five lifecycle events in one session for the current Mason version, setup revision and worktree/branch. `attention` identifies missing PATH command, changed configuration, disabled settings, or a failed verification attempt. Verification remains a separate result: observed activation does not prove a repair was correct or that Mason improved the task. Local receipts store counts, event names, and hashed session identifiers, not prompts or tool arguments. Higher-priority host settings can still prevent execution.

Status labels recognized older hook commands `compatible` and offers a template update separately. Disabled hooks, narrowed event matchers, and commands for another operating system still require attention. Status never rewrites configuration.

For an assistant already connected to this build, `mason_init` with `mode: "init"` prepares shared configuration (`dryRun: true` previews it); `mode: "setup"` activates locally. Both accept `host: "codex"` or `"claude"`. Its default quickstart remains read-only. Setup does not build a concept map, approve advisories, or create decision records; decisions should capture actual lessons from subsequent work.

## Disconnect a project

```bash
mason teardown --dry-run                  # Preview local disconnection
mason teardown --host codex               # Disconnect one assistant locally
mason teardown                           # Disconnect all local project assistants
mason teardown --project --dry-run        # Preview shared removal for an MR
mason teardown --project --host codex     # Remove the shared Codex integration
```

Local teardown preserves shared files and ownership bookkeeping. Restart the assistant to unload the current session; `mason setup` reconnects. A worktree opt-out suppresses inherited activation while leaving the primary checkout connected.

Explicit `--project` removal removes identifiable Mason MCP entries, lifecycle hooks and local setup records. Shared Mason instruction blocks stay while another configured host needs them. After the last host is removed, unchanged Mason blocks are removed too. Review and commit shared removals. Run `mason init`, followed by `mason setup`, to restore a removed integration.

User settings, unrelated hooks and instruction text are preserved. Initialization records file ownership in ignored `.mason/local/integration.json` before changing shared files, so teardown can remove files Mason created when no user content remains. With missing receipts, only recognizable entries and blocks are removed; empty files remain because their creation cannot be attributed to Mason. Edited or ambiguous entries are retained with diagnostics. Fix or remove those entries manually and rerun teardown to finish. Repeating a completed teardown is harmless.

Decisions, shared configuration, optional maps, repair baselines and reports remain, along with their Git ignore rules. Teardown removes setup receipts across this checkout’s local branch records and keeps a local opt-out record in linked worktrees. It preserves verification history. Disconnecting the primary checkout also stops inherited activation in worktrees without their own setup; independently configured worktrees remain connected. It never uninstalls Mason or changes global host settings. There is no purge option.

Use `--json` for a structured list of planned or applied `changes` and retained-entry `diagnostics`. Exit code **0** means cleanup is complete or there was nothing to remove; **2** means cleanup needs attention, including in a dry run. `--dry-run` creates no files or locks.

To reconnect, run `mason setup --host codex` or `--host claude`. To remove the standalone application as well, run `mason uninstall` after tearing down the projects you want to disconnect. For an npm installation, use `npm uninstall -g mason-context` instead.

## Local usefulness tracking

Local stats are disabled by default. Use `mason stats --enable` to collect observations when useful. Setup leaves existing enabled, disabled or unreadable preferences untouched, including preferences enabled by earlier versions. Running `mason stats` only reads observations; it does not enable collection.

```sh
mason stats
mason stats --json
mason stats --session <session-id>
mason stats --enable
mason stats --disable
```

Tracking uses installed lifecycle hooks. `mason stats` shows aggregate counts for retained sessions in the current branch; `--session <id>` shows one session and its findings. `--json` includes the aggregate summary and session details. Counts are summed per session, so the same finding or record can appear in more than one session. Retrieval coverage distinguishes sessions with observed responses from unknown activity. The summary shows distinct findings emitted to the agent or completion channel, their latest observed check status, supplied feedback, decision records returned by observed `get_context` calls, and time spent in successful automation observations. Existing quiet backlog and undisplayed notification overflow do not count as delivered findings. Missing evidence is unknown, not resolved; review-required advisories remain open. Summaries are available on demand and do not add another automatic completion notice.

Add an optional rating using the session and finding IDs from `--json`; the session's `reportPath` links the IDs to audit evidence:

```sh
mason stats --session <session-id> --finding <finding-id> --rating helpful
# Other ratings: already-knew, irrelevant, deferred
```

Ratings are supplied feedback, not authenticated human judgments. A deferred rating does not close an audit finding. A repair after a notice is an observation, not proof that Mason caused it. Retrieval counts require a successful `mcp__mason__get_context` response exposed by the host's PostToolUse hook. Other tool names, missing receipts, and unsupported response shapes are not inferred from calls. Returned records do not establish that a lesson was applied or reused in a later session. Model-token cost is not available from these hooks. Timing includes audit orchestration and cache reuse, but excludes optional tracking writes, read-only tool observations, and failed checks.

Data stays under `.mason/local/usefulness/`, with its own Git ignore rule. It contains hashed session and decision IDs, finding IDs/types/statuses, channels, ratings, timestamps, counts, timing, and report paths—not prompts, tool arguments, decision bodies, or source contents. Nothing is uploaded. Each branch/worktree retains up to 50 sessions and each session up to 200 findings and 200 returned decision IDs; truncated sessions are marked. Disabling stops collection and retains observations. To erase them, disable tracking and remove `.mason/local/usefulness/` while no Mason process is writing. Removing that directory also clears the preference, so collection returns to its disabled default. Historical summaries describe the last observed check, not a fresh verification.

Tracking errors do not suppress audits, existing findings, or setup. Setup does not inspect or change stats preferences. `mason stats --disable` can reset a malformed preference even when observation files are unreadable; it retains those files. Delayed delivery records use newer retained audit evidence, or report an unknown outcome if that evidence is unavailable. At task end, unavailable tracking produces a short diagnostic; `mason stats --json` reports invalid storage explicitly.

<a id="automatic-documentation-checks-mason"></a>

## Decision hooks and explicit audit checks

Lifecycle hooks check decision anchors and deliver applicable recorded guidance. They do not discover documentation claims, create repair baselines, or verify retained documentation findings. Explicit `mason check` and `mason audit` commands preserve the documentation workflow. Setup and hooks leave existing audit evidence intact; neither creates an initial documentation audit. The paths share event storage and execution receipts, with separate guidance and audit report pointers. No concept map or model call is required for these checks.

Unified setup already installs these hooks. For manual npm hook installation (available from 0.12.0), install or upgrade the package in each project:

```bash
npm install -D mason-context@0.16.2
mason install --host claude   # Claude Code
mason install --host codex    # Codex; review/trust the hooks using /hooks
mason status
```

Install only the adapters you use. Installation merges the project's `.claude/settings.json` or `.codex/hooks.json`, preserves other hooks/settings, and records its own handler in ignored `.mason/local/automation.json`. Repeating installation updates only those handlers. Commit the host configuration. Installation adds ignore rules for `.mason/local/` and `.mason/reports/`; shared configuration and decision records remain available to Git. Start a new assistant session after installation. The default handler uses the locally installed package with `npx --no-install`; `--command` accepts an executable prefix for an existing installation.

When upgrading an existing MCP setup, update any separately pinned server command to `mason-context@0.16.2`, restart the server, and refresh the Mason instruction block through `mason_init`. Existing decisions and repair baselines need no migration. Upgrading the package alone does not install hooks.

`status` distinguishes configuration from observed events. Host versions, project trust, policy, and specialized tool paths can prevent hooks from running. Configuration alone is not evidence of automatic use. Codex requires review/trust of new or changed non-managed hooks. See the [Claude Code hook reference](https://code.claude.com/docs/en/hooks) and [Codex hook reference](https://learn.chatgpt.com/docs/hooks).

Mason checks decision anchors as you work. It gives the assistant new or worsened decision notices after tool calls and when you submit a prompt. At completion, a separate notice reports new decision drift. Existing findings normally stay quiet; general documentation findings appear only during explicit audit checks. Claude Stop can continue the assistant once when outstanding decision drift overlaps anchor edits observed during that session.

The current development implementation also delivers file-scoped decision bodies through Claude's standard lifecycle handlers: after `Read`, or before `Edit`/`Write` when their payload includes `file_path`. No additional hook configuration is needed. Existing PATH-based setups receive this behavior after upgrading and restarting the assistant. Accepted guidance stays distinct from pending proposals and includes source, scope and freshness labels. Delivery is confined to the active checkout and deduplicated per session/agent; changed records and withdrawals can be delivered again. Reading a file does not advance the audit verification result.

Direct lesson delivery does not parse Bash commands or cover Codex/unsupported tool payloads. Use `get_context` for those workflows. Claude reads hook context on the next model request, alongside tool results: a post-read lesson can guide a later edit, while returning context before `Edit`/`Write` executes does not stop or replan the already requested tool call. See [Claude's context timing contract](https://code.claude.com/docs/en/hooks#add-context-for-claude). Delivery is advisory; audit messages and source-inspection requirements remain separate. MCP and hooks may both return the same lesson.

Claude Stop review blocking defaults to `drift`. Mason compares paired pre-tool and post-tool anchor content, including directory additions/deletions, separately for each session and branch/worktree. Existing drift becomes eligible when the session changes the affected content again. Commits alone, read-only tools, and unmatched captures do not establish session edits. Intervals where HEAD moves are conservatively excluded from new edit attribution, so pulls/merges/checkouts stay advisory; an edit committed within one tool may therefore lack attributable evidence. Earlier observed edits survive later commits. Missing or unreadable evidence stays advisory. Concurrent writes during a tool can contribute; observed changes do not prove authorship.

The reminder names each decision and asks the assistant to run `review_decision(action: "prepare", id: "...")`, inspect the claims against source and diff, and record `action: "inspect"` with supporting evidence when no contradiction is found. Conflicts or uncertainty require an explanation and user direction. Acceptance, reaffirmation, and retirement still require authorized human review. Editing a proposal does not silently replace the accepted revision.

The same decision revision and observed content block only once; repeat Stops and `stop_hook_active: true` return advisory context. Delivery does not resolve a finding. Inspection, authorized review, or a check confirming resolution clears covered drift; later observed edits can prompt again, including another edit to the same dirty file. An unrelated commit or external edit to another anchor does not repeat the block. Codex retains advisory behavior. This is a bounded inspection reminder, not proof of correctness or a guarantee of human approval.

```sh
mason config --stop-block off   # Disable Claude Stop review blocking in this checkout
mason config --stop-block drift # Restore the default
mason status                   # Shows stopBlock, including before hooks run
```

The local preference and session receipts live under `.mason/reports/automation/`. Host hook generation with `mason config --host claude|codex` remains read-only and separate. Body-length warnings remain advisory.

Run `mason check` to explicitly verify retained documentation findings, including the quiet backlog. Exit codes are 0 for verified checks, 1 for outstanding issues, and 2 for incomplete or unavailable verification. A quiet completion notice does not mean the audit passed.

Mason compares the underlying condition, so changes to wording, line numbers, or commit metadata do not repeat a notice. A finding can notify again if it worsens or returns after a confirmed resolution. Delivery history survives restarts and is shared within the branch/worktree. Assistant feedback and user notices have separate histories; explicit checks consume neither. Each notice shows up to four findings, with overflow kept for later delivery.

Use `mason status` or `mason_automation(action: "status")` to review uncommitted decision records and pending proposals, with the oldest proposals first. Assistants retrieve relevant proposals through `get_context`. Proposals require explicit review before acceptance; their presence alone does not fail a check.

Explicit audit checks preserve original repair evidence before later edits can obscure it. Lifecycle hooks inspect current decision records and anchor content instead, without reading repair baselines. Known read-only tools record activity without rescanning. If an old notification report cannot be loaded, Mason starts notification tracking from current findings and reports the recovery; original repair evidence remains intact. Verification warnings are deduplicated per session. `status` reports its `scope` (`decision-guidance` or `documentation-audit`) and keeps the last explicit audit path in `auditReportPath`. A current guidance report does not establish that documentation repairs passed.

Limits: hooks depend on host support and observed events. Explicit audit checks may need committed changes or defer judgment during document edits. Findings may include concurrent edits, and a whole-file decision anchor cannot identify which edit affects a decision. Use a full check before committing, inspect relevant evidence, and keep repairs within the authorized task.

Unified setup generates an inline availability guard. Hooks stay quiet if Mason is absent from PATH or the checkout has neither local nor inherited setup for that host; `mason status` explains inactive setup. Invalid records and failures after activation remain visible. After upgrading to these guards, run `mason init` and review the generated changes. Custom commands from manual `install --command` are not automatically guarded. See [data and network behavior](data-and-network.md) and [hook performance](hook-performance.md).

Checks reuse cached results only when their dependencies match. Documentation and history, module candidates, documented workspace counts, command manifests, and decision evidence have separate invalidation keys. Unrelated generated build output does not invalidate these checks; explicitly documented generated files and workspace members still do. Changes to a dirty manifest invalidate its checks even when Git's status text is unchanged. Skipped checks are retried. Cache corruption causes recomputation; invalid original baselines or active state remain errors. Concurrent events serialize writes, and interrupted local writers' locks are recovered only when their process is gone. New reports are written atomically. Unchanged tool events reuse the existing full report.

```bash
mason check --json   # Capture/resume the active evidence and verify it
# After any final documentation commit:
mason check
```

The equivalent MCP operation is `mason_automation(action: "check")`. Its response is concise and links the full local report. `status` is read-only; `check` writes evidence. Exit codes are 0 for verified checks, 1 for unresolved issues, and 2 for incomplete/unavailable checks. When only advisory assessments remain, the human summary says “advisories awaiting review”; the JSON status and exit code remain `incomplete` and 2. Summaries use current finding evidence when available and identify historical conditions that no longer appear in the current check. Original repair baselines remain separately verifiable with `mason audit --verify-repair <path>`. Hook errors are visible and advisory; exit 0 from a hook does not mean verification passed. Claude Stop can return JSON `decision: "block"` with exit 0 to request one continuation for decision inspection. CLI JSON and MCP failures include a category (`inputs-changed`, `storage-full`, `busy`, `invalid-input`, `history-unavailable`, `invalid-evidence`, `io-error`, or `internal`), retryability, and whether a failure receipt was saved. Changing inputs require another check on a stable checkout; they never produce a cached pass.

`status` includes a bounded history of the latest 32 execution attempts, their duration after lock acquisition, and the number of older receipts omitted. A completed attempt includes its verification outcome. A started attempt without a matching live local lock owner is unknown, and a failed or unfinished latest attempt prevents an older report from being presented as current verification. Storage exhaustion can prevent even a failure receipt from being saved; the caller reports that explicitly. Receipts contain no prompts or tool arguments. The existing `mason-hook` decision injector keeps its previous behavior.

Evidence is local to the worktree and branch. Switching assistants in that worktree resumes the same repair; another worktree or branch has separate state. Detached-HEAD commits retain evidence; moving that checkout to a different history requires inspection. Hooks select the active checkout from the event payload’s working directory, including subdirectories and linked worktrees. A linked worktree without a local setup record can inherit host activation from the primary checkout identified by Git’s common directory; it never borrows the primary checkout’s audit evidence or ownership records. Status includes `activationRoot` when setup is present. If Git cannot identify a primary checkout (for example, a bare repository or separately stored metadata without a recorded checkout location), run setup in the linked worktree explicitly. If a tool changes checkouts between its pre- and post-hooks, pairing remains unknown and the diagnostic says so; this does not prevent subsequent worktree checks. For managed hooks installed by setup, an event outside Git can use the launch directory or Claude's `CLAUDE_PROJECT_DIR` as a fallback only when there is one unambiguous checkout. Conflicting roots, unavailable project history, or multiple worktrees remain unverified: return to the intended checkout and run `mason check`. Standalone `mason hook` calls retain their explicit payload directory. Claude's project environment variable stays at the original checkout after entering a worktree, so it cannot safely override the payload. See the [Claude hook directory contract](https://code.claude.com/docs/en/hooks).

Reports are not automatically transferred to CI. CI can call `mason check` on retained local artifacts, or `mason-audit --verify-repair <baseline>` after restoring the original artifacts at their recorded root. A fresh checkout cannot reconstruct missing pre-edit evidence. Audits discover README and instruction files at any depth, preserving filename case and respecting exclusions; see [audit scope](checks.md#context-file-audit). Setup continues to write only its host instruction entry points. References into `.git/` are reported as skipped Git metadata, whose layout varies between checkouts; they do not abort setup or count as verified repository references.

Automation reads each check's dependencies rather than inventorying every file and directory. Module discovery uses Git's tracked and non-ignored source paths, then applies Mason's built-in exclusions and `.mason/config.json` `ignore` patterns. Tracked source remains visible under Git ignore rules. Explicit documentation references and workspace declarations still observe ignored paths; exclusions cannot silently remove those claims from verification. Workspace command discovery runs only when a documented script is absent from the root manifest.

Each scoped glob is bounded at 100,000 relevant results and 100,000 traversed directories; errors name the discovery operation and its scope. Input reads are bounded too. Retained baselines remain capped at 128, with unresolved findings preserved on failure. Symlinks in inputs actually read or traversed remain unsupported evidence; unrelated ignored symlinks do not block setup. These bounds are not proof of arbitrary repository scale or universal tool interception.

The [automation evaluation](../bench/harness/automation/README.md) compares ordinary module-renaming requests and unrelated edits across hosts, with baseline, instructions, and hooks arms. Deterministic replay verifies the mechanism; live sessions measure actual activation.

## Decision injection (mason-hook)

The current development implementation uses this injector in standard Claude setup as described above. The separate `mason-hook` command remains available for custom integrations and retains its `PostToolUse` behavior for `Read`, `Edit` and `Write`. Both entry points share the same per-session/agent deduplication state. Decisions use exact file or directory anchors, are capped at three per delivery, and include verify-before-relying markers when evidence has changed or is unknown. Unchanged records are quiet after delivery; record changes can be sent again. Delivery uses local files and Git without model calls; cost depends on the decision store and inspected anchors.

```bash
npx -p mason-context mason-hook --print-config   # the settings block to add
```

For a custom integration, add the printed block to `.claude/settings.json`. Standard setup does not require this additional block. A separately configured post-edit injector cannot guarantee that the lesson arrived before the edit; prefer the standard supported read/pre-edit paths and inspect actual host delivery.

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

**0.17.1:** Upgrade Mason and restart running assistants to receive the audit, MCP and hook fixes. With the current CLI, run `mason init --host codex` or `--host claude` to refresh the Git ignore allowlist and Claude's explicit stdio entry; review and commit those configuration changes. A fresh clone can connect to MCP before local setup, but automatic hooks still require setup in each checkout. Existing decisions and repair evidence are retained.

**0.17.0:** Upgrade Mason and restart running assistants. Existing PATH-based integrations immediately use the upgraded binary. With the current CLI, run `mason init --host codex` or `--host claude` in each project to refresh the managed guidance for revising existing lessons and the Git ignore rules that retain `.mason/reviews/`. Review and commit these project changes. Existing decisions and repair evidence are preserved; no decision-store migration is required, and setup does not approve findings or decisions.

**0.15.0:** Project integrations use the global `mason` command. Earlier generated setup layouts have no automatic migration: remove their Mason MCP/hook entries and generated setup files, preserve decisions and repair reports, then follow the fresh setup flow above. Once configured, global upgrades apply on the next launch; restart running assistants and review any changed native trust settings.

**0.10.1 decision fix:** Accepted constraints remain visible while replacement revisions are proposed. Clients sharing a decision store should use a version containing this fix. See the [release notes](../CHANGELOG.md#0101--2026-09-05).

**From 0.9.x:** Update every client sharing decision records and refresh the marker-delimited project instructions. New decisions are version 2 proposals; legacy records remain unreviewed until explicitly reviewed. Saving unchanged content does not refresh its evidence. Managed map creation is removed in the current candidate; existing maps remain readable. See the [migration notes](../CHANGELOG.md#upgrading-from-090).

## 0.4.0 migration

The pre-v0.4.0 LLM-driven CLI workflows were removed. MCP tools handle assistant-driven workflows; the current `mason` CLI provides setup and deterministic checks.

| Old CLI | New flow |
|---|---|
| `mason set-llm <provider>` | Not needed — your assistant *is* the LLM. |
| `mason snapshot` | Managed map creation is removed. Existing maps remain readable and can be maintained directly through MCP. |
| `mason generate` (CLAUDE.md) | Removed. Use your assistant directly. |
| `mason analyze` | Removed. Use the connected agent’s source and Git tools. |
| `mason impact File.kt` | Ask your assistant: *"what would changing File.kt affect?"* — it calls `get_impact`. |
| `mason snapshot --install-hook` | Removed. The map auto-refreshes when the assistant detects stale state. |

Use `mason` for `setup`, `teardown`, `status`, `check`, `stats`, `audit`, `review`, `drift`, and `mcp`. Hook configuration and execution use `mason install`, `mason config`, and `mason hook --host claude|codex`. Existing `mason auto …` commands remain compatibility aliases. Bare `mason hook` and `mason hook --print-config` retain the standalone decision injector; `mason hook --help` describes lifecycle hooks. The package also provides `mason-mcp`, `mason-drift`, `mason-audit`, `mason-hook`, and `mason-review`. The removed pre-0.4 workflows stay removed.
