# Patch benchmark

This suite measures whether access to Mason changes the patches a coding agent
produces. The agent edits files; ordinary local tests grade their behavior. An
LLM does not judge correctness. Claude is the existing built-in driver, and an
external adapter can drive another coding agent through the same protocol.

The first ten tasks are **controlled fixtures**, not production repositories.
They validate the experiment and cover specific failure modes. Reference-patch
success is not an agent result. No live improvement or acceptable false-positive
rate has been established yet.

## Run without a model

From the repository root:

```sh
npm run bench:validate
npm run bench:validate -- --output bench/harness/results/patches/offline-validation
```

Every task must begin with passing public smoke tests and failing private task
checks. Its reference patch must pass every check. A separately authored wrong
patch must fail the check named in its mutation. Validation makes no model or
network calls. The optional output directory must be new and contains a report
and machine-readable validation results. These checks also run in `npm test`.

## Run an agent comparison

Build Mason first with `npm run build`. The built-in driver uses an already
authenticated local `claude` CLI:

```sh
npm run bench:patches -- --tasks webhook-retry,health-label
npm run bench:patches -- --repeats 3 --model <full-model-id>
```

Without `--tasks`, all ten tasks run in both arms. Defaults are one repetition,
24 turns, a 240-second wall timeout, and a $1 API budget limit per session. The
full default run requests 20 sessions. Use `--arms baseline` for one arm or
`--budget-per-session`, `--timeout-seconds`, and `--max-turns` to change limits.
Budget limits are supplied to the driver; timeout terminates its process group.
No retry is automatic. Authentication/startup failures are recorded and stop
the run. An interrupted or failed session never counts as a successful patch.

Use full model identifiers when comparing repeated runs. The requested model,
reported resolved models, CLI/adapter version, dependency-lock digest, local
Mason build, harness sources, limits, and source commits are recorded.

## Fairness and separation

Each task × arm × repetition starts in a newly created temporary Git repository.
Commit dates, identities, code, public tests, instructions, and engineering
documents are deterministic. The two arms receive identical source commits and
knowledge digests. The execution order alternates by task and repetition.

Both arms can discover the same engineering facts in `docs/decisions.md` and the
same original file map in `docs/concept-map.md`. Both receive identical project
instructions, including conditional instructions for using Mason when available.
Only the Mason arm receives an MCP connection and equivalent structured records.
Those records are curated fixtures; their setup has no model cost, and the
experiment deliberately excludes real map construction and maintenance cost.

Stale scenarios contain an actual later source commit. Unknown-history scenarios
use an unavailable decision base. These exercise Mason's real trust computation,
not a mocked freshness label. The original map and imported knowledge remain
unverified.

Agent checkouts contain no private grader, reference patch, or mutation. After
the session finishes, the grader copies regular files into another directory and
runs private assertions there. Original public tests, context, package/config,
Mason metadata, and the base commit are protected against modification. New
source helpers and tests are allowed; checks accept different implementations
that satisfy the public contract. Added public tests must also pass.

The temporary repositories and process controls provide evaluation hygiene;
they are not an OS sandbox. Run live comparisons in an appropriately restricted
environment. Adapters must honor the supplied execution constraints, avoid
cross-session memory, and expose no MCP servers to the baseline. Host-level
policies can still affect a CLI session and should be reported with results.

## Tasks

| Task | Failure mode | Decisive behavior |
|---|---|---|
| `webhook-retry` | Repeated incident | Retry keyed deliveries without duplicating unkeyed deliveries |
| `audit-headers` | Repeated incident | Add diagnostic headers without leaking credentials |
| `enterprise-cache` | Missed companion update | New TTL and refresh scheduling agree |
| `ndjson-export` | Missed companion update | Encoding, discovery, and content type all work |
| `router-migration` | Stale map | Extend the active router while preserving the compatibility adapter |
| `retired-limit` | Obsolete constraint | Report current configuration without restoring a retired cap |
| `unknown-history` | Unverifiable guidance | Implement the current preview contract after checking evidence |
| `unrelated-constraint` | Irrelevant guidance | Change health formatting without importing a billing-only rule |
| `health-label` | Quiet control | Add a label without unnecessary intervention |
| `empty-page` | Quiet control | Fix empty pagination without unnecessary intervention |

The last five are negative controls for unnecessary interventions. The two
incident tasks supply knowledge about a past mistake; they do not yet measure
automatic decision capture or learning across a sequence of agent sessions.

## Results and warning review

