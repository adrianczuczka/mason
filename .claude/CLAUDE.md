# CLAUDE.md

## Project Overview

Mason is a context engineering CLI & MCP server that generates intelligent CLAUDE.md files through structured codebase analysis. It analyzes git history, project structure, code samples, and test mappings, then uses an LLM to produce actionable documentation.

**Tech stack:** TypeScript, Node 20+, ESM modules
**Build:** tsup (bundler), vitest (testing)
**Package:** `mason-context` on npm

## Architecture

Mason has two entry points:
- **CLI** (`bin/mason.ts` → `src/cli.ts`) — interactive commands for end users
- **MCP Server** (`bin/mason-mcp.ts` → `src/mcp/server.ts`) — tool server for AI assistants

### Core Modules

```
src/
├── cli.ts              # CLI commands: init, analyze, set-llm
├── analyzers/          # Pluggable analyzers (git-history)
│   ├── index.ts        # Runner — executes all analyzers
│   └── git-history.ts  # Commit conventions, hot files, stale dirs
├── llm/
│   ├── config.ts       # Provider config (~/.mason/config.json)
│   └── providers.ts    # Multi-provider LLM calls (Claude, OpenAI, Ollama, Gemini)
├── mcp/
│   ├── server.ts       # MCP tool definitions (Zod schemas)
│   ├── tools.ts        # Tool implementations (analysis, sampling, snapshots)
│   └── sampler.ts      # Smart file selection by architectural role
├── snapshot/
│   └── snapshot.ts     # Persistent snapshots (.mason/snapshot.json)
├── types.ts            # Shared interfaces
└── utils/
    ├── git.ts          # Git repo detection
    └── logger.ts       # Debug/info/warn logging
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
- Test files map directly to source: `test/git-history.test.ts` → `src/analyzers/git-history.ts`
- Tests use temp directories for git operations (create repos, make commits, verify analysis)

## LLM Provider Support

Configured via `mason set-llm <provider>`. Providers:
- **claude** — API (needs `ANTHROPIC_API_KEY`) or CLI (no key needed)
- **openai** — API only (needs `OPENAI_API_KEY`)
- **ollama** — CLI only (local, no key needed)
- **gemini** — CLI only (no key needed)

Config stored at `~/.mason/config.json`.

## High-Risk Files

These files change frequently — take extra care when modifying:
- `src/cli.ts` (9 recent commits)
- `src/llm/providers.ts` (6 recent commits)

## Key Patterns

- **Snapshot system**: `.mason/snapshot.json` stores LLM-generated file summaries with git hash tracking. Snapshots avoid re-reading entire codebases across sessions.
- **Sampler**: `src/mcp/sampler.ts` selects representative files by role (config, entry point, viewmodel, repository, service, handler, middleware, test). Configurable via project-level `.mason/config.json` with custom sampling patterns.
- **Tool implementations** in `src/mcp/tools.ts` are the core logic — the MCP server and CLI both call into these.
