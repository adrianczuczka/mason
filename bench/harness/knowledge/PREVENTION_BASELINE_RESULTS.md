# Repeat-mistake baseline — 2026-10-10

The first baseline under the [prevention experiment spec](PREVENTION_EXPERIMENT.md) completed eight live Codex sessions: four with current Mason and four with explicit project notes. Both arms passed the existing lifecycle. This is a tie on correctness and maintained reuse, with higher reported token usage for Mason. It establishes no prevention advantage over notes.

## Outcomes

| Outcome | Current Mason | Project notes |
|---|---|---|
| Ordinary correction produces useful sourced proposal | Pass; separately accepted | Pass; separately accepted |
| Remove unused scheduler and preserve release startup | Pass | Pass |
| New scheduling requirement changes the lesson | Pass; same ID, revision 2, prior accepted history retained | Pass; revised notes, prior accepted text retained in review receipt |
| Revision passes separate semantic review | Accept | Accept |
| Fresh session adds another job and preserves startup | Pass | Pass |
| Applicable accepted knowledge inspected before edits | MCP byte witnesses for reconsideration and follow-up | Manual transcript review: accepted notes/review receipt read before editing in both stages |
| Unrelated greeting control | Pass; no knowledge mutation, irrelevant lesson, or approval interruption | Pass; no knowledge mutation, irrelevant lesson, or approval interruption |

Mason used a valid constructor-member keep rule rather than the reference class keep rule. Both passed the private checker. No proposal was rewritten, failed capture seeded, model session retried, or grade reassessed. Native preflight passed debug, reproduced the release constructor-lookup failure, and passed removal and both constructor-preserving alternatives. Deterministic reference validation also passed both complete rows before live calls.

## Time and usage

Elapsed time is host-session wall time, excluding evaluator preflight, private grading, review, and fixture commits. Tokens are reported input plus output across a session; cached input is included in input, not added again. These are neither unique context sizes nor dollar costs.

| Stage | Mason seconds | Notes seconds | Mason reported tokens | Notes reported tokens |
|---|---:|---:|---:|---:|
| Capture | 42.203 | 37.225 | 97,747 | 76,412 |
| Reconsider | 40.084 | 37.790 | 87,060 | 63,664 |
| Follow-up | 33.083 | 26.814 | 89,782 | 64,320 |
| Unrelated control | 22.290 | 15.455 | 56,329 | 43,619 |
| Total | 137.660 | 117.284 | 330,918 | 248,015 |

Mason's aggregate reported tokens were about 33.4% higher and session time about 17.4% higher. All four token comparisons exceed the spec's provisional 25% overhead diagnostic; the unrelated control also exceeds it for time (about 44.2%). One sequential repeat cannot establish a stable cost difference or isolate its cause. Project instructions, tool definitions, turn count, caching, and retrieval responses may contribute; none has been ablated here. Dollar cost and reviewer time are unknown.

Mason `get_context` text response sizes were 781 bytes at capture, 548 on the unrelated control, 3,820 at reconsideration, and 4,160 at follow-up. These UTF-8 bytes exclude protocol framing and other context and are not token counts. The control returned no stored lesson; normal project-context lookup still incurred work. No unchanged-delivery deduplication claim is supported because hooks were disabled.

## Identity and retained evidence

- Codex CLI: `0.153.4`; configured default model, actual model identity unreported. Each stage had a distinct ephemeral session and a 180-second timeout. All sessions completed.
- Mason: working source version `0.21.0`; built MCP server SHA-256 `15e5a6f95132a9926f88dfc64b29155501fc1c078eee56b086003bda66513cc0`. Complete execution fingerprints and guidance digest are retained in the raw report.
- Native checker: `javac 17.0.17`, Android build-tools 36.0.0 R8 `8.10.9-dev`; jar SHA-256 `4097ff9c46c185c6e7214da7fe9b1befb5adeea5cc9ca349270e0249904f9240`.
- Raw local artifacts: `.mason/reports/prevention-live-codex-2026-10-10/` and `.mason/reports/prevention-validation-2026-10-10/`. They retain reports, transcripts, MCP byte witnesses, proposals, review packets and verdicts, native results, usage, and fixture paths. Outputs are ignored rather than committed.
- The coordinating Codex agent reviewed actual proposals and evidence separately from the evaluated sessions. This review was unblinded and harness-aware; acceptance applies only to the synthetic fixture. No external reviewer or maintainer pilot participated.

## What to do next

No capture, retrieval, maintenance, or patch correctness miss was observed in this case, so it does not justify a speculative correctness fix. Next, implement the spec's independent seeded-lesson and hook-enabled delivery comparison, retaining a current-Mason arm and matched notes evidence. Add repeated-delivery, conflicting-guidance, and missing/stale-evidence controls. Investigate the context overhead, especially on unrelated work, while checking that any reduction preserves lesson recall.

The current runner disables hooks and private memory. It tests an explicitly supplied correction and subsequent maintained reuse, not selective capture from every kind of organic review. It does not test an independent seeded path, proactive hook delivery, check-link freshness, or the full context-explanation product experience. The reduced JVM reproduction and one sequential comparison are not held-out Android validation or evidence of population false-positive rates. The full roadmap milestone remains open.
