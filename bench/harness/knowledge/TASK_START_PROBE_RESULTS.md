# Task-start laboratory probe — 2026-10-11

The harness-only probe emitted accepted decision context through Claude UserPromptSubmit, and one controlled host session consumed it. Existing lexical selection also injected the scheduler lesson into an unrelated release-announcement task. The delivery mechanism works in this synthetic probe; the selection/noise gate fails. No production hook change or prevention comparison was made.

## Selection characterization

The runner bundles the current source context assembler into the ignored report directory. A disposable map-free repository seeds the existing R17 lesson through real save/prepare/accept MCP calls, with synthetic ownership and review attribution. It selects accepted operative bodies only, reports omissions and diagnostics, bounds payloads to three records/6,000 UTF-8 bytes, and leaves production code untouched. Labels, sources and full operative bodies remain visible.

| Synthetic task | Expected applicability | Existing score / overlap | Laboratory delivery |
|---|---|---|---|
| Background scheduler forecast refresh | Relevant | 9; background, scheduler, preserve, release, startup | One accepted lesson, 1,130 bytes |
| Same request with Bash inspection/editing | Relevant | 9; same overlap | One accepted lesson, 1,130 bytes |
| Greeting edit | Unrelated | No match | Quiet |
| Release-announcement wording | Unrelated | 1; release | False positive, 1,130 bytes |
| Periodic weather updates while application is closed | Relevant | 1; application | Lesson selected through generic overlap |

The two score-1 cases cannot be separated with a single score cutoff. The paraphrase match does not demonstrate semantic understanding: its only shared token was “application.” The expected applicability labels were assigned by the coordinating implementation agent, unblinded, for this development fixture. These five tasks are selection characterization, not independent incidents or patch trials.

The runner reports selection disagreements without counting them as harness execution failures. A zero exit code therefore does not establish that the product gate passed. It verifies knowledge/fingerprint integrity; the Stage A noise gate remains failed.

## Host consumption

One live session used Claude Code 2.1.284, observed model `claude-opus-5-5`, configured default effort, $1 cap and 180-second timeout. The project had only the disposable laboratory UserPromptSubmit hook, no MCP server, automatic memory disabled and no session persistence. No global settings were changed. The host's [documented hook contract](https://code.claude.com/docs/en/hooks#userpromptsubmit) supplies the prompt and accepts context before processing it.

The ordinary scheduler request was followed by explicit probe instructions: make no edits or tool calls, return a laboratory marker from injected context, and summarize any accepted lesson. The random marker existed only in the hook command/output, not the prompt or project documents. One hook receipt contained the accepted lesson; the successful final answer repeated the exact marker and accurately summarized the conditional constructor-retention lesson and its reduced-JVM limits. The transcript contained no tool calls. Elapsed session time was 8.647 seconds and reported cost $0.031537.

This is synthetic consumption evidence, stronger than stdout alone. It does not establish spontaneous reuse, a Bash edit, prevention, conflict handling or an advantage over MCP/notes. The host probe includes a diagnostic marker even for an empty match; that marker is laboratory instrumentation and is not proposed production behavior. No full sixteen-session Stage A comparison was run because the selection/noise gate failed.

## Validation, artifacts and development failures

Five targeted tests passed: unsupported-event/missing-prompt/foreign-checkout silence; accepted/proposed separation; whole-record byte limits without losing dedupe eligibility; identity changes for revised content/freshness; deterministic selection limits and diagnostics. Lint and typecheck passed. The probe's in-memory dedupe tests do not implement persisted session state, MCP/file cross-channel deduplication or retirement withdrawal; those remain production-candidate gates.

Ignored raw artifacts:

- `.mason/reports/task-start-selection-2026-10-11`: first seed attempt omitted required owner; stopped before any model call, leaving an incomplete initial report.
- `.mason/reports/task-start-selection-2026-10-11-v2`: same seed rejection retained with the API error. Acceptance requires an owner and source; no review bypass was added.
- `.mason/reports/task-start-selection-2026-10-11-v3`: corrected synthetic owner; selection completed with the false positive.
- `.mason/reports/task-start-host-probe-2026-10-11`: the single live probe, completed selection, transcript, receipts, fingerprints and usage. Knowledge and recorded fingerprints stayed unchanged during that run.
- Later selection-only runs retain reporting improvements: transitive assembler-source fingerprints, failure reports, Node identity and shared-token diagnostics. These did not rerun the model or alter production matching. Each report records its executed source hashes; the live evidence applies to its recorded version.

Disposable repository paths remain in reports. The production MCP bundle seeds the accepted record; the separately bundled source assembler performs selection. Both identities are recorded. Report fingerprints use SHA-256 of JSON-encoded UTF-8 file content; they are execution identities, not byte-for-byte release checksums. Reports and source bundles remain ignored.

## Decision and next work

Do not build the production adapter from the current positive-score matcher. First characterize selection across a larger synthetic set containing relevant paraphrases, generic overlap and competing accepted lessons. Compare explicit file/topic evidence with the existing lexical baseline and retain misses. Choose rules before freezing a new evaluation; raising the score cutoff alone does not resolve the observed tradeoff.

In parallel, the [incident candidate manifest](INCIDENT_CANDIDATES.md) starts three sourced families for the stronger outcome comparison. They are candidates awaiting correction verification, pinned reproductions, useful-lesson review and lifecycle tasks. They are not an accepted dataset or proof of independent user benefit.

```sh
node bench/harness/run-task-start-probe.mjs --output /absolute/path/inside/mason/.mason/reports/fresh-selection
node bench/harness/run-task-start-probe.mjs --host-probe --output /absolute/path/inside/mason/.mason/reports/fresh-consumption
```

Use a fresh output directory; an existing report is never overwritten. Output belongs inside the repository so bundled source modules can resolve existing dependencies. Requires installed project dependencies and built `dist/mason-mcp.js`/runtime. The default path already meets this requirement. `--host-probe` performs one capped live session; without it, selection uses real local MCP review but no model calls.
