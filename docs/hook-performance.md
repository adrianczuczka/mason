# Hook performance

[← Mason](../README.md)

Lifecycle hooks are synchronous and still spawn a process for each event. Known read-only tools now record lifecycle observations without running the audit inventory, verifier, or execution receipt writer. These observations do not refresh the last audit verdict. Shell, editor, unknown, and MCP tools retain before/after evidence checks; session start, prompt submission, and stop still check the repository. Narrowing to editor tools or removing pre-tool capture would lose shell edits or their original evidence.

## Development measurement: 2026-09-09

Apple Silicon macOS, Node v25.9.0, one source file plus generated instructions, 20 invocations per tool category and host adapter. Compared the saved 0.16.1 build with the development implementation for 0.16.2, using identical benchmark code and fixture construction. Numbers include Node startup, setup lookup, Git operations, and receipt work. They exclude host dispatch, the outer shell availability guard, and assistant/model time. The two builds ran sequentially; this is a small local measurement, not a controlled population estimate or large-repository test.

| Adapter / invocation | Before p50 / p95 | After p50 / p95 |
|---|---|---|
| Claude, known read-only | 398.2 / 403.4 ms | 142.8 / 146.4 ms |
| Codex, known read-only | 401.2 / 481.1 ms | 143.3 / 147.9 ms |
| Claude, cached potentially mutating tool | 397.8 / 402.5 ms | 355.2 / 360.0 ms |
| Codex, cached potentially mutating tool | 401.5 / 482.5 ms | 356.6 / 361.0 ms |

A tool normally causes both pre- and post-tool invocations, so account for both. Mutation samples used a shell-class event with unchanged inputs to measure cache reuse; the separate rename regressions verify actual edits and final-commit repair. The packaged runtime and other machines can produce different timings. The 30-second hook timeout remains a ceiling, not a latency target.

## Reproduce

```sh
npm run build
npm run bench:hooks
# Compare a separately saved build, preserving its neighboring dist files:
node scripts/bench-hooks.mjs --binary /path/to/previous/dist/mason.js --label before
```

The benchmark uses isolated temporary Git repositories and the built CLI, makes no model calls, reports p50/p95/max, and removes its fixtures. `--samples 10` produces 20 pre/post invocations per category. Version and platform are included in its JSON. It does not read the caller's project or automatically report metrics anywhere.

`mason status` execution durations cover check work after lock acquisition, not the full invocation measured here. Read-only observations do not add a check execution receipt. Use the benchmark for total CLI overhead, and real host trials for perceived task latency and activation behavior.
