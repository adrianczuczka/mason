# Knowledge capture and reuse smoke results

Recorded on 2026-09-08 during development after Mason 0.16.0. These are synthetic development smoke tests, not a held-out performance study.

## Completed candidate run

Run `2026-09-08T16-07-04.252Z` used the `checkouts` variant and ordinary investigation, worktree-creation and greeting-edit prompts. None of the task prompts mentioned Mason. Both hosts received the candidate project guidance and real MCP server. Hooks and native private memory were disabled.

| Host | Sourced proposal | Separate review | Fresh-session worktree | Control records | Total session time | Reported cost |
|---|---|---|---|---|---|---|
| Claude Code 2.1.261 | Captured | Accepted | Correct directory; retrieved accepted decision before action | 0 | 92.96 s | $0.6600 |
| Codex CLI 0.153.4 | Captured | Accepted | Correct directory; retrieved accepted decision before action | 0 | 133.55 s | Unknown; usage retained |

Each row contains three sessions: investigation, unrelated control, and reuse after review. Both hosts created an actual `.checkouts/task-change` worktree, kept the original checkout intact, and preserved application behavior. The controls changed the greeting as requested. Distinct capture/reuse session IDs, unchanged reviewed records and intact original worktrees were also checked from retained transcripts and checkouts.

The reviewing agent was `Codex (primary implementation reviewer)`, separate from the capture sessions but also responsible for the implementation. Review was not blinded. Its acceptance applies only to the synthetic fixture; it is not authenticated team approval. The actual proposals were reviewed and committed without rewriting them. Both preserved the supported directory, external-indexer rationale, Platform ownership and uncertainty about IDE staging. Quality notes remain: Claude retained existing checkout names and a temporary task restriction; Codex repeated proposal status already held in metadata. These are opportunities to improve concision.

Codex also attempted one auxiliary `mason_automation` call that was denied. The three evaluation tools were callable and used; that auxiliary failure remains in the report. These results do not establish general tool availability or hook activation.

Claude reported `claude-opus-5[1m]`, `claude-opus-5`, and auxiliary `claude-haiku-4-5-20251001` usage. Codex did not emit a model identifier in the retained events. Defaults were host-controlled. Each session had a 180-second timeout; Claude had a $1 session cap. Codex cost was not capped or inferred from token counts.

The live MCP server SHA-256 was `06f20bbc147120fbd5ab92413db0193254cb877c74a62bac13f8ee90fdb0e546`; candidate guidance SHA-256 was `5670fae18d030e69ce3b26ff7e474514378b232c9f21cd37df787b9e2017d6f5`. Subsequent nested-template reference hardening and additional grader guards were covered by deterministic tests. Final grader checks were reapplied to retained live artifacts in `final-verification.json`; this does not claim another live run against the later server build.

## Earlier development attempts

- `2026-09-08T15-48-18.545Z`: Claude captured a proposal, but review rejected its invented standing owner-approval requirement for cleanup. Reuse was not seeded. Codex MCP calls were denied under the fixture's initial approval configuration, so no capture was counted. The prototype observer also omitted upstream server instructions. Guidance and observer/configuration issues were corrected before the completed run.
- `2026-09-08T15-53-34.559Z`: Codex captured useful records under frozen 0.16.0 guidance, the first candidate wording and the file-notes baseline. All three controls passed. After separate review, all fresh sessions chose the intended directory; both Mason arms retrieved the accepted decision before acting. All three actual worktree creations failed because the initial sandbox profile prevented `.git` writes. The evaluator correctly reported failed reuse. A scoped fixture permission profile and a native Git-write preflight corrected that harness issue.

These attempts remain recorded as failures. They are useful debugging evidence, and show that capture also occurred with existing guidance and ordinary notes. They do not establish a completed comparative advantage for the candidate. Changing the directory in the later run checks a variant of the same scenario; iteration on this evidence means it is still development data.

## Interpretation and artifacts

The completed run demonstrates the capture → review → fresh-session retrieval → correct action mechanism on both hosts, with no unnecessary records on two simple controls. It does not establish lower mistake rates than project notes, general capture precision, performance on larger repositories, or lasting value across real projects. Repeated comparisons on additional scenarios, with predefined review criteria and independent reviewers, remain necessary.

Local transcripts, source evidence, proposals, review verdicts, MCP receipts and reports are retained under `bench/harness/results/knowledge/<run-id>/` and ignored by Git. This tracked summary preserves outcomes and limitations without publishing host transcripts. See [the evaluation guide](README.md) for commands, review format and comparison settings.
