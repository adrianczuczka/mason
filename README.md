# Mason

A context engineering tool that helps LLMs understand your codebase. Mason handles the expensive parts — aggregating git history, selecting architecturally important files, mapping dependencies, and persisting project knowledge — so the LLM can focus on thinking.

Works as an **MCP server** (for Claude Code, Cursor, etc.) or as a **standalone CLI** with any LLM provider.

## Quick start

```bash
npx mason-context mcp                    # start MCP server
claude mcp add mason -- npx mason-context mcp   # register with Claude Code
```

Restart Claude Code, then ask: "use mason to analyze this project and generate a CLAUDE.md."

## Install

```bash
npm install -g mason-context
```

## Usage

### As an MCP server (recommended)

Register with Claude Code:

```bash
claude mcp add mason --scope user -- npx mason-context mcp
```

Then ask Claude to generate a CLAUDE.md — it will call Mason's tools automatically.

Mason exposes 6 tools via MCP:

| Tool | What it does |
|---|---|
| `get_snapshot` | Load persistent concept map — maps features/flows to implementing files |
| `save_snapshot` | Save concept map for future sessions (no API key needed) |
| `get_impact` | Change impact analysis — co-change history, references, and related tests |
| `analyze_project` | Git history stats (commit patterns, stale dirs, hot files) |
| `full_analysis` | All-in-one: git stats + project structure + code samples + test map + concept map |
| `get_code_samples` | Smart file previews — config, entry points, architectural patterns, tests |

### Concept map (persistent snapshot)

Mason persists a concept-to-files map across conversations. Instead of the LLM exploring your codebase from scratch every session, the concept map tells it exactly which files implement each feature and how data flows through the system.

```json
{
  "features": {
    "home screen": {
      "files": ["HomeScreen.kt", "HomeViewModel.kt", "HomeModule.kt"]
    }
  },
  "flows": {
    "weather fetch": {
      "chain": ["HomeViewModel.kt", "GetWeatherDataUseCase.kt", "WeatherRepositoryImpl.kt"]
    }
  }
}
```

**Benchmark results** (mcp-eval, Claude Sonnet, 164-file KMP project):

| Level | Tests | Pass rate | What it measures |
|---|---|---|---|
| HIGH (architecture) | 2 | 2/2 | Can Mason explain modules, features, tech stack? |
| MID (flows/impact) | 2 | 2/2 | Can Mason trace data flows and find affected files? |
| LOW (code detail) | 3 | 1/3 | Can Mason help with function-level questions? |

Mason is a navigation tool — it tells you where to look, not what the code says. HIGH and MID tasks pass because the snapshot provides the right context. LOW tasks fail when they require reading code the snapshot doesn't cover.

Reproduce with `cd bench && PROJECT_DIR=/your/project mcp-eval run tests/` (see [bench/README.md](bench/README.md)).

**Via MCP:** Ask your AI assistant to "create a mason snapshot." It analyzes the codebase and calls `save_snapshot`. Next session, `get_snapshot` loads instantly.

**Via CLI:**

```bash
mason set-llm gemini                   # configure a provider (no API key needed)
mason snapshot ~/my-project            # generate concept map
mason snapshot --install-hook          # auto-update on every commit
```

### Change impact analysis

Before editing a file, see what else might be affected:

```bash
mason impact WeatherRepository.kt -d ~/my-project
```

Returns three signals:
- **Co-change** — files that historically change together in git commits
- **References** — files that mention the target by name (imports, usage)
- **Tests** — test files paired to the target

Also available as the `get_impact` MCP tool.

### Standalone CLI

Configure an LLM provider once:

```bash
mason set-llm claude                   # uses Claude CLI (no API key needed)
mason set-llm gemini                   # uses Gemini CLI (no API key needed)
mason set-llm ollama                   # local Ollama (no API key needed)
mason set-llm openai sk-xxx           # OpenAI API (needs key)
```

Then generate:

```bash
mason generate                         # analyze + LLM → CLAUDE.md
mason generate ~/my-project
mason generate --model claude-haiku-4-5-20251001
```

### Just analyze (no LLM needed)

```bash
mason analyze                          # print git history findings
```

## How it works

Mason's philosophy: **the LLM is smart, Mason is fast.** Mason does what LLMs can't do cheaply:

1. **Aggregate stats** across hundreds of commits — stale directories, hot files, commit conventions
2. **Select the right files** — architecturally important files based on naming patterns (ViewModel, Repository, Service, Module, UseCase, etc.)
3. **Pair interfaces with implementations** — surfaces both `WeatherRepository.kt` and `WeatherRepositoryImpl.kt`
4. **Include module build files** — so the LLM can infer the dependency graph itself
5. **Map tests to source** — structural test coverage analysis
6. **Persist knowledge** — concept maps survive across conversations, eliminating cold-start token waste
7. **Analyze change impact** — co-change history and reference scanning to find affected files

The LLM does all the interpretation. Mason makes sure it sees the right files.

## Smart file sampling

Mason picks ~25 representative files across these categories:

- **Config files** — build configs, linter configs, version catalogs
- **Module build files** — subdirectory build files that reveal dependency graphs
- **Entry points** — main files, app entry points
- **Hot files** — most frequently changed in the last 3 months (from git)
- **Architectural files** — ViewModels, Repositories, Services, DI Modules, UseCases, Mappers, Controllers, Middleware
- **Both interfaces and implementations** — `*Repository.*` and `*RepositoryImpl.*`
- **Test examples** — diverse across languages (JVM, Swift, Python, Go, etc.)
- **Directory representatives** — one source file per top-level directory for breadth

All returned as previews (~60 lines). The LLM reads full files natively when it needs more detail.

### Custom patterns

If your project uses different naming conventions, configure per-project:

```json
// .mason/config.json
{
  "patterns": ["**/*Gateway.*", "**/*Bloc.*", "**/*Cubit.*"],
  "alwaysInclude": ["src/core/config.ts", "lib/injection.dart"],
  "ignore": ["**/fixtures/**", "**/mocks/**"]
}
```

Or write this file directly — the LLM can create `.mason/config.json` using its native file writing.

## Language support

Mason is completely language-agnostic. No language-specific parsing — it works with any project that has source files and a git history:

TypeScript, JavaScript, Kotlin, Java, Python, Go, Rust, Swift, Ruby, C#, C++, Dart, and more.

## License

MIT
