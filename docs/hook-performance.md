# Hook performance

[← Mason](../README.md)

Lifecycle hooks are synchronous and still spawn a process for each event. Known read-only tools now record lifecycle observations without running the audit inventory, verifier, or execution receipt writer. These observations do not refresh the last audit verdict. Shell, editor, unknown, and MCP tools retain before/after evidence checks; session start, prompt submission, and stop still check the repository. Narrowing to editor tools or removing pre-tool capture would lose shell edits or their original evidence.

## Repeated calls and retained repairs

One invocation shares its current audit across retained repair baselines. Document status is collected in bounded batches, document history reads have bounded concurrency, and documents with the same last commit share their change history. Each baseline keeps its original findings, scope, and outcomes.

Consecutive calls with matching inputs can reuse a complete current audit. The stored audit and check cache must validate; skipped checks are retried. Missing derived audit caches are rebuilt. Invalid JSON, schema or checksums are reported while rebuilding; the next successful check clears that diagnostic. Original baselines are retained and validated independently. Unsafe cache paths, symlinks and storage-access failures remain errors. Input fingerprints include documentation contents, scoped repository dependencies, decision records, review records, Git state and the engine version. Relevant ignored paths are still observed explicitly. File timestamps or an unchanged Git status alone do not establish reuse.

Review outcomes and original history are checked again even when the current audit is reused. A review can refer to a path that newer documentation no longer mentions: reusing an earlier resolved verdict could miss that original scope changing. Results expose `checks.auditReused` separately from individual reused checks and overlapping-call sharing. Every mutating event still records its own lifecycle and execution receipt. Changed inputs, modified original baselines, and concurrent review edits prevent publication as current evidence.

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

## Development measurement: 2026-09-15

The larger fixture reproduced the repeated-audit problem: with four retained baselines, each unchanged invocation prepared four current audits. The development implementation prepares one audit when inputs change and reuses the current audit on unchanged sequential calls while verifying original history and assessments again.

Apple Silicon macOS, Node v25.9.0, Git 2.54.0 selected through Command Line Tools. Compared the 0.17.2 implementation with timing instrumentation against the development changes, using the same synthetic large fixture and three pre/post pairs per category. Values below are **combined pre/post overhead**, excluding the tool itself.

| Claude adapter, large fixture | Before p50 / p95 | After p50 / p95 |
|---|---|---|
| Unchanged inputs, one baseline | 2,411.1 / 2,422.7 ms | 975.7 / 983.9 ms |
| Unchanged inputs, four baselines | 6,940.5 / 6,969.9 ms | 1,018.5 / 1,020.6 ms |

The Codex adapter's development run measured 986.4 / 1,046.4 ms with one baseline and 1,027.2 / 1,128.3 ms with four. Both adapters resolved the three deleted-reference findings after the final documentation commit, preserved every original baseline, and left the three decision advisories requiring review. No decision was approved by the benchmark.

These are short sequential measurements on one machine; with three pairs, p95 is the maximum observed pair. They include startup and managed hook setup lookup, but exclude host dispatch and the outer shell guard. They are not workplace-repository or live-agent measurements. The large fixture is around one second per unchanged pair; it has **not** established the target of comfortably below one second across representative repositories. Validate the actual host workflow before broad rollout.

## Reproduce

```sh
npm run build
npm run bench:hooks
# Shorter large-repository run with phase timings:
node scripts/bench-hooks.mjs --fixture large --samples 3 --profile
# Compare a separately saved build, preserving its neighboring dist files:
node scripts/bench-hooks.mjs --binary /path/to/previous/dist/mason.js --label before
```

The benchmark uses isolated temporary Git repositories and the built CLI, makes no model calls, reports p50/p95/max and paired pre/post overhead, and removes its fixtures. By default it runs both host adapters with small and large fixtures. The large fixture contains 1,001 source files, 20 package READMEs, 20 valid decision records and 10,000 ignored build-cache files. It measures one baseline, then four retained baselines created by actual source deletions. Both fixtures exercise documentation repair through a final commit and assert that original baseline bytes remain intact. Outstanding decision reviews remain outstanding.

`--samples 10` produces 20 pre/post invocations per category. `--fixture small|large|all` and `--host claude|codex|all` select workloads. Version and platform are included in its JSON. It does not read the caller's project or automatically report metrics anywhere. Use the same fixtures, sample count, runtime and environment for comparisons. Wall-clock results are measurements, not portable CI thresholds; the regression tests separately enforce audit reuse and evidence correctness.

## Profile a local check

```sh
mason check --json --profile
```

`--profile` adds one `mason-profile` JSON record on stderr. Normal results remain on stdout. It reports fixed phase names, invocation counts and elapsed milliseconds without document contents, paths, commands or session identifiers. It performs the normal check, including local evidence writes; it does not upload metrics. Profiling is off by default and also works on `mason auto hook --host claude|codex --profile` with a normal hook payload on stdin. Generated hook configuration is unchanged.

Phase times are inclusive and can overlap, especially parallel Git reads; do not add them together. The CLI profile starts after argument parsing and input reading, so use the external benchmark for process startup and total invocation overhead. `automation.git` measures the automation module's Git calls; document-history timing is reported separately and is not a count of every Git command in Mason.

`mason status` execution durations now include receipt work, coordination waits, and checking after workspace discovery. The historical measurements above used the earlier duration boundary after lock acquisition. Read-only observations do not add a check execution receipt. Use the benchmark for total CLI overhead, and real host trials for perceived task latency and activation behavior.
