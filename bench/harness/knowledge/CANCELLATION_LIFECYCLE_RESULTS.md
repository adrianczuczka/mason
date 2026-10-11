# C1 lifecycle comparison results — 2026-10-11

Completed the [frozen eight-session protocol](CANCELLATION_LIFECYCLE_EXPERIMENT.md). Current Mason and strong maintained documents both passed all four mechanical tasks: pending replacement, accepted ownership migration, retired custom-path guidance and unrelated greeting. Mason added context cost and a Stop review continuation in the pending case; no correctness advantage was observed. No production task-start selector was used.

## Matched evidence and outcomes

Each pair forked one reviewed template. Source, initial operation/helper code, requirements, ownership facts, public smoke check and greeting bytes matched. The document arm received a readable projection and the exact full record/history as PROJECT_NOTES_REVIEW.json; receipt equivalence was tested. Both instruction sets required consulting applicable guidance before editing, checking changed sources and distinguishing accepted/pending/historical content. Only the retrieval mechanism and product lifecycle behavior differed. Both permitted the requested code change without another approval.

The coordinating Codex implementation agent reviewed the constructed lesson against the pinned source and helper witnesses, and seeded acceptance/retirement through actual Mason APIs. This was synthetic, unblinded evaluation approval by the same agent that authored the harness, not independent maintainer review. The source incident is new to our prior fixtures, but public/model-training exposure is unknown. This one-family pilot does not complete the three-family evaluation.

| Case | Mason | Maintained documents | Transcript interpretation |
|---|---|---|---|
| Pending replacement | Pass | Pass | Both used accepted revision 1 and kept the contradictory simplification draft unaccepted. Mason's Stop continuation ended in an unresolved review question. |
| Accepted ownership migration | Pass | Pass | Both used the managed helper and treated old caller-specific cleanup as history. Mason recorded a witnessed source inspection, without changing acceptance history. |
| Retired custom-path guidance | Pass | Pass | Both followed current helper ownership without reinstating the retired caller instruction. The underlying cleanup obligation remained. |
| Unrelated greeting | Pass | Pass | Only greeting changed; no new lesson or review intervention. Both stated that queue guidance did not apply. |

All relevant submitted functions passed the private behavior checker: twelve successful calls left zero listeners, errors/results were preserved, cancellation after work started rejected, pre-aborted signals prevented work, and no-signal behavior worked. Accepted/retired cases delegated all sixteen checked invocations to the protected helper. Human approval/history stayed unchanged; the one source-inspection addition was permitted only because its exact real MCP result was observed. Unrelated operation bytes remained unchanged.

## Knowledge delivery and review friction

Every session used Bash for file inspection and editing; no Read/Edit/Write tool calls occurred. Standard hooks supplied no direct lesson body on those unsupported paths. In the pending and accepted Mason cases, MCP returned the correct operative revision before operation bytes changed. Retired get_context returned no active decision; that agent then inspected the retired record and current source through Bash. The greeting get_context returned no applicable guidance. Notes receipts/transcripts show the readable record/history was read before edits in all four tasks, including the unrelated one; the agent then judged it inapplicable. That broad explicit document read is different from automatic irrelevant hook injection.

There were no hook execution errors. The pending Mason case had one Stop block/continuation. It prompted review preparation after the correct patch. The agent recognized that the prepared record contained the contradictory revision-2 proposal alongside accepted revision 1, and declined to attest that no contradiction existed. It kept the code and history intact, but asked the user how to resolve the finding. The accepted-migration case prepared and recorded a truthful source inspection, with no Stop block. Notes needed no matching inspection-state maintenance.

This is an observed review-state friction point, not proof that inspection should be removed. A contradictory pending draft may warrant review even when the patch satisfies operative guidance. The current workflow made that unresolved draft affect completion of an accepted-guidance inspection. Evaluate whether inspection can distinguish operative satisfaction from draft contradiction without promoting or rewriting the draft. The pending final answer also suggested cleanup could be removed if the draft were accepted; approval alone would not repair the witnessed listener leak. No submitted patch made that change, and the report does not treat that hypothetical suggestion as a correctness benefit.

