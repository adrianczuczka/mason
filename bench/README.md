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
# Set your API key and target project
export ANTHROPIC_API_KEY=sk-ant-...
export PROJECT_DIR=/path/to/project/with/mason/snapshot

# Run the benchmark
mcp-eval run tests/
```

The target project must have a Mason snapshot (`.mason/snapshot.json`).

## What it tests

7 tests across 3 zoom levels:

| Level | Test | What it measures |
|---|---|---|
| **HIGH** | architecture | Can Mason explain the project structure? |
| **HIGH** | features | Can Mason list all features with files? |
| **MID** | data_flow | Can Mason trace a flow end-to-end? |
| **MID** | impact | Does get_impact find affected files? |
| **LOW** | function_detail | Can Mason + code reading describe function internals? |
| **LOW** | blind_spot | Can the agent find files NOT in the snapshot? |
| **LOW** | git_analysis | Does analyze_project return useful git stats? |

### Expected results

- **HIGH**: should pass — this is what the snapshot is designed for
- **MID**: should pass — snapshot navigates, agent reads files
- **LOW**: mixed — tests Mason's limitations honestly

## Configuration

- Edit `mcpeval.yaml` to change the model or provider
- Create `mcpeval.secrets.yaml` with your API key (not committed)
- The server path in `mcpeval.yaml` assumes you run from the `bench/` directory
