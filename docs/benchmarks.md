# Benchmarks and limitations

[← Mason](../README.md)

## What the numbers say

Measured with real headless agent sessions in A/B arms (baseline always has a populated CLAUDE.md — beating a context-free agent is not a result). Full harness, pinned commits, and losses included: [bench/harness/](../bench/harness/).

The scores below concern read-only answers. The [patch benchmark](../bench/harness/patches/README.md) grades actual code changes, companion updates, and constraint preservation. The initial reported ten-task patch comparison tied at **10/10 for both arms**, as recorded in the [roadmap](../ROADMAP.md). Improved patch outcomes and an acceptable false-positive rate remain to be established; offline validation and hook replay establish mechanism behavior.

- **Recorded-decision retrieval in the earlier read-only evaluation.** On tasks whose correct answer hinges on a recorded engineering decision (seeded fairly: the baseline had the same facts in a discoverable doc), Mason averaged **9.0/10 vs 7.0/10**. The baseline missed the constraint entirely half the time, and needed ~3× the turns when it found it; Mason surfaced it in one `get_context` call, every time. This does not establish repeat-mistake prevention or superiority over a stronger document workflow.
- **Stale-map safety.** Against a deliberately stale map, the drift flag + changed-file previews led the agent to verify and answer current-code truth — the "confidently wrong from a stale cache" failure did not occur.
- **Where it's a wash — and we say so.** On questions agents can answer by reading code, quality is parity across hono (186 files), vuejs/core (483), and nestjs/nest (1676): 8.7–8.8 both arms, with Mason slightly *behind* on nest (8.5 vs 8.8). If your only questions are "how does X work", modern agents don't need a map.
- **Cost of ownership, measured.** Map builds scale linearly at ~$1.20 per 100 files (Sonnet): $3.22 for hono, $5.63 for vue-core, $19.52 for nest. Incremental refreshes after drift are cents.

## Current prevention evidence

The [maintained-reuse trials](../bench/harness/knowledge/LIFECYCLE_RESULTS.md) and [prevention baseline](../bench/harness/knowledge/PREVENTION_BASELINE_RESULTS.md) also succeeded with ordinary notes. The [standard-delivery comparison](../bench/harness/knowledge/STANDARD_DELIVERY_RESULTS.md) established supported file-hook delivery, with unchanged correctness and ordinary Bash workflows uncovered. Prior comparisons observed additional context cost; none establishes a durable prevention advantage.

The earlier [task-start experiment](../bench/harness/knowledge/TASK_START_EXPERIMENT.md) separates delivery from outcome evidence; further delivery expansion is deferred. The current next evaluation is the [reasoning-loop pilot](../ROADMAP.md#reasoning-loop-pilot-preparation-and-acceptance-gates), covering decision capture, historical recovery, review effort and fresh-session reuse, with separately verified native-memory comparison still pending. Strong document baselines receive equivalent operative content, pending proposals, revision/retirement history and evidence, plus explicit instructions for applying current guidance. New incident families must test maintenance as well as retrieval. Sourcegraph retrieving the same documents is a planned comparator contingent on actual access, not a completed comparison.

The [C1 lifecycle pilot](../bench/harness/knowledge/CANCELLATION_LIFECYCLE_RESULTS.md) completed eight Claude sessions across pending, accepted-migration, retired and unrelated tasks. Current Mason and equally informed documents both passed all four mechanical cases. Mason reported about 161.1% more accumulated tokens and 47.6% more session time, including a pending-draft review continuation. This one-family constructed transfer used synthetic unblinded review; human maintenance effort and prevention superiority remain unmeasured.

The [four-session scoped-inspection follow-up](../ROADMAP.md#focused-live-inspection-results--2026-10-11) showed both Mason agents separating accepted inspection from an unassessed contradictory draft. Notes also passed; Mason still produced two Stop continuations and reported 123.7% more time and 183.3% higher cost. The original grader rejected reordered receipt keys; tested value-equality correction and separate artifact replay confirm preserved records without rewriting original failures. This supports narrower assessment clarity, not reduced effort or correctness superiority.
