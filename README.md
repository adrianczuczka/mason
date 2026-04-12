# Mason

Context engineering for AI coding assistants. Mason gives LLMs a persistent map of your codebase so they stop exploring from scratch every session.

**The problem:** Every time an LLM starts a new conversation about your code, it greps, reads files, and pieces together the architecture — burning tokens on context it already understood yesterday.

**Mason's fix:** A concept map that persists across sessions. One tool call returns a feature-to-file lookup table. The LLM knows exactly where to look.

**Measured result** ([deepeval](https://github.com/confident-ai/deepeval), Claude Sonnet, 164-file KMP project):

| Question | With Mason | Without Mason | Token saving |
|---|---|---|---|
| List all features | 10,258 tok | 31,346 tok | **67%** |
| Trace data flow | 12,010 tok | 15,258 tok | **21%** |
| Compare platforms | 10,897 tok | 19,353 tok | **44%** |
| Onboarding flow | 10,271 tok | 11,432 tok | **10%** |
| **Average** | | | **36%** |

Same answer quality (0.9/1.0 on all tests, both paths). Reproduce: [bench/](bench/).

## Quick start

```bash
claude mcp add mason --scope user -- npx mason-context mcp
```

Restart Claude Code, then: *"use mason to analyze this project and create a snapshot."*

## How it works

### Concept map

Mason persists a feature-to-file map in `.mason/snapshot.json`. Instead of exploring, the LLM looks up which files implement each feature:

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

Create one by asking your AI assistant to *"create a mason snapshot"*, or via CLI:

```bash
mason set-llm gemini          # configure a provider (no API key needed)
mason snapshot ~/my-project   # generate concept map
mason snapshot --install-hook # auto-update on every commit
```

### Change impact analysis

Before editing a file, see what else might break:

```
mason impact WeatherRepository.kt -d ~/my-project
```

Returns: files that historically change together, files that reference the target, and related tests.

### Git history analysis

Aggregates hundreds of commits into actionable stats — frequently changed files, stale directories, commit conventions. The kind of analysis that would take dozens of `git log` calls.

## MCP tools

| Tool | What it does |
|---|---|
| `get_snapshot` | Load the concept map — maps features/flows to files |
| `save_snapshot` | Persist the concept map for future sessions |
| `get_impact` | Change impact: co-change history, references, related tests |
| `analyze_project` | Git history: commit patterns, hot files, stale dirs |
| `full_analysis` | All-in-one first visit: git stats + structure + code samples + test map |
| `get_code_samples` | Smart file previews by architectural role |

## CLI usage

```bash
mason generate                # analyze + LLM -> CLAUDE.md
mason analyze                 # git stats only (no LLM needed)
mason impact File.kt          # change impact analysis
mason snapshot                # create/update concept map
mason set-llm claude|gemini|ollama|openai  # configure provider
```

## Language support

Language-agnostic. Works with any project that has source files and git history — TypeScript, Kotlin, Python, Go, Rust, Swift, Java, and more.

## License

MIT
