# Hook performance

[← Mason](../README.md)

Lifecycle hooks are synchronous and still spawn a process for each event. Known read-only tools now record lifecycle observations without running the audit inventory, verifier, or execution receipt writer. These observations do not refresh the last audit verdict. Shell, editor, unknown, and MCP tools retain before/after evidence checks; session start, prompt submission, and stop still check the repository. Narrowing to editor tools or removing pre-tool capture would lose shell edits or their original evidence.

Subsecond combined pre/post overhead is an aspirational performance goal, not an acceptance requirement or a reason to weaken verification. The current correctness improvements are retained despite exceeding that goal in the public repository measurements below. Further optimization should be guided by observed interruptions in real host use, accounting for how often hooks run and the cost of the tool itself. Wall-clock benchmark results are not CI pass/fail thresholds.

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

## Captured anchor measurement: 2026-10-06

Apple Silicon macOS, Node v25.9.0, Claude adapter, the synthetic large fixture, and three sequential pre/post pairs per category. These are whole CLI timings including startup, with phase profiling and Git metrics enabled; they exclude host dispatch and the outer shell guard. The legacy rows use v1 records on the development implementation, not a comparison against a previous release. Capture and inspection records are created through the public MCP tools.

The first capture implementation independently inventoried each decision on each evidence read. Twenty single-file proposals produced 82 inventory calls and 124 total `ls-files` calls per unchanged hook. Batched capture now shares policy, inventory and file hashes only within one repository inspection. Final validation uses a new inspection and must reread content. Captures keep their individual size bounds. Bulk file-policy checks avoid a separate glob walk and source read for every anchored file; bounded byte hashing and per-read symlink rejection remain in place.

| Decision evidence / scope | Unchanged pair p50 / p95 | Four retained baselines p50 / p95 |
|---|---|---|
| Legacy Git baseline, 20 individual files | 806.3 / 834.9 ms | 924.7 / 936.3 ms |
| First capture implementation, 20 individual files | 3,736.6 / 3,987.1 ms | 3,743.4 / 4,603.4 ms |
| Batched captures, 20 individual files | 1,127.1 / 1,167.1 ms | 1,107.8 / 1,111.6 ms |
| Legacy Git baseline, 20 directories | 820.6 / 856.0 ms | 824.6 / 829.7 ms |
| Batched captures, 20 directories / 1,000 files | 1,541.4 / 1,772.1 ms | 1,554.2 / 1,727.9 ms |
| Separate inspections, 20 directories / 1,000 files | 1,428.8 / 1,432.7 ms | 1,681.1 / 1,694.4 ms |

Captured and inspected scenarios now use four inventory calls and eight total `ls-files` calls per unchanged hook; counts do not scale with the 20 decision records in this fixture. Known read-only invocations measured 160–168 ms at p50 on the final scenarios and do not hash anchors. The benchmark preserved all original baseline bytes, resolved the three reference deletions, and left three reopened decision advisories outstanding. It did not claim human acceptance.

With three pairs, p95 is the maximum observed pair, and differences between nearby runs are not evidence that inspections are faster than captures. Content hashing adds measurable cost: approximately 0.32 seconds per pair for narrow captures and 0.61–0.72 seconds for the broader scopes in these runs. The development implementation still does **not** meet a consistently subsecond pair target. These synthetic results do not establish latency on the workplace repository or other machines; measure the actual host workflow before rollout.

## Path lookup and decision reuse: 2026-10-06

The next development change builds a path-component lookup for all anchor scopes and assigns inventory files in one pass. It replaces repeatedly searching the full inventory for each scope. Matching retains literal prefix boundaries, normalized paths, overlapping scopes, deduplication and inventory order. Its work scales with path components and actual matches rather than the product of scopes and inventory size.

Raw decision bytes and validated records are shared within one inspection. Automation fingerprints and the audit use the same raw observation, including malformed records. Callers receive independent copies, tool writes invalidate these observations, and final validation starts a fresh inspection. Symlink rejection and size limits remain in place. These changes do not use Git blob shortcuts or trust unchanged timestamps.

A CPU-only comparison against the original matching predicate produced identical results in every sample:

| Scopes / inventory files | Repeated matching median | Indexed matching median |
|---|---|---|
| 20 / 1,000 | 33.46 ms | 0.76 ms |
| 150 / 10,000 | 2,622.88 ms | 7.00 ms |

This measures path matching alone, with three samples and two overlapping anchors per scope. It excludes file reads, policy checks and CLI startup. It establishes the algorithm's scaling improvement, not whole-hook latency.