Each run creates a new directory under `bench/harness/results/patches/`, or the
new directory specified by `--output`. Results are checkpointed after each
attempt, including failures:

- `results.json`: limits, provenance, every session, private/public grades, and
  source/knowledge/patch digests.
- `report.md`: per-arm and paired outcomes, cost, time, Mason usage, failures,
  and review coverage. Pairs with mismatched source, knowledge, or resolved
  models are excluded from paired comparisons.
- `*.patch`, `*.session.json`, `*.stream.jsonl`: actual diffs, session summaries,
  and the driver's raw output. Review these before sharing them.
- `harness-sources.json`, `mason-mcp.mjs`: evaluated source and server artifacts.
  The local `node_modules` link supplies dependencies and is not a vendored
  dependency snapshot; reproduce with the recorded lockfile.
- `review-template.json`: initially unjudged negative controls.

Primary success means a completed session whose patch passes **all** task,
constraint, companion-update, regression, public-test, and integrity checks.
No-op patches and failed sessions stay in the denominator. Unknown costs remain
unknown. No answer-style score or implementation-template preference is used.

Unnecessary intervention rates require transcript review. Do not infer a false
positive from a failed patch or a retrieved decision alone. Count an intervention
when irrelevant or obsolete guidance produces an unwarranted warning, refusal,
or unrelated change. Checking evidence and reporting genuine uncertainty do not
count. Copy `review-template.json` to `review.json`, replace each reviewed null
judgment with a boolean, and record the supporting transcript/patch evidence:

```sh
npm run bench:patches -- --report <run-directory>/results.json --review <run-directory>/review.json
```

Reviews are matched to the run, task, arm, repetition, and patch digest. Empty
judgments remain pending. The report always shows the reviewed denominator;
unreviewed controls never imply a zero false-positive rate. For publishable
results, use a reviewer who did not produce the patches and blind arm labels
where practical.

Freeze tasks, checks, model, budgets, and decision criteria before comparing
product changes. Retain losses and aborted runs. This small suite is a pilot:
add real repository tasks, repeat runs, and review interventions before deciding
whether improvements justify runtime and cost overhead. Do not tune checks or
rerun selected losses to obtain a desired result.

## Another coding agent

Pass `--adapter /absolute/path/adapter.json --model <model-id>`. The harness does
not invoke Claude in this mode. The JSON config selects a wrapper you provide:

```json
{
  "name": "my-coding-agent",
  "version": "1.0",
  "command": "node",
  "args": ["/absolute/path/my-agent-adapter.mjs"],
  "enforcesBudget": true
}
```

Commands and arguments are passed directly, without a shell. Use absolute paths
in arguments. Keep credentials in the agent's normal authentication mechanism,
not in the adapter config, because the config is recorded with results.

The wrapper runs inside the checkout and receives one JSON request on stdin:

```json
{
  "version": 1,
  "cwd": "/temporary/task-checkout",
  "prompt": "Implement the task…",
  "systemPrompt": "Shared execution constraints…",
  "model": "the-requested-model",
  "mcpConfig": { "mcpServers": {} },
  "limits": { "maxTurns": 24, "timeoutMs": 240000, "maxBudgetUsd": 1 },
  "controlled": true
}
```

Use the supplied MCP config exactly: it is empty for baseline and contains Mason
for the other arm. Translate the prompt, instructions, limits, and MCP config to
your agent's API/CLI. The wrapper is responsible for enforcing turn and monetary
limits; declaring support does not make the harness able to verify that budget
enforcement. The harness independently enforces the wall timeout. Emit JSON-line
transcript events, then one normalized final event on stdout:

```json
{
  "type": "result",
  "ok": true,
  "model": "resolved-model-identifier",
  "resultText": "Summary of patch, tests, and constraints",
  "costUsd": null,
  "numTurns": 4,
  "toolCalls": [{ "name": "Edit", "input": { "file_path": "src/example.mjs" } }],
  "readFiles": ["src/example.mjs"]
}
```

`costUsd` must be a nonnegative number or explicit null; `toolCalls` must be an
array. `numTurns`, `readFiles`, and `usage` are optional. Report Mason calls using
`mcp__mason__<tool_name>` so usage is comparable. Report the actual resolved model
on successful sessions. Exit nonzero or return `ok:false` with an `error` for
failures. Malformed or missing final events fail the session; they never become
successful zero-cost runs. The test suite exercises this protocol with a local
deterministic adapter, without any installed or authenticated coding agent.
