# Seeded standard-hook comparison — 2026-10-10

Completed the [revision 2 protocol](HOOK_PREVENTION_EXPERIMENT.md): twelve Claude sessions across four cases and three conditions, against unchanged Mason production source. All sessions completed on observed `claude-opus-5-5`, Claude Code `2.1.284`, with private native checks and valid integrations. Business inputs and validation code matched across conditions for every case. Review of transcripts and receipts was unblinded and harness-aware, separate from the evaluated sessions.

**Main finding: current standard lifecycle hooks did not deliver the technical lesson before editing.** Applicable rationale arrived through MCP or direct notes reads. Hooks added a post-edit source-inspection workflow; they did not improve correctness over MCP-only in this sample. The optional standalone `mason-hook` was not installed and is not evaluated here.

## Prespecified outcomes

| Case | Project notes | Mason MCP only | Mason MCP + standard hooks |
|---|---|---|---|
| Relevant edit / changed requirements | Pass | Pass | Pass |
| Unrelated greeting edit | Pass | Pass | Pass |
| Repeated anchor inspections and two debug checks | Pass | Pass | Pass |
| Conflict: resolve before changing startup behavior | Fails this gate | Pass | Pass |

Both relevant editing cases preserved release startup and configured one modeled job in every condition. Mason retrieved the exact accepted revision before editing in both cases, and both conflict sessions retrieved both accepted records. Notes read the accepted notes/review receipt before substantive edits in the relevant, repeated and conflict cases. No condition invented acceptance or changed operative seeded knowledge; hook sessions appended source inspections through actual prepared MCP review calls.

In the conflict case, notes identified the accepted foreground-only policy and its incompatibility with the new requirement, then applied a reversible uncommitted patch and asked for confirmation before committing. Both Mason conditions instead prepared and validated the change in scratch/in-memory state, left repository startup behavior unchanged, and requested direction. Notes failed the frozen conservative no-edit-until-resolution gate, not conflict recognition or startup correctness. A direct implementation request may reasonably be interpreted as authority to prepare a reversible change; this synthetic gate does not establish that notes behaved generally unsafely. The conditional constructor-protection lesson explains how scheduling works safely; it does not itself grant permission to override product policy. This is a request-versus-policy conflict, not proof of general contradiction detection between decision records.

All unrelated controls changed only the greeting, with no startup-lesson notice, knowledge mutation, or approval interruption. All four hook sessions had the full five-event lifecycle and zero observer/hook errors or Stop blocks.

## Delivery and repetition

The relevant and repeated hook cases each received one post-edit drift/inspection notice. The notice identified the decision, changed anchors and the inspection command; it did not contain the technical constructor/reflection rationale. Each agent inspected the source and recorded a no-contradiction inspection without changing human approval. The unrelated and conflict hook cases received no lifecycle notice.

The repeated case actually performed two individual Read calls and two separate debug commands before editing. No repeated unchanged lifecycle notice was observed. Because standard hooks delivered no full lesson at those reads, this establishes quiet notification behavior on those observations, not successful deduplication of injected lessons. Hook/MCP byte witnesses establish temporal order; they do not establish causality or every transient shell edit within a tool call.

## Observed cost

| Condition, four sessions | Session seconds | Reported cost | Reported input/cache/output tokens |
|---|---:|---:|---:|
| Project notes | 85.998 | $0.3521 | 180,360 |
| Mason MCP only | 104.507 | $0.5046 | 436,127 |
| Mason MCP + hooks | 126.598 | $0.6112 | 547,056 |

Total reported cost for the corrected comparison was **$1.4679**. Tokens sum Claude's top-level input, cache-creation input, cache-read input and output fields, whose categories are distinct; nested cache and iteration fields are not added again. They are accumulated session usage, not unique context size, and are not directly comparable with the earlier Codex accounting.

Hooks used about 25.4% more reported tokens and 21.1% more session time than MCP-only across four cases, plus about $0.1066. Paired token overhead exceeded the provisional 25% diagnostic on relevant, unrelated and repeated cases; paired time exceeded it on unrelated and repeated cases. Caching, extra validation, source inspection and session variability contribute. These descriptive single-repeat figures cannot establish stable overhead or an effect of hooks alone. Reviewer time is unknown.

## Development failures and evidence

An initial deterministic run exposed incorrect use of a new decision ID as an update; seed creation was corrected to use the returned ID. The next deterministic run passed all twelve cells. A first live development batch was then stopped after six completed sessions and a seventh interrupted attempt: its grader mistakenly treated a legitimate appended source inspection as a substantive knowledge change, and its instruction about review receipts confused the agent. Those artifacts and original grades remain under `.mason/reports/hook-prevention-live-claude-2026-10-10/`, with known reported cost $0.7305 across the six completed sessions; the interrupted attempt's cost is unknown. They are excluded from the corrected comparison.

Revision 2 clarified human approval receipts and permits only appended inspections witnessed by a successful MCP review call, while preserving operative content, approval and prior history. A fresh twelve-cell deterministic run passed before the fresh live comparison. There were no model retries within that comparison or retrospective changes to its mechanical grades.

Corrected raw evidence is retained under `.mason/reports/hook-prevention-live-claude-2026-10-10-v2/`, including original report, twelve transcripts, hook/MCP observations, initial seeds and reviews, native results, usage and `semantic-review.json`. Corrected deterministic evidence is under `.mason/reports/hook-prevention-validation-2026-10-10-v3/`. Report fingerprints include production binaries, guidance, execution modules and the frozen protocol. Native identity remains JDK 17.0.17 and Android build-tools 36.0.0 R8 8.10.9-dev, jar SHA-256 `4097ff9c46c185c6e7214da7fe9b1befb5adeea5cc9ca349270e0249904f9240`.

Validation: build passed; five prevention regressions passed, including actual seed creation/acceptance, late/wrong/partial retrieval rejection, repeated notices, and witnessed versus forged source inspections. The final native-enabled targeted run passed all 33 prevention, behavior and lifecycle tests without skips. Typecheck, targeted lint, repository formatting, syntax, local documentation-link and whitespace checks passed.

## Next product slice

Evaluate bringing the existing decision-body injection into the standard integration, starting with supported file reads before edits. Keep normal shell-based workflows in the comparison, since current standalone file hooks require a supported tool and file path. Test relevant delivery, silence on unrelated work, per-session deduplication, changed evidence and conflicting authority while tracking context overhead. Keep current standard hooks as the comparison arm and preserve the distinction between source inspection and human approval.

This experiment identifies a standard-integration delivery gap. It does not justify a general retrieval rewrite or demonstrate better patches from hooks. Stale/missing execution-receipt controls, actual check linkage, independent incidents and maintainer pilots remain open. Do not pool this Claude sample with the prior Codex lifecycle baseline.
