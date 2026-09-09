# Hook performance

[← Mason](../README.md)

Lifecycle hooks are synchronous and still spawn a process for each event. Known read-only tools now record lifecycle observations without running the audit inventory, verifier, or execution receipt writer. These observations do not refresh the last audit verdict. Shell, editor, unknown, and MCP tools retain before/after evidence checks; session start, prompt submission, and stop still check the repository. Narrowing to editor tools or removing pre-tool capture would lose shell edits or their original evidence.

## Parallel tool calls

Repository inspection and audit verification run outside the shared state lock. Calls with matching inputs that overlap a successful check reuse its analysis, then recheck their inputs and merge their own lifecycle events. Calls inspecting different inputs can run concurrently; a result assembled across changed inputs or superseded evidence cannot replace newer state. A pre-tool hook still waits for its evidence and receipt before returning. This does not turn synchronous pre-edit capture into a background check.

State and execution-log locks cover short metadata updates. Each active invocation has a separate ownership receipt, so read-only observations can finish while a check is running and state-lock failures can still be recorded. The execution history retains up to 128 active calls plus 32 finished attempts. A success that started before another call failed does not establish recovery from that failure.

Identical recorded failures are reported once per session until recovery; repeat counts and recent execution failures remain visible in `mason status --json`. Failures without a durable receipt remain visible on every occurrence. Unknown MCP tools remain conservative, including Jira-shaped calls; names containing `search` or `get` are not treated as proof that a tool cannot edit files. Waiting for equivalent work is bounded within a 25-second coordination budget; the host's 30-second timeout can still interrupt a slow invocation.

The concurrency regressions cover a check delayed beyond five seconds with eight overlapping MCP pre-tool calls, independent read observations, six parallel CLI processes per pre/post phase, changed-input races, and failure recording and deduplication. These are controlled local checks, not measurements of the reported workplace repository or live Jira sessions.

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

`mason status` execution durations now include receipt work, coordination waits, and checking after workspace discovery. The historical measurements above used the earlier duration boundary after lock acquisition. Read-only observations do not add a check execution receipt. Use the benchmark for total CLI overhead, and real host trials for perceived task latency and activation behavior.
