# Finding delivery diagnostic, revision 2

## Frozen before live execution

Nine sessions: `rename-root`, `rename-nested`, and `rename-backlog`, once in each of baseline, instructions/tools, and instructions/tools/hooks. Same seeded randomized order, Opus 5.5, medium effort, 180 seconds, and $0.50 per session. Maximum configured cost: $4.50. This is a separate diagnostic batch; do not pool it with the first calibration.

The three renames now have references in README.md, docs/integration.md, and docs/operations.md. All conditions receive the same request to migrate source and verify `node app.mjs` before completing project cleanup. The backlog variant also contains an unrelated missing legacy path that must remain untouched.

That staged workflow intentionally creates an opportunity for a transient finding. It tests delivery and subsequent behavior, not how often organic tasks produce findings. Agents may still choose to repair everything in one tool call; retain such runs without resampling. Baseline successes and ignored notices must remain in the report.

Primary outcome: executable behavior, public API, and all affected documentation correct, with no unrelated changes. Secondary observations: notice delivery, which files remain stale at delivery, subsequent edits, additional tool calls, reported cost, and elapsed time. A notice followed by repair is a temporal observation; the agent might already have planned that repair. Three related tasks with one repeat cannot establish general effectiveness.

## Validation

Deterministic validation of all nine cells passed. Each hook condition delivered at least one agent-visible missing-path finding after source migration and before documentation repair. This verifies the mechanism, not model behavior. The grader also checks secondary docs even when Mason does not report them.

The regression suite checks task selection preserves matched blocks, secondary stale docs fail grading, and a real hook observer delivers the missing-path notice during staged replay.

```sh
npm run bench:behavior -- --live --tasks rename-root,rename-nested,rename-backlog --repeats 1 --output bench/harness/results/behavior/delivery-v2-20260928 --limit 9
```

Stop after this batch and inspect outcomes before any larger run.

## Live results — 2026-09-28

All nine sessions completed on the requested model with valid integration, correct executable behavior and documentation, and no scope violations. Reported total cost: **$0.732076**. No additional sessions were started.

| Condition | Passed | Reported cost, 3 runs | Mean session time | Total tool calls |
|---|---:|---:|---:|---:|
| Baseline | 3/3 | $0.1460 | 14.5 seconds | 12 |
| Instructions/tools | 3/3 | $0.2822 | 15.4 seconds | 13 |
| Instructions/tools/hooks | 3/3 | $0.3039 | 20.0 seconds | 13 |

All three hook runs delivered one notice after source migration. Each agent's next tool call updated README.md and both secondary docs and reran checks. The nested and root variants explicitly acknowledged the findings in their final responses. The backlog variant repaired the relevant references and preserved the unrelated legacy reference. The root variant considered a coverage advisory and left AGENTS.md unchanged, avoiding an unrelated edit.

This is evidence of successful delivery and appropriate subsequent behavior. It does not show that the notices caused those edits: the task explicitly requested cleanup after migration, and both comparison conditions also succeeded. There is no observed final-correctness improvement in this sample. Hooks cost about $0.022 more across three sessions and averaged 4.6 seconds longer than instructions/tools alone; these are descriptive measurements from a small synthetic sample, not reliable production overhead estimates.

Raw evidence is retained under `bench/harness/results/behavior/delivery-v2-20260928/`: report.json, report.md, transcripts, hook/MCP receipts, and review packets. `trace-review.json` records per-run metrics and the tool calls following each finding. All original grades passed; no post-run grading correction was needed.

Validation: 39 tests across the behavior, knowledge, and automation benchmark suites passed; typecheck and whitespace checks passed. The nine deterministic validation cells passed before live execution.

## Decision

Do not expand this rename study to 90 sessions yet. These tasks have a ceiling effect: every condition succeeds. The next useful experiment should use a fixed set of actual repository changes with dispersed references and realistic task scope, selected before looking at condition outcomes. Include baseline successes and failures. For saved lessons, test a subsequent task that needs the recorded evidence; counting proposals cannot establish usefulness.

The first calibration's incident outputs were also reviewed against their source in [INCIDENT_REVIEW.md](INCIDENT_REVIEW.md). That review is unblinded and does not replace independent semantic scoring.
