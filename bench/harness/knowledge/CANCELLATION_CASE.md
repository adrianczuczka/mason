# C1 cancellation cleanup: checker validation — 2026-10-11

Status: source pinned and constructed-transfer checker validated. The subsequent [lifecycle pilot](CANCELLATION_LIFECYCLE_RESULTS.md) completed four matched task states with synthetic review receipts and eight live sessions. Independent maintainer review remains pending. This advances the [candidate manifest](INCIDENT_CANDIDATES.md), not the prevention milestone.

## Source and scope

[Node issue #35990](https://github.com/nodejs/node/issues/35990) reports cancellation listeners retained after successful operations even when attached once. The initial [PR #35992](https://github.com/nodejs/node/pull/35992) was superseded by [PR #36006](https://github.com/nodejs/node/pull/36006). The actual correction is pinned to [commit aa1eb1fd597f68c6cb67c2a4d631a8d66f2cb94e](https://github.com/nodejs/node/commit/aa1eb1fd597f68c6cb67c2a4d631a8d66f2cb94e), with parent `1a6d4dce6db09cb58cb77714cdcb28d84a7c7073`. It removes abort listeners when awaitable timers settle and adds normal-completion listener checks for both timer variants. GitHub's PR merged flag is false; the pinned correction commit is the source witness, not an inferred PR merge status.

Downloaded before/after source and regression files are retained locally under `.mason/reports/cancellation-check-2026-10-11`, with URLs, revisions, SHA-256 and byte lengths in `source-receipts.json`. The source receipt hashes are:

| File | Before SHA-256 | After SHA-256 |
|---|---|---|
| lib/timers/promises.js | cdc2962aee20249dc924cf034e04f946e0217391df4ac992c6e3b54e9128b79d | 18942310b72a7c74871c5d3a9d36cbfffdc3c31e004b960be3762b7f90fcc22a |
| test/parallel/test-timers-promisified.js | 85f7883efd0d70bf2929b79403d26f319b95da7f73d2bd088bcd819e55e5155b | 802b1e2fff2d11f0f5b19b4032eb08d04af95ab2fbf4391a1e038c028e3f05eb |

The local checker is newly authored around a signal-aware operation, not copied upstream timer code. It tests a transfer of the cleanup requirement using current public APIs. Historical Node source/tests were inspected, not executed on an old Node build. No claim about a currently affected Node version follows.

## Deterministic witnesses

`checkOperation` counts actual abort listeners after twelve sequential normal completions, rather than interpreting warning thresholds. It also verifies original error identity, abort rejection after work has started, no work after prior abort and ordinary no-signal operation. Explicit deferred promises drive the ordering; no sleep determines the race. The constructed operation cancels waiting for work, not arbitrary work's side effects. A per-operation timeout reports nonsettling promises as checker failures. Synchronous hostile code would still require process isolation/timeouts in a later agent harness.

| Constructed reference | Normal completion | Work error | Abort/result behavior | Overall |
|---|---|---|---|---|
| Once-only listener, no completion cleanup | Twelve retained listeners | One retained listener | Preserved | Fails |
| Explicit removal on settlement | Zero retained listeners | Zero retained listeners | Preserved | Passes |
| Managed subscription disposed on settlement | Zero retained listeners | Zero retained listeners | Preserved | Passes |

The managed alternative uses Node's documented [addAbortListener disposal contract](https://nodejs.org/api/events.html#eventsaddabortlistenersignal-listener). It is an alternative in the constructed task, not the historical Node correction. Both passing alternatives keep cancellation behavior; a separate mutation test rejects an implementation that removes all listener use by ignoring cancellation.

Validation ran on local Node v25.9.0. This pins the executed runtime only; a runtime matrix and fixture deployment version are pending. `.mason/reports/cancellation-check-2026-10-11/report.json` retains the first witnesses. The `-v2` report reruns after timeout hardening; `-v3` adds explicit work-start ordering before abort, with the checker fingerprint and same expected verdicts. Five targeted checker tests passed, including a nonsettling implementation; the existing five prompt-probe tests also passed. No model calls were made in this validation.

## Next fixture work

The subsequent pilot created a small queue task, validated explicit-removal and managed-wrapper patches with the same checker, and exercised pending replacement, verified ownership migration, obsolete custom-path retirement and unrelated tasks with equivalent strong-document histories/instructions. Its frozen protocol/results retain the exact fixtures and limits. Future fixture changes need a new protocol; C1 is now exposed pilot evidence.

Independent review remains necessary for broader claims. The coordinating agent's synthetic fixture acceptance is not maintainer approval; upstream reviewers of the code correction are not reviewers of this reconstructed project lesson. Keep retirement scoped to obsolete caller-specific guidance; the cancellation cleanup obligation remains when applicable. Runtime-matrix and human-effort evidence remain pending.
