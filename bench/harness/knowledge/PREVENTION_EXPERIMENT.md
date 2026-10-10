# Repeat-mistake prevention experiment — 2026-10-10

This specification implements the first evaluation step in the [current roadmap](../../../ROADMAP.md). The question is whether a fresh coding agent preserves engineering intent during ordinary work, and whether Mason improves that outcome over well-maintained project notes with the same facts. This is a development experiment, not a population effectiveness claim.

## Scope and paths

Use the existing [conditional R8 startup reproduction](LIFECYCLE.md), drawn from Jacket's removal/reintroduction incident. It runs real shrinking and reflective startup in a reduced JVM model; it does not reproduce Android, Room, WorkManager, or production scheduling.

| Path | Starting knowledge | Ordinary work | Evidence required |
|---|---|---|---|
| Existing lesson | Separately reviewed reference lesson, identical facts in each arm | Introduce required background work, then add another job in a fresh session | Applicable accepted guidance observed before the first relevant edit; working release startup and required jobs |
| New correction | No stored lesson; identical synthetic incident and correction | Investigate and remove an unused integration; separately review the actual proposal; introduce required scheduling; review the revision; add a job in a fresh session | Useful sourced capture without Mason-specific prompting, maintained history, changed-condition handling, pre-edit retrieval, and correct patches |

The existing lifecycle runner covers the new-correction path and reuse of its actual reviewed lesson. It does not provide an independent seeded-reference path. Do not substitute an evaluator-written lesson after a failed capture or count subsequent reuse as an independent seeded trial.

## Matched conditions

- Initial baseline: current working-tree Mason guidance and built server (`candidate`) versus explicit `PROJECT_NOTES.md` and its review receipt (`notes`), one repeat on Codex using its configured default model. Record observed model identity; report it as unknown if unavailable.
- Both arms get the same task evidence, source, native checker, validation opportunity, and review criteria. Retain prior accepted guidance while revisions are proposed.
- Fresh isolated sessions and checkouts; no inherited conversation, native private memory, or private source. No Mason instruction in the task prompt. Project guidance may instruct each arm's normal knowledge workflow.
- Separate semantic review at capture and revision boundaries. Inspect actual proposals, source, patches, and native results. Reject unsupported claims; never rewrite a proposal to make a run pass. Review here applies only to synthetic fixture knowledge.
- Retain failures, timeouts, rejected captures, and incomplete reviews. No automatic retries. Changed execution fingerprints require a new run; development reruns are reported separately.
- Maximum four sessions per arm, 180 seconds per session. Codex records usage without a dollar cap; unknown dollar cost stays unknown. The existing runner supports Claude with a per-session dollar limit for later host-specific comparison.

## Controls

| Control | Expected behavior | Existing lifecycle coverage |
|---|---|---|
| Unrelated greeting change | Correct edit, no knowledge mutation; inspect transcript for irrelevant guidance or approval requests | Implemented for edit and knowledge mutation; semantic noise review required |
| Changed assumption | Required scheduling supersedes removal of the unused dependency; revise the same lesson, retain approved history, and verify release startup | Implemented |
| Deliberate violation | Constructor removal under release shrinking fails specifically at reflection lookup | Native preflight |
| Valid alternative | Both supported constructor-preserving rule forms pass | Native preflight |
| Conflicting guidance | Explain an actual same-scope conflict with sources; distinguish history/scope; request authorized resolution without inventing approval | Not implemented in the R8 runner; separate fixture needed |
| Repeated delivery | Do not repeat unchanged guidance; changed relevant evidence can prompt inspection again | Not measured with hooks disabled; hook-enabled fixture needed |
| Missing/stale check evidence | Keep uncertainty visible; do not claim current validation | Not a live lifecycle control; separate fixture needed |

## Acceptance and grading

These are operational gates for this small development trial, not statistically estimated rates or approved population targets. Freeze them before model calls.

- Each complete selected row must have a useful, supported capture and revision, both separately accepted, passing private release checks at all three substantive stages, and no control knowledge mutation. A failed stage is a failed stage even if another stage passes.
- For Mason, the exact accepted revision must be observed through `get_context` while both application anchors still have their pre-edit bytes. For notes, manually inspect the transcript for reading applicable accepted guidance before editing. Missing observation is unknown or a delivery failure, never inferred from a correct patch.
- Semantic review rejects a permanent scheduler ban, invented attribution or approval, an unsupported upstream fix, lost accepted history, and a revision that keeps an obsolete removal requirement operative. A valid alternative must remain permissible.
- Zero irrelevant guidance or unnecessary approval interruptions on the selected unrelated control, assessed from its transcript. This does not estimate a population false-positive rate.
- Native preflight must pass debug, fail the unprotected release at constructor lookup, and pass removal and both valid keep-rule alternatives. Checker tampering, disabling shrinking, or missing toolchain evidence fails eligibility.
- Record elapsed time, usage, context response bytes, and known cost per stage. For paired live stages, flag Mason elapsed time or reported total-token usage above 1.25 times notes for investigation. This provisional 25% overhead budget is a development diagnostic, not a performance guarantee; cached usage, unknown metrics, and one-run variance must be reported. Do not add heterogeneous token fields together or treat unavailable usage as zero.
- Record reviewer time if measured; otherwise label it unknown. Flag more than one proposal per lesson, unsupported captures, and avoidable extra review requests. Broader review-effort and hook-latency thresholds require pilot measurements before a later release decision.

The full prevention milestone additionally requires the independent seeded path, conflict/uncertainty controls, supported-host pre-edit delivery and deduplication. Passing the current runner alone cannot complete that milestone or prove that retrieval caused success.

## Execution sequence

1. Build the current server; inspect and fingerprint the existing JDK/R8 artifact. Run native and deterministic lifecycle validation before model calls.
2. Run the unchanged live lifecycle comparison. Retain the report directory and execution fingerprints. Review actual capture packets, resume, review revision packets, and resume through follow-up.
3. Inspect both arms' transcripts and classify misses as capture, retrieval, delivery, understanding, maintenance, or validation. Separate correct patches from observed knowledge use. Report ties as ties.
4. Use that baseline to scope a minimal independent seeded path and hook-enabled delivery comparison. Hold tasks and evidence constant between current Mason and a candidate prevention change. Measure hosts separately; native hook capabilities need not match.
5. Add conflict, missing/stale evidence, and repeated-delivery controls before claiming the full milestone. Broaden to independent incidents and ordinary-work pilots before claiming an advantage over notes.

Existing runner commands (paths are supplied from the local preflight):

```sh
npm run build
npm run bench:knowledge:lifecycle -- --validate --r8-jar /absolute/path/to/d8.jar --java-home /absolute/path/to/jdk --output /absolute/path/to/fresh-validation-output
npm run bench:knowledge:lifecycle -- --live --hosts codex --arms candidate,notes --repeats 1 --r8-jar /absolute/path/to/d8.jar --java-home /absolute/path/to/jdk --output /absolute/path/to/fresh-live-output
npm run bench:knowledge:lifecycle -- --resume /absolute/path/to/live-output --reviews /absolute/path/to/capture-reviews.json
npm run bench:knowledge:lifecycle -- --resume /absolute/path/to/live-output --reviews /absolute/path/to/revision-reviews.json
```

Exit 2 is a review boundary, not a successful completed comparison. A reviewer who knows the harness implementation must disclose that the review is unblinded. Save a tracked results summary linking this spec; raw transcripts and fixture records remain in ignored local output. Record missing coverage explicitly rather than silently widening the interpretation of existing results.