## Cost and limits

Claude Code 2.1.284; observed model claude-opus-5-5 in every cell. Default effort/model configuration, one repetition, rotated arm order, $1/session cap and 180-second timeout. No session hit the cap/timeout. Total reported host cost: **$0.9844212**.

| Case | Mason seconds / cost | Notes seconds / cost |
|---|---:|---:|
| Pending | 35.379 / $0.315487 | 21.151 / $0.109500 |
| Accepted migration | 27.232 / $0.152949 | 17.227 / $0.100006 |
| Retired | 22.151 / $0.106498 | 17.308 / $0.098308 |
| Unrelated | 11.316 / $0.048296 | 9.419 / $0.053378 |
| Total | 96.078 / $0.623229 | 65.105 / $0.361192 |

Accumulated host token totals were 431,752 for Mason and 165,328 for notes: about **161.1% more**. Mason aggregate session time was about **47.6% higher**, and reported dollars about **72.5% higher**. These exceed the provisional 25% time/token diagnostic. Token accounting sums top-level input, cache-creation input, cache-read input and output tokens once; nested cache/iteration fields are not added again. Accumulated cached tokens are not unique context size or full-price billed input. Actual dollars are reported separately.

This compares the configured workflows, including MCP definitions/responses, audit hooks, source-inspection calls, model choices and shared observer overhead. It does not isolate a single cause of overhead or estimate population latency. Review preparation responses were 12,375 bytes in the pending case and 9,982 bytes in the accepted case; get_context responses were 3,420 and 2,554 bytes respectively. These are concrete response-size observations, not a complete cost attribution. Human setup/review effort and long-term maintenance benefit were not measured. No Sourcegraph arm or ordinary correction capture was run.

## Validation and retained artifacts

Eleven targeted tests passed, including submitted-function checker mutations, matching facts/history, altered receipt/helper/approval rejection, unrelated operation changes, failed sessions and nonsettling promises. Lint, typecheck, formatting, JavaScript syntax and local documentation links passed. Production source was unchanged, so the full production suite was not rerun for these harness additions.

Development artifacts are separate:

- `.mason/reports/cancellation-lifecycle-validation-2026-10-11`: eight plain-Node reference cells passed, but a concurrent test exposed fixture function serialization containing test-runner transformed import names. No live calls followed that version.
- `.mason/reports/cancellation-lifecycle-validation-2026-10-11-v2`: stable static fixture source, stronger negative grading checks, all eight cells passed. Matched public facts verified before live calls.
- `.mason/reports/cancellation-lifecycle-live-claude-2026-10-11`: all eight completed cells, frozen fingerprints unchanged, transcripts, hook/MCP byte witnesses, actual records, costs and runtime identities. No retries or pooled interrupted runs.

The coordinating reviewer inspected the retained outputs unblinded. Supplemental receipt/semantic summaries leave mechanical grades unchanged. One notes session wrote a synthetic scratch script at /tmp/t.mjs; this scope deviation was outside the repository snapshot grader. The evaluator removed it only after its bytes exactly matched the observed generated script and fixture path, retaining scratch-cleanup.json. These controlled fixtures are not a filesystem sandbox; tracked-file grading does not establish confinement of all agent writes.

## Product decision

This pilot supports correct interpretation of lifecycle states in both workflows, not superiority over maintained documents. Keep automatic prompt delivery deferred. Prioritize the measured review-state friction and response/context overhead before expanding automatic maintenance behavior. In parallel, prepare the remaining incident families without tuning the product against their outcome tasks. Future comparisons must measure whether better workflow semantics reduce unnecessary intervention or total effort while preserving correct decisions; hook delivery and a correct patch alone do not answer that question.