Sequential whole-CLI measurements used the same large fixtures, Node v25.9.0, Claude adapter, profiling and Git metrics, with three pairs per scenario. The previous build was saved before editing and both builds used the same installed dependencies.

| Scenario | Before pair p50 / p95 | After pair p50 / p95 |
|---|---|---|
| Narrow captures, one baseline | 1,118.8 / 1,386.6 ms | 1,031.6 / 1,053.4 ms |
| Narrow captures, four baselines | 1,079.8 / 1,085.2 ms | 1,022.5 / 1,107.4 ms |
| Directory inspections, one baseline | 1,412.4 / 1,529.2 ms | 1,502.8 / 1,506.1 ms |
| Directory inspections, four baselines | 2,020.8 / 2,028.4 ms | 1,657.6 / 2,056.1 ms |

Whole-hook results are mixed: the directory case with one baseline was slower, and three samples are insufficient to claim a general latency improvement. With three pairs p95 is the maximum observed pair. Inventory counts stayed at four per hook, original baseline bytes were preserved, the three reference issues resolved, and the three reopened decision advisories remained outstanding. The subsecond pair target is still unmet. The changes improve scaling and remove repeated decision reads; they do not remove the cost of reading anchored files or process startup.

## Public repository validation: 2026-10-06

The development build was exercised against full-history clones of two pinned public Android repositories, using Node v25.9.0 on Apple Silicon macOS and the Claude adapter:

- [Now in Android at a49ed253d75e61a2b6ab80a8da677b57437b08eb](https://github.com/android/nowinandroid/tree/a49ed253d75e61a2b6ab80a8da677b57437b08eb): 715 tracked files, including 310 Kotlin/Java files.
- [WordPress Android at ceafcdcbb4812eb10856dd789a0b11d3fe95eaa8](https://github.com/wordpress-mobile/WordPress-Android/tree/ceafcdcbb4812eb10856dd789a0b11d3fe95eaa8): 6,701 tracked files, including 4,166 Kotlin/Java files.

Each scenario creates 20 explicitly test-local proposals through the public MCP tools, with either individual source files or source directories as anchors. One proposal in each repository is grounded in its documentation: Now in Android's local-storage source of truth in `docs/ArchitectureLearningJourney.md`, and WordPress's activity titles for TalkBack in `docs/accessibility-guidelines.md`. The other proposals exercise anchored-change tracking; they do not claim project maintainer requirements or approval. Directory selection favors larger production source packages and avoids sensitive paths.

All four scenarios passed these assertions:

- Saving dirty source captures its current bytes; committing that source and its decision records together stays quiet.
- An unrelated commit stays quiet, while a later anchored edit reopens drift.
- A separate source inspection resolves the original advisory, leaving human approval, human review history and the original Git baseline unchanged.
- Original repair baseline bytes survive inspection and managed hooks unchanged.
- Another anchored edit reopens the inspected decision.

The source edits append recognizable comments. The runner verifies exact byte equality with the original source plus those comments before recording an inspection. This validates capture, inspection and audit lifecycle behavior on real repositories; it does not test detection of arbitrary semantic contradictions. The Android applications were not built, and no model or live coding agent was invoked.

Managed setup, SessionStart, UserPromptSubmit, read-only pre/post hooks, shell pre/post hooks and Stop were exercised with repository documentation in scope. Whole CLI timings include process startup and profiling, exclude host dispatch and network downloads, and use three unchanged shell pairs per scenario:

| Repository / anchor scope | Unique anchored files | Pair p50 / p95 | Read-only invocation p50 |
|---|---|---|---|
| Now in Android / individual files | 20 | 1,308.4 / 1,311.4 ms | 155.4 ms |
| Now in Android / directories | 142 | 1,452.4 / 1,535.6 ms | 160.7 ms |
| WordPress Android / individual files | 20 | 1,997.7 / 2,061.0 ms | 165.3 ms |
| WordPress Android / directories | 1,346 | 2,817.7 / 2,842.2 ms | 168.2 ms |

With three pairs, p95 is the maximum observed pair. These results validate the intended drift behavior but still miss the subsecond pair target, especially in the larger repository. They are not a before/after performance comparison. Both repository audits retained unrelated documentation findings requiring review, so their overall status remained `incomplete`; neither had skipped checks or diagnostics. Those findings were not assessed as project defects or cleared to make the benchmark pass.

Run `npm run build` followed by `npm run bench:open-source -- --samples 3`. The runner downloads full Git histories into the ignored `.mason/reports/benchmarks/oss-cache/` directory, verifies the pinned commits, creates isolated temporary clones, and removes those clones afterward. It preserves the cache for repeat runs. `--repository nowinandroid|wordpress-android|all`, `--host claude|codex`, `--binary`, `--cache`, and `--output` select the workload and destinations. Full histories are required; existing shallow caches must be unshallowed first. Results are written locally to `.mason/reports/benchmarks/open-source.json` by default. The recorded run is in `open-source-final.json` beside it.

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
# Compare actual capture and inspection records, using the public MCP tools:
node scripts/bench-hooks.mjs --fixture large --host claude --samples 3 --decision-evidence captured --git-metrics
node scripts/bench-hooks.mjs --fixture large --host claude --samples 3 --decision-evidence inspected --anchor-scope directory --git-metrics
# Select a packaged Node runtime for both sides of a comparison:
node scripts/bench-hooks.mjs --runtime /path/to/bundle/node --fixture wide --samples 3
```

The benchmark uses isolated temporary Git repositories and the built CLI, makes no model calls, reports p50/p95/max and paired pre/post overhead, and removes its fixtures. By default it runs both host adapters with small, large and wide fixtures. The large fixture contains 1,001 source files, 20 package READMEs, 20 valid decision records and 10,000 ignored build-cache files. The wide fixture has 12 top-level modules with their own README and ignore file, 601 source files, 12 decision records and 10,000 ignored files. Expanded fixtures measure one baseline, then four retained baselines created by actual source deletions. All fixtures exercise documentation repair through a final commit and assert that original baseline bytes remain intact. Outstanding decision reviews remain outstanding.

`--partial-check` adds one command whose directory cannot be resolved. The benchmark requires that specific skipped check, retries it on subsequent calls, and retains incomplete status through the final commit. It does not count that scenario as fully verified. `--git-metrics` records each Git subprocess's command family, duration and inventory classification without arguments, paths or output. Unlike the in-CLI profile, this benchmark instrumentation also sees Git calls during the managed setup lookup.

`--git-delay-ms 0..500` enables metrics and adds a delay to Git subprocesses. `--git-delay-command inventory` limits it to document/source inventories; the default `all` delays every Git command. Delayed queries run through an additional Node worker, which also adds startup overhead. These are comparative stress scenarios, not estimates of workplace latency. Use the same delay, fixture and runtime for both builds. The instrumentation lives only in the benchmark and is not shipped or enabled in normal Mason commands.

`--decision-evidence legacy|captured|inspected` chooses v1 Git baselines, proposals saved through the public MCP tool, or proposals with a separate source inspection. The default is `legacy`. `--anchor-scope file|directory` selects one file or its containing source directory per decision. Large directory scenarios cover 50 files per decision, 1,000 anchored files in total. The small fixture contains no decisions, so use an expanded fixture to measure these modes. Inspection fixtures do not claim human acceptance. Source deletions must reopen their advisories, and the original repair evidence must remain unchanged.

`--samples 10` produces 20 pre/post invocations per category. `--fixture small|large|wide|all` and `--host claude|codex|all` select workloads. Version, platform and the selected runtime's version are included in its JSON. It does not read the caller's project or automatically report metrics anywhere. Use the same fixtures, sample count, runtime and environment for comparisons. Wall-clock results are measurements, not portable CI thresholds; the regression tests separately enforce inventory/query budgets, audit reuse and evidence correctness.

## Profile a local check

```sh
mason check --json --profile
```

`--profile` adds one `mason-profile` JSON record on stderr. Normal results remain on stdout. It reports fixed phase names, invocation counts and elapsed milliseconds without document contents, paths, commands or session identifiers. It performs the normal check, including local evidence writes; it does not upload metrics. Profiling is off by default and also works on `mason auto hook --host claude|codex --profile` with a normal hook payload on stdin. Generated hook configuration is unchanged.

Phase times are inclusive and can overlap, especially parallel Git reads; do not add them together. The CLI profile starts after argument parsing and input reading, so use the external benchmark for process startup and total invocation overhead. The development build adds `git.ls-files`, `git.check-ignore`, `git.log` and other fixed command-family labels for the Git subprocesses used by automation. Their `calls` counts exclude memoized reuse. `automation.git` and document-history timings remain inclusive parent phases; do not add them to their child Git times. These labels cover the profiled check/hook operation, not earlier managed setup lookup or unrelated Mason commands.

`mason status` execution durations now include receipt work, coordination waits, and checking after workspace discovery. The historical measurements above used the earlier duration boundary after lock acquisition. Read-only observations do not add a check execution receipt. Use the benchmark for total CLI overhead, and real host trials for perceived task latency and activation behavior.
