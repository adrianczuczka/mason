# Hook performance

[← Mason](../README.md)

Lifecycle hooks are synchronous and still spawn a process for each event. Known read-only tools now record lifecycle observations without running the audit inventory, verifier, or execution receipt writer. These observations do not refresh the last audit verdict. Shell, editor, unknown, and MCP tools retain before/after evidence checks; session start, prompt submission, and stop still check the repository. Narrowing to editor tools or removing pre-tool capture would lose shell edits or their original evidence.

## Repeated calls and retained repairs

One invocation shares its current audit across retained repair baselines. Document status is collected in bounded batches, document history reads have bounded concurrency, and documents with the same last commit share their change history. Each baseline keeps its original findings, scope, and outcomes.

The development implementation also shares a Git inventory between document and source discovery within the initial inspection. Module ignore queries are collected by directory level in bounded batches. Identical history queries share their raw output only within that inspection, preserving exact arguments, scope and read limits; failed queries are not retained. Distinct document histories are not collapsed into one broader history query.

Automation performs a separate, fresh final inspection before publishing evidence. Its full input validation replaces overlapping repair discovery; standalone repair commands retain their own stability guards. The final inventory, ignore rules, document contents and review records cannot be served from the initial inspection's memoized reads. Each invocation has independent inspection state, including concurrent calls on the same repository. Explicit ignored paths and selected symlinks retain their original checks.

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

## Git inventory follow-up: 2026-09-15

The workplace profile of 0.17.3 exposed repeated discovery even when the audit was reusable. A new wide fixture reproduces seven document/source inventory calls and 26 ignore queries per warm event. The development implementation reduces those to two inventories (initial and final) and four ignore queries. In the partial-check fixture, total Git calls fall from 74 to 46; its 14 distinct history queries remain necessary and are not combined.

The comparison below uses Apple Silicon macOS, the packaged Node v24.20.0 runtime, the Claude adapter, 12 top-level modules and one deliberately skipped command check. Both builds use the same fixtures and benchmark instrumentation, run sequentially with three pre/post pairs per category. Values are **combined pre/post overhead**. The baseline is the unmodified 0.17.3 build.

| Wide fixture with a skipped check | 0.17.3 p50 / p95 | Development p50 / p95 |
|---|---|---|
| Native Git, one baseline | 832.9 / 838.5 ms | 604.7 / 606.2 ms |
| Native Git, four baselines | 854.3 / 860.6 ms | 662.5 / 663.2 ms |
| Delayed inventory, one baseline | 2,926.1 / 2,946.5 ms | 1,189.9 / 1,193.2 ms |
| Delayed inventory, four baselines | 2,961.4 / 2,965.6 ms | 1,218.7 / 1,227.5 ms |

The delayed case adds 100 ms and a Node worker's startup to each inventory call. It demonstrates sensitivity to repeated Git reads, not the latency expected on another machine. Three pairs make p95 the maximum observed pair. All runs preserved original baseline bytes, resolved the three reference deletions through the final commit, and retained three decision advisories plus the skipped check. Final status correctly remained incomplete.

These measurements show reduced subprocess work, but do not establish comfortably subsecond pairs on the workplace repository. That repository and the actual host still need a follow-up measurement. No hook lifecycle stage or pre-edit evidence capture was removed to obtain these results.

## Reproduce

```sh
npm run build
npm run bench:hooks
# Shorter large-repository run with phase timings:
node scripts/bench-hooks.mjs --fixture large --samples 3 --profile
# Compare a separately saved build, preserving its neighboring dist files:
node scripts/bench-hooks.mjs --binary /path/to/previous/dist/mason.js --label before
# Many top-level modules, including a check that must retry:
node scripts/bench-hooks.mjs --fixture wide --host claude --samples 3 --partial-check --git-metrics
# Repeat against both builds with slower inventory reads:
node scripts/bench-hooks.mjs --fixture wide --host claude --samples 3 --partial-check --git-delay-ms 100 --git-delay-command inventory
# Select a packaged Node runtime for both sides of a comparison:
node scripts/bench-hooks.mjs --runtime /path/to/bundle/node --fixture wide --samples 3
```

The benchmark uses isolated temporary Git repositories and the built CLI, makes no model calls, reports p50/p95/max and paired pre/post overhead, and removes its fixtures. By default it runs both host adapters with small, large and wide fixtures. The large fixture contains 1,001 source files, 20 package READMEs, 20 valid decision records and 10,000 ignored build-cache files. The wide fixture has 12 top-level modules with their own README and ignore file, 601 source files, 12 decision records and 10,000 ignored files. Expanded fixtures measure one baseline, then four retained baselines created by actual source deletions. All fixtures exercise documentation repair through a final commit and assert that original baseline bytes remain intact. Outstanding decision reviews remain outstanding.

`--partial-check` adds one command whose directory cannot be resolved. The benchmark requires that specific skipped check, retries it on subsequent calls, and retains incomplete status through the final commit. It does not count that scenario as fully verified. `--git-metrics` records each Git subprocess's command family, duration and inventory classification without arguments, paths or output. Unlike the in-CLI profile, this benchmark instrumentation also sees Git calls during the managed setup lookup.

`--git-delay-ms 0..500` enables metrics and adds a delay to Git subprocesses. `--git-delay-command inventory` limits it to document/source inventories; the default `all` delays every Git command. Delayed queries run through an additional Node worker, which also adds startup overhead. These are comparative stress scenarios, not estimates of workplace latency. Use the same delay, fixture and runtime for both builds. The instrumentation lives only in the benchmark and is not shipped or enabled in normal Mason commands.

`--samples 10` produces 20 pre/post invocations per category. `--fixture small|large|wide|all` and `--host claude|codex|all` select workloads. Version, platform and the selected runtime's version are included in its JSON. It does not read the caller's project or automatically report metrics anywhere. Use the same fixtures, sample count, runtime and environment for comparisons. Wall-clock results are measurements, not portable CI thresholds; the regression tests separately enforce inventory/query budgets, audit reuse and evidence correctness.

## Profile a local check

```sh
mason check --json --profile
```

`--profile` adds one `mason-profile` JSON record on stderr. Normal results remain on stdout. It reports fixed phase names, invocation counts and elapsed milliseconds without document contents, paths, commands or session identifiers. It performs the normal check, including local evidence writes; it does not upload metrics. Profiling is off by default and also works on `mason auto hook --host claude|codex --profile` with a normal hook payload on stdin. Generated hook configuration is unchanged.

Phase times are inclusive and can overlap, especially parallel Git reads; do not add them together. The CLI profile starts after argument parsing and input reading, so use the external benchmark for process startup and total invocation overhead. The development build adds `git.ls-files`, `git.check-ignore`, `git.log` and other fixed command-family labels for the Git subprocesses used by automation. Their `calls` counts exclude memoized reuse. `automation.git` and document-history timings remain inclusive parent phases; do not add them to their child Git times. These labels cover the profiled check/hook operation, not earlier managed setup lookup or unrelated Mason commands.

`mason status` execution durations now include receipt work, coordination waits, and checking after workspace discovery. The historical measurements above used the earlier duration boundary after lock acquisition. Read-only observations do not add a check execution receipt. Use the benchmark for total CLI overhead, and real host trials for perceived task latency and activation behavior.
