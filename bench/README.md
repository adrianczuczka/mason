# Mason Benchmark

Uses [deepeval](https://github.com/confident-ai/deepeval) to measure Mason's token savings and answer quality.

## What it does

For each question, calls Claude twice with realistic context:
- **Path A** — Mason snapshot + 3 targeted file reads (the real Mason workflow)
- **Path B** — 8-10 files an agent would find via grep (realistic no-Mason)

Both answers are scored with the same quality rubric (GEval + MCPUseMetric).

## Setup

```bash
uv tool install deepeval --with anthropic
# or: pip install deepeval anthropic
```

## Run

```bash
cd bench
PROJECT_DIR=/path/to/project ANTHROPIC_API_KEY=sk-... deepeval test run tests/test_mason.py
```

The target project must have a Mason snapshot (`.mason/snapshot.json`).

## What it tests

4 questions, each as A/B pair (8 tests total):

| Question | Path A context | Path B context |
|---|---|---|
| Architecture | snapshot + 3 build files | 10 build/config files |
| Features | snapshot + 3 nav/entry files | 8 screen files |
| Data flow | snapshot + 3 key chain files | 8 flow chain files |
| Feature lookup | snapshot + 3 location files | 8 location files |

## Output

1. **Token savings table** — shows input tokens for A vs B per question
2. **Quality scores** — deepeval GEval (0-1) for both paths
3. **MCP Use score** — did the snapshot provide relevant info?
