# CLAUDE.md

## Project Overview

Mason is a context engineering MCP server that maintains a persistent feature-to-file concept map (`.mason/snapshot.json`) so AI assistants can answer architecture questions without re-exploring the codebase every session. It also exposes change-impact analysis, drift detection, git history aggregation, and Confluence wiki sync.

**Tech stack:** TypeScript, Node 20+, ESM modules
**Build:** tsup (bundler), vitest (testing)
**Package:** `mason-context` on npm

## Architecture

Mason is MCP-only (since v0.4.0). Entry points:
- **MCP Server** (`bin/mason-mcp.ts` → `src/mcp/server.ts`) — tool server for AI assistants; all functionality lives here
- **mason-drift** (`bin/mason-drift.ts` → `src/drift/cli.ts`) — headless CI staleness check for the concept map (exit 0 fresh / 1 stale / 2 error); read-only and LLM-free
- **mason-audit** (`bin/mason-audit.ts` → `src/audit/cli.ts`) — headless CI audit of the repo's AI context files (CLAUDE.md, .claude/CLAUDE.md, AGENTS.md) against repo reality (exit 0 clean / 1 issues / 2 error); read-only, LLM-free, and works on repos with no Mason setup
- **mason** (`bin/mason.ts`) — deprecation shim that prints a migration message

### Core Modules

```
src/
├── analyzers/          # Pluggable analyzers (git-history)
│   ├── index.ts        # Runner — executes all analyzers
│   └── git-history.ts  # Commit conventions, hot files, stale dirs
├── audit/              # mason-audit: context-file audit engine
│   ├── audit.ts        # computeAudit orchestrator
│   ├── claims.ts       # Markdown claim extraction (paths, counts, commands)
│   ├── tree.ts         # ASCII directory-tree reconstruction
│   ├── docs.ts         # Context-file discovery + git metadata
│   ├── cli.ts          # mason-audit CLI (summary, --json, --fix-prompt)
│   └── checks/         # One check per file + registry (issues vs advisories)
├── confluence/         # Confluence wiki sync (client, renderer, diff, sync)
├── drift/
│   ├── drift.ts        # computeDrift — per-entry staleness vs git HEAD
│   └── cli.ts          # mason-drift CLI (arg parsing, summary, exit codes)
├── impact/
│   └── impact.ts       # Change impact: co-change, references, related tests
├── llm/
│   ├── config.ts       # Provider config (~/.mason/config.json)
│   └── providers.ts    # Multi-provider LLM calls (used by Confluence rewrite)
├── mcp/
│   ├── server.ts       # MCP tool definitions (Zod schemas)
│   ├── tools.ts        # Tool implementations — the core logic
│   ├── init.ts         # Init gating + setup playbook
│   └── sampler.ts      # Smart file selection by architectural role
├── snapshot/
│   ├── snapshot.ts     # Snapshot load/save, batch preparation
│   ├── partials.ts     # Map-Reduce partials + scoped-refresh scope marker
│   └── prompt.ts       # Batch / reduce / refresh-reduce system prompts
├── test-map.ts         # Test-to-source pairing by naming convention
├── types.ts            # Shared interfaces
└── utils/
    └── git.ts          # Git repo detection
```

## Development Commands

```bash
npm run build          # Build with tsup
npm run dev            # Build in watch mode
npm test               # Run tests (vitest run)
npm run test:watch     # Run tests in watch mode
```

## Code Conventions

- **Conventional commits** required: `type(scope): description` (e.g., `feat(auth): add login endpoint`). 100% of recent commits follow this format.
- **ESM modules** — all imports use `.js` extensions (`import { foo } from "./bar.js"`)
- **Zod** for runtime validation (MCP tool schemas)
- **No classes** in most modules — functional style with exported async functions. Exception: analyzers use classes implementing an `Analyzer` interface.

## Testing

- Tests live in `test/` directory with `.test.ts` extension
- Test fixtures in `test/fixtures/` — multi-language sample projects (Go, Python, Kotlin, React, Rust, Swift) used to test Mason's analysis capabilities
- Test files map directly to source: `test/drift.test.ts` → `src/drift/drift.ts`
- Tests use temp directories for git operations (create repos, make commits, verify analysis)
- Benchmarks live in `bench/` — `bench/harness/` drives real headless claude sessions in baseline-vs-mason arms (superseded older deepeval harness sits in `bench/tests/`)

## Concept-Map Lifecycle (key patterns)

- **Map-Reduce build**: `generate_snapshot_batch` walks source files in batches; the assistant writes partials via `save_partial_snapshot`; `reduce_snapshot` returns everything for the assistant to merge; `save_snapshot` persists (replace mode when partials exist, merge mode otherwise).
- **Drift detection**: `mason_check_drift` / `src/drift/drift.ts` compare the map against HEAD deterministically (git `--name-status -M` diff per distinct verification hash). Each feature/flow may carry a `refreshedHash` — the commit it was last verified against — so partially refreshed maps still report stale entries.
- **Scoped refresh**: `generate_snapshot_batch` with a `files` list walks only the drift set and writes a scope marker (`.mason/partial-snapshots/scope.json`); `reduce_snapshot` then merges partials into the existing map instead of rebuilding.
- **Incremental save**: `save_snapshot` merge mode accepts `removeFeatures`/`removeFlows` for renamed/deleted features and stamps refreshed entries with HEAD while backfilling untouched entries with the previous hash.
- **Sampler**: `src/mcp/sampler.ts` selects representative files by role (config, entry point, viewmodel, repository, service, handler, middleware, test). Configurable via project-level `.mason/config.json` with custom sampling patterns.
- **Tool metadata lives in three places** — keep them in sync when adding/changing tools: `src/mcp/server.ts` (Zod schemas), `manifest.json` (MCPB manifest), README tools table.

## LLM Provider Support

LLM calls happen only in the Confluence sync rewrite (`src/confluence/rewrite.ts` via `src/llm/providers.ts`); the concept map itself is written by the connected assistant, not by Mason. Providers: claude (API or CLI), openai (API), ollama (CLI), gemini (CLI). Config stored at `~/.mason/config.json`.

<!-- mason:start -->
## Mason concept map

This project has a Mason concept map (`.mason/snapshot.json`) and decision store (`.mason/decisions/`) served over MCP. Use them BEFORE grep, glob, or file reads:

- Task, bug, or change request → `get_context` with the task text: relevant features, files, tests, blast radius, freshness, and decisions in one call.
- "How does X work / where is Y" → `get_snapshot` first.
- Before editing any file → `get_impact`.
- Learned something the code can't tell you (a failed approach, a deprecation, a workaround's reason, a review-settled convention) → record it with `save_decision`. Never record code-derivable facts, session trivia, or secrets.
- Decisions returned by `get_context` are constraints — follow them; verify any marked stale before relying on it.

Fall back to manual exploration only for what the map doesn't answer.
<!-- mason:end -->
