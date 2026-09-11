# Setup and integrations

[← Mason](../README.md)

Install the [standalone CLI](distribution.md) to use Mason without system Node or npm. npm installation remains supported below.

- [Unified project setup](#unified-project-setup)
- [Disconnect a project](#disconnect-a-project)
- [Automatic documentation checks (mason-auto)](#automatic-documentation-checks-mason-auto)
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

With npm instead (requires Node 20+ and npm):

```bash
npm install -g mason-context
mason setup --host codex
mason status
```

Run setup once for each host you use. Mason must be installed on PATH before setup; a temporary `npx` invocation alone does not install a persistent command. For a local source build, run `npm run build` and `npm link` in Mason's checkout, then use `mason setup --dir /absolute/path/to/project --host codex`.

Setup retains the initial audit before editing instruction files and configures MCP and lifecycle hooks to call the installed `mason` command. It creates no project launch scripts, runtime copy, or npm dependencies. Git is required. Standalone installations include Node in the user installation; npm installations use system Node. Neither hooks nor MCP download packages when they run.

Existing project guidance is preserved outside marked Mason blocks. Codex receives an `AGENTS.md` entry point; Claude Code receives or reuses a `CLAUDE.md` entry point, using a native `@AGENTS.md` import when that is the shared document (or `@../AGENTS.md` from `.claude/CLAUDE.md`). See [Claude Code memory imports](https://code.claude.com/docs/en/memory#agentsmd). Setup merges the named Mason MCP server and its recorded hooks while retaining unrelated settings and explicit disable options. It refuses malformed or ambiguous configuration and concurrent edits. Repeating setup resumes interrupted configuration without replacing the retained original audit.

Commit assistant instructions, `.gitignore`, the selected host's configuration (`.codex/config.toml` and `.codex/hooks.json`, or `.mcp.json` and `.claude/settings.json`), and any shared `.mason/config.json`, decisions, or optional snapshot. Setup receipts and hook ownership live in ignored `.mason/local/`; repair evidence and observed activation remain in ignored `.mason/reports/`. Setup does not create a top-level `.mason/project.json` marker. Explicit `mason_complete_init` records its timestamp locally and saves the Confluence feature flag in shared configuration.

A fresh clone runs setup to establish its local state; it does not inherit another checkout's activation. All projects use the installed Mason version on their next launch. After upgrading, restart running assistants; setup is needed again only to change or repair project configuration. This layout replaces the earlier generated launchers and per-project runtime pins; there is no automatic migration from those setups. Remove the earlier Mason host entries and generated setup files before setting up again, preserving decisions and repair evidence.

Setup checks that its process can find a compatible `mason` on PATH. A desktop assistant may have a different environment: restart it after installation, then check MCP and hook activation. If it still cannot find Mason, check the PATH inherited by that application. Terminal discovery alone does not prove desktop activation.

Finish activation in the host:

1. Review the project's MCP and hook configuration through the host's native trust controls. Codex provides `/hooks` in its CLI; Claude Code requires approval for project MCP servers. Setup never changes trust on your behalf. See the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks) and [Claude Code project MCP documentation](https://code.claude.com/docs/en/mcp).
2. Start a new assistant session in that project and give it a normal task. The project instructions direct the assistant to request Mason context; hooks preserve and verify audit evidence during work.
3. Run `mason status` using the same installed build. Interactive output shows runtime/configuration health, observed events, task context requests, and verification. Use `--json` for structured output; piped status remains JSON.

`pending` means setup needs evidence of use. `active` requires a `get_context` call through the configured MCP server and all five lifecycle events in one session for the current Mason version, setup revision and worktree/branch. `attention` identifies missing PATH command, changed configuration, disabled settings, or a failed verification attempt. Verification remains a separate result: observed activation does not prove a repair was correct or that Mason improved the task. Local receipts store counts, event names, and hashed session identifiers, not prompts or tool arguments. Higher-priority host settings can still prevent execution.

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

Decisions, shared configuration, optional maps, repair baselines and reports remain, along with their Git ignore rules. Teardown removes setup receipts across this checkout's local branch records; it does not erase verification history or disconnect other checkouts. It never uninstalls Mason or changes global host settings. There is no purge option.

Use `--json` for a structured list of planned or applied `changes` and retained-entry `diagnostics`. Exit code **0** means cleanup is complete or there was nothing to remove; **2** means cleanup needs attention, including in a dry run. `--dry-run` creates no files or locks.

To reconnect, run `mason setup --host codex` or `--host claude`. To remove the standalone application as well, run `mason uninstall` after tearing down the projects you want to disconnect. For an npm installation, use `npm uninstall -g mason-context` instead.

## Automatic documentation checks (mason-auto)

Mason can preserve documentation audit evidence and resume unfinished repairs through Claude Code or Codex lifecycle hooks. A shared engine owns the evidence, verification, and cache; each host adapter handles its event format. No concept map or model call is required for the checks.

Unified setup already installs these hooks. For manual npm hook installation (available from 0.12.0), install or upgrade the package in each project:

```bash
npm install -D mason-context@0.16.2
npx mason-auto install --host claude   # Claude Code
npx mason-auto install --host codex    # Codex; review/trust the hooks using /hooks
npx mason-auto status
```

Install only the adapters you use. Installation merges the project's `.claude/settings.json` or `.codex/hooks.json`, preserves other hooks/settings, and records its own handler in ignored `.mason/local/automation.json`. Repeating installation updates only those handlers. Commit the host configuration. Installation adds ignore rules for `.mason/local/` and `.mason/reports/`; shared configuration and decision records remain available to Git. Start a new assistant session after installation. The default handler uses the locally installed package with `npx --no-install`; `--command` accepts an executable prefix for an existing installation.

When upgrading an existing MCP setup, update any separately pinned server command to `mason-context@0.16.2`, restart the server, and refresh the Mason instruction block through `mason_init`. Existing decisions and repair baselines need no migration. Upgrading the package alone does not install hooks.

`status` distinguishes configuration from observed events. Host versions, project trust, policy, and specialized tool paths can prevent hooks from running. Configuration alone is not evidence of automatic use. Codex requires review/trust of new or changed non-managed hooks. See the [Claude Code hook reference](https://code.claude.com/docs/en/hooks) and [Codex hook reference](https://learn.chatgpt.com/docs/hooks).

On session start, Mason recovers the current branch/worktree's evidence. Before and after potentially mutating tools, it checks for changed audit inputs and retains newly observed findings before another documentation edit can hide them. Shell and unknown tool calls are included because edits can happen outside a file-edit tool. Known read-only tools record lifecycle observations without rescanning the checkout or advancing the last audit verdict. Prompt submission and turn completion still run checks. A relevant unresolved issue can request **one continuation per session**; advisories and unavailable checks never create a repair loop. Fixes remain the assistant's responsibility within the user's task scope.

Unified setup generates an inline availability guard. Hooks stay quiet if Mason is absent from PATH or the checkout has no local setup for that host; `mason status` explains inactive setup. Invalid records and failures after activation remain visible. After upgrading to these guards, rerun setup and review the generated changes. Custom commands from manual `install --command` are not automatically guarded. See [data and network behavior](data-and-network.md) and [hook performance](hook-performance.md).

Checks reuse cached results only when their dependencies match. Documentation and history, module candidates, documented workspace counts, command manifests, and decision evidence have separate invalidation keys. Unrelated generated build output does not invalidate these checks; explicitly documented generated files and workspace members still do. Changes to a dirty manifest invalidate its checks even when Git's status text is unchanged. Skipped checks are retried. Cache corruption causes recomputation; invalid original baselines or active state remain errors. Concurrent events serialize writes, and interrupted local writers' locks are recovered only when their process is gone. New reports are written atomically. Unchanged tool events reuse the existing full report.

```bash
npx mason-auto check --json   # Capture/resume the active evidence and verify it
# After any final documentation commit:
npx mason-auto check
```

The equivalent MCP operation is `mason_automation(action: "check")`. Its response is concise and links the full local report. `status` is read-only; `check` writes evidence. Exit codes are 0 for verified checks, 1 for unresolved issues, and 2 for incomplete/unavailable checks. Original `mason_repair` baselines remain separately verifiable by their paths. Hook errors are visible and advisory; exit 0 from a hook means the host can continue, not that verification passed. CLI JSON and MCP failures include a category (`inputs-changed`, `storage-full`, `busy`, `invalid-input`, `history-unavailable`, `invalid-evidence`, `io-error`, or `internal`), retryability, and whether a failure receipt was saved. Changing inputs require another check on a stable checkout; they never produce a cached pass.

`status` includes a bounded history of the latest 32 execution attempts, their duration after lock acquisition, and the number of older receipts omitted. A completed attempt includes its verification outcome. A started attempt without a matching live local lock owner is unknown, and a failed or unfinished latest attempt prevents an older report from being presented as current verification. Storage exhaustion can prevent even a failure receipt from being saved; the caller reports that explicitly. Receipts contain no prompts or tool arguments. The existing `mason-hook` decision injector keeps its previous behavior.

Evidence is local to the worktree and branch. Switching assistants in that worktree resumes the same repair; another worktree or branch has separate state. Detached-HEAD commits retain evidence; moving that checkout to a different history requires inspection. Hooks follow the Git worktree of the event's working directory. Reports are not automatically transferred to CI. CI can call `mason-auto check` on retained local artifacts, or `mason-audit --verify-repair <baseline>` after restoring the original artifacts at their recorded root. A fresh checkout cannot reconstruct missing pre-edit evidence. Audits discover README and instruction files at any depth, preserving filename case and respecting exclusions; see [audit scope](checks.md#context-file-audit). Setup continues to write only its host instruction entry points.

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

The package provides `mason-mcp`, `mason-drift`, `mason-audit`, `mason-auto`, `mason-hook`, and `mason-review`. Versions through 0.13.0 use `mason` as a migration shim. From 0.14.0, `mason` provides `setup`, `status`, `check`, `audit`, `review`, `drift`, and `mcp`, while retaining the dedicated commands. The removed pre-0.4 workflows stay removed.
