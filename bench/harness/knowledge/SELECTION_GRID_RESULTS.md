# Competing-lesson selection grid — 2026-10-11

Expanded the [task-start probe](TASK_START_PROBE_RESULTS.md) to four accepted lessons and 24 synthetic tasks. Compared three fixed laboratory rules without production changes or model calls. None satisfies the automatic-delivery noise/coverage gate. The score cutoff improves this development set while still delivering irrelevant bodies and missing useful paraphrases.

## Setup and results

Lessons cover the existing scheduler, worktree and interrupted-upload development topics plus a constructed release-announcement constraint. They are seeded through real save/prepare/accept calls with synthetic owner/reviewer attribution. They are not newly approved project policies. The new cancellation, redirect-auth and timeout-race incident candidates were excluded from this selection grid to preserve separation from outcome-fixture development.

The runner uses the current source assembler in a map-free disposable repository and the same three-record/6,000-byte laboratory formatter for every rule. Rules filter the assembler's existing positive matches; they cannot recover a lesson the assembler omitted. Rules are: all positive matches, score at least 2, and at least one title-token or literal anchor-path match. All explicit paths come from the task text; no Bash command parsing is involved. Ordering and byte/count limits remain fixed.

| Rule | Exact selected sets / 24 tasks | Irrelevant bodies | Missed expected lessons | Emitted context bytes |
|---|---:|---:|---:|---:|
| Existing positive matches | 7 | 16 | 3 | 26,897 |
| Score ≥ 2 | 15 | 5 | 4 | 17,253 |
| Title token or literal anchor path | 13 | 5 | 6 | 15,771 |

An exact selected set contains every expected lesson and no extras after payload limits. Body counts sum across tasks, not sessions or users. Expected labels were assigned by the coordinating implementation agent while constructing this grid; they are unblinded development judgments, not independent evaluation. The rules and inputs were fixed before execution, but this is not a preregistered held-out benchmark.

Observed failures include scheduler guidance on a startup-banner task, worktree guidance on a Git badge fix, and publishing-recovery guidance on a profile-photo upload button. Title hits do not distinguish shared words across domains. Paraphrases such as a separate working copy or an unacknowledged binary transfer can miss altogether. A scheduler task mentioning release startup also attracts the announcement lesson through shared vocabulary. Simply raising a score cutoff loses the earlier periodic-weather paraphrase.

The `positive` rule here uses four competing lessons; its numbers are not a comparison with the earlier single-lesson five-task probe. No agent patch, outcome gain or Sourcegraph comparison is inferred from selection counts. Zero exit status means the harness/integrity checks completed, not that the product gate passed.

## Artifacts and next decision

Ignored `.mason/reports/selection-grid-2026-10-11` contains the first completed run. The `-v2` run records the formatted final runner with the same inputs/rules/results. Reports retain tasks, seed identities, source/binary fingerprints, raw scores, title/path signals, omissions and integrity checks. Knowledge and recorded fingerprints stayed unchanged. Dependencies resolve from the repository, so outputs belong under its ignored reports directory.

```sh
node bench/harness/run-selection-grid.mjs --output /absolute/path/inside/mason/.mason/reports/fresh-grid
```

Keep production prompt delivery deferred. The next useful investigation is whether a small explicit applicability description can distinguish subject/action from incidental vocabulary, evaluated against this retained set plus new task wording frozen before rule changes. Any authored applicability metadata adds review cost and must be available equally to the strong document baseline. Do not add ad hoc case-specific synonyms and then call the same cases independent proof. An uncertain match should remain a retrieval limitation rather than a universal safety claim.

Meanwhile, the [first incident checker](CANCELLATION_CASE.md) validates a sourced violation and two alternatives. Preparing independent lifecycle tasks remains more valuable than indefinitely tuning this synthetic grid.
