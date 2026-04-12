# Mason Benchmark

Uses [mcp-eval](https://mcp-eval.ai/) to test Mason's MCP tools against a real codebase.

## Setup

```bash
# Install mcp-eval
pip install mcpevals
# or: uv tool install mcpevals

# Build Mason
cd .. && npm run build && cd bench
```

## Run

```bash
# Set required env vars
export ANTHROPIC_API_KEY=sk-ant-...
export PROJECT_DIR=/path/to/project/with/mason/snapshot

# Run the benchmark
mcp-eval run tests/
```

The target project must have a Mason snapshot (`.mason/snapshot.json`).

## What it tests

8 tests across 4 categories:

| Category | Test | What it measures |
|---|---|---|
| **Orientation** | architecture | Can Mason explain modules, dependencies, tech stack? |
| **Orientation** | features | Can Mason list features with implementing files? |
| **Navigation** | data_flow | Does the snapshot trace data flows correctly? |
| **Navigation** | feature_lookup | Can Mason find a feature's files, then drill in? |
| **Efficiency** | fast_answer | Can Mason answer architecture questions in <4 iterations? |
| **Analysis** | git_stats | Does analyze_project surface commit patterns and hot files? |
| **Analysis** | impact | Does get_impact find affected files before a change? |

## Configuration

- Edit `mcpeval.yaml` to change the model or provider
- Create `mcpeval.secrets.yaml` with your API key (not committed)
- The server path in `mcpeval.yaml` assumes you run from the `bench/` directory
