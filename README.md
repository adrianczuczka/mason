# Mason

A context engineering tool that helps LLMs understand your codebase. Mason handles the expensive parts — aggregating git history, selecting architecturally important files, mapping test coverage, and persisting project knowledge across sessions — so the LLM can focus on interpretation.

Works as an **MCP server** (for Claude Code, Cursor, etc.) or as a **standalone CLI** with any LLM provider.

## Install

```bash
npm install -g mason-context
```

## Usage

### As an MCP server (recommended)

Add Mason to Claude Code:

```bash
claude mcp add mason -- npx mason-context mcp
```

Then ask Claude to generate a CLAUDE.md — it will call Mason's tools automatically.

Mason exposes 9 tools via MCP:

| Tool | What it does |
|---|---|
| `full_analysis` | All-in-one: git stats + project structure + code samples + test map + snapshot |
| `get_snapshot` | Load persistent project snapshot (file summaries from previous sessions) |
| `save_snapshot` | Save file summaries for future sessions (no API key needed — the LLM generates them) |
| `analyze_project` | Git history stats (commit patterns, stale dirs, hot files) |
| `get_code_samples` | Smart file previews — config, entry points, architectural patterns, tests |
| `get_file_content` | Read any file in full (drill-down after previewing) |
| `get_project_structure` | Directory tree with file counts and extension breakdown |
| `get_test_map` | Map test files to source files by name matching |
| `write_claude_md` | Save the generated CLAUDE.md |

### Persistent snapshots

Mason can persist its understanding of your project across conversations, saving thousands of tokens per session.

**Via MCP (no API key needed):**

Ask your AI assistant to "create a mason snapshot for this project." It will analyze the codebase, summarize each key file, and call `save_snapshot` to persist the summaries. Next session, it loads the snapshot via `get_snapshot` instead of re-reading everything.

**Via CLI (requires LLM provider):**

```bash
mason set-llm gemini AIza-xxx          # configure a provider
mason snapshot ~/my-project            # generate snapshot
mason snapshot --install-hook          # auto-update on every commit
```

The snapshot updates incrementally — after each commit, only changed files are re-summarized.

### As a standalone CLI

Configure an LLM provider once:

```bash
mason set-llm claude sk-ant-xxx        # Anthropic
mason set-llm gemini AIza-xxx          # Google (free tier available)
mason set-llm openai sk-xxx            # OpenAI
mason set-llm ollama                   # Local, no API key needed
```

Then generate:

```bash
mason generate                         # current directory
mason generate ~/my-project            # specific directory
mason generate --model claude-haiku-4-5-20251001  # override model
```

### Just analyze (no LLM needed)

```bash
mason analyze                          # print git history findings
```

## How it works

Mason's philosophy: **the LLM is smart, Mason is fast.** Instead of trying to understand your code (badly, with regex), Mason does what LLMs can't do cheaply:

1. **Aggregate stats** across hundreds of commits — stale directories, hot files, commit conventions
2. **Select the right files** — architecturally important files the LLM should read, based on naming patterns (ViewModel, Repository, Service, Module, UseCase, etc.)
3. **Pair interfaces with implementations** — surfaces both `WeatherRepository.kt` and `WeatherRepositoryImpl.kt`
4. **Include module build files** — so the LLM can infer the dependency graph itself
5. **Map tests to source** — structural test coverage analysis
6. **Persist knowledge** — snapshot summaries survive across conversations, eliminating cold-start token waste

The LLM does all the interpretation — identifying conventions, understanding patterns, writing rules. Mason just makes sure it sees the right files and remembers what it learned.

## Smart file sampling

Mason doesn't dump your whole repo. It picks ~25 files across these categories:

- **Config files** — build configs, linter configs, version catalogs
- **Module build files** — subdirectory build files that reveal dependency graphs
- **Entry points** — main files, app entry points
- **Hot files** — most frequently changed in the last 3 months (from git)
- **Architectural files** — ViewModels, Repositories, Services, DI Modules, UseCases, Mappers, Controllers, Middleware
- **Both interfaces and implementations** — `*Repository.*` and `*RepositoryImpl.*`
- **Test examples** — diverse across languages (JVM, Swift, Python, Go, etc.)
- **Directory representatives** — one source file per top-level directory for breadth

All files are returned as previews (~60 lines) with metadata. The LLM can request full content of any file it wants to dig into.

## Language support

Mason is completely language-agnostic. It works with any project that has source files and a git history:

- TypeScript/JavaScript (React, Node, etc.)
- Kotlin (Android, KMP, server)
- Java (Spring, Android)
- Python (Django, FastAPI, etc.)
- Go
- Rust
- Swift (iOS, SwiftUI)
- Ruby, C#, C++, Dart, and more

No language-specific parsing — the architectural file selection works by naming conventions that are common across ecosystems.

## License

MIT
