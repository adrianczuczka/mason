# Mason – the context builder for LLMs 👷

[![npm version](https://img.shields.io/npm/v/mason-context)](https://www.npmjs.com/package/mason-context)
[![CI](https://img.shields.io/github/actions/workflow/status/adrianczuczka/mason/ci.yml?branch=main)](https://github.com/adrianczuczka/mason/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/mason-context)](https://www.npmjs.com/package/mason-context)
[![license](https://img.shields.io/github/license/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/blob/main/LICENSE)
[![issues](https://img.shields.io/github/issues/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/issues)

### A persistent concept map for your AI coding assistant — so it stops re-exploring your codebase every session.

**Up to 67% fewer tokens on architecture questions · same answer quality · MCP-only**

```bash
claude mcp add mason --scope user -- npx -p mason-context mason-mcp
```

Restart Claude Code, then ask: *"use mason to set up this project."* The assistant calls `mason_init`, walks you through a quick Q&A to build the concept map, and you're done.

Next session, your assistant loads the map instead of grepping 8 files to figure out what your app does.

> **0.4.0 note:** Mason is MCP-only as of v0.4.0. The previous `mason <command>` CLI has been removed — everything runs through MCP tools, driven by your assistant. See [0.4.0 migration](#040-migration) below if you used the old CLI.

---

## The pain

Every new conversation about your code, your assistant starts from zero. It greps for `auth`, reads three files, greps for `user`, reads three more, pieces together the architecture, then finally answers. Tomorrow you ask a different question — same dance. The understanding it built yesterday is gone.

## The fix

Mason persists a **feature-to-file map** in `.mason/snapshot.json`. One MCP tool call returns:

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

**Where the map comes from:** Mason doesn't parse your code. Your assistant reads the project through Mason's analysis tools (`analyze_project`, `get_code_samples`, `full_analysis`) and writes the map itself. That means it captures architectural intent — what the code is *for* — not just symbols and call edges.

## Benchmark

[deepeval](https://github.com/confident-ai/deepeval), Claude Sonnet, 164-file Kotlin Multiplatform project:

| Question | With Mason | Without Mason | Token saving |
|---|---|---|---|
| List all features | 10,258 tok | 31,346 tok | **67%** |
| Trace data flow | 12,010 tok | 15,258 tok | **21%** |
| Compare platforms | 10,897 tok | 19,353 tok | **44%** |
| Onboarding flow | 10,271 tok | 11,432 tok | **10%** |
| **Average** | | | **36%** |

Same answer quality (0.9/1.0 on every question, both paths). Reproduce: [bench/](bench/).

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
| `get_snapshot` | Load the concept map — feature → file lookup. |
| `get_impact` | Trace what's affected by changing a file — co-change history + references + related tests. |
| `analyze_project` | Git stats — hot files, stale dirs, commit conventions. |
| `full_analysis` | One-shot first visit: structure + samples + tests + git. |
| `get_code_samples` | Smart file previews selected by architectural role. |

The init / write tools refuse to run until `mason_init` has completed. The read-only diagnostics (`analyze_project`, `full_analysis`, `get_code_samples`) work without init.

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

## Confluence sync

Keep a Confluence wiki in sync with the concept map, in plain product language that PMs and designers can read. Each sync rewrites the snapshot through your assistant into PM-friendly descriptions, pushes one page per feature, and posts a "what changed since last sync" entry to a changelog page. Hand edits outside `<!-- mason:start:* -->` / `<!-- mason:end:* -->` markers survive the next sync — Mason only owns the marked regions.

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
