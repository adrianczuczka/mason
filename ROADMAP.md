# Mason: becoming the definitive context engineer

Captured by Codex on 2026-09-05, against release 0.11.0.

Linked Mason memory: [direction and growth roadmap](.mason/decisions/mason-s-definitive-context-engineer-direction-and-growth-roa.json), recorded as a sourced proposal.

The maintainer's ambition is for Mason to become the definitive context engineer as projects grow: help coding assistants retain engineering intent, respect evolving constraints, notice coupled changes, and avoid repeating mistakes that create technical debt.

The earlier question was: "how close is this to becoming the definitive context engineer that we talked about? think about what usually happens as projects grow". This document preserves the direction recoverable from the conversation and the subsequent implementation. The earlier assistant assessment is not available verbatim. The growth requirements below are explicitly a synthesis, not a recovered quotation or a claim that every proposed solution was approved.

The maintainer requested that this direction be recorded. That authorizes preserving the memory; proposed milestones below still need prioritization. No roadmap owner or formal acceptance has been recorded.

The original five priorities were:

| Priority from the conversation | Position at 0.11.0 | What remains to establish |
|---|---|---|
| Trust hardening: fix reproduced issues, propagate unknown/invalid states, and test refreshes through the final metadata commit | Implemented trust and storage improvements; later fixes preserve accepted decisions during draft revisions and original audit findings during repairs | Continued regression coverage and evidence from real project use; a passing freshness check alone does not prove correctness |
| Real patch evaluations: fewer repeated mistakes and missed updates, with an acceptable false-positive rate | Patch harness and held-out checks implemented; the reported initial ten-task comparison tied at 10/10 for both arms | A measurable reduction in relevant errors, reviewed false positives, and acceptable cost on representative tasks |
| Faster adoption: useful audit/review results and decision capture without requiring a full concept map | Quickstart checks, map-independent decisions, context, and impact implemented | Reliable use during ordinary tasks without repeated Mason-specific prompting |
| Stronger knowledge provenance: proposals versus accepted decisions, source and owner, reviewable re-verification | Proposal/review history and provenance implemented; accepted constraints survive pending proposals | Evidence that growing teams can keep knowledge reviewed, appropriately scoped, and current |
| Established quality checks: combine Mason knowledge with security, complexity, duplication, and test evidence | Vitest JSON and SARIF evidence imports implemented, with freshness and decision associations | Representative use of those checks in real projects and evidence that the associations improve review |

Confluence was explicitly given lower priority until customer demand justifies further investment. Keep that ordering visible when choosing work.

The broader growth requirements below are a synthesis of that goal and those priorities. They are not limited to the most recent repair feature.

| What changes as a project grows | What Mason needs to make dependable |
|---|---|
| People and assistants lose the reasons behind existing choices | Preserve rationale, rejected approaches, incident lessons, and constraints with their sources; retrieve them at the relevant task |
| Features spread across modules, services, and teams | Respect local scope and ownership, surface cross-boundary change impact, and support distributed project instructions |
| Decisions evolve and their evidence ages | Keep operative constraints distinct from proposals, expose unknown or changed evidence, and support review and retirement without silently losing history |
| Small edits have distant consequences | Combine intent and historical change partners with actual test and analysis evidence; distinguish a useful association from a proven violation |
| Sessions end, branches change, and agents switch | Resume relevant knowledge and unfinished reviews using the correct repository state, with explicit uncertainty when continuity cannot be established |
| Knowledge and findings accumulate | Retrieve concise relevant evidence, control scan and context costs, and give advisories a review lifecycle so old warnings do not become permanent noise |

The product is not yet proven to fulfill that ambition. The [release history](CHANGELOG.md) records substantial implementation progress. The initial patch comparison does not demonstrate better patches, and passing software tests do not establish spontaneous assistant use, long-term team adoption, or large-repository performance. [Patch evaluation documentation](bench/harness/patches/README.md) describes the current evaluation mechanism.

The most recent discussion proposed **dependable automatic use** as the next milestone within this broader roadmap:

1. Trigger relevant checks through host integrations and preserve original evidence before documentation edits, within standing project authorization.
2. Resume an active repair across sessions and verify it after edits and the final documentation commit.
3. Use cached, change-scoped checks and concise results, with access to full evidence.
4. Evaluate ordinary prompts such as "rename this module" without telling the assistant to use Mason.

The maintainer subsequently authorized implementing the shared automation core and Claude Code/Codex adapters. That implementation is now present in the repository, **unreleased**: `mason-auto` and `mason_automation` retain repair evidence across sessions, isolate branch/worktree state, cache checks by evidence dependencies, and return concise results. Installation and observed hook execution are reported separately. Original findings survive later edits and commits; advisory approval is still a separate review.

The new [automation evaluation](bench/harness/automation/README.md) separates deterministic event replay from real host sessions. Both adapters passed the rename/control replay. Live Codex and Claude Code smoke tests each passed both ordinary requests with all five lifecycle events, original capture before edits, and verification after the final commit. Neither host caused an unnecessary continuation on the control. Claude's initial attempt was blocked by expired OAuth credentials; after the maintainer restored the login, both scenarios passed on the same build. [Recorded smoke results](bench/harness/automation/SMOKE_RESULTS.md) identify the tested build and evaluation limits. These are mechanism and smoke-test results, not evidence of a lower mistake rate, an acceptable population false-positive rate, or large-repository performance.

Remaining gaps include broader ordinary-task evaluations, native verification on additional host versions and environments, instruction-file discovery beyond `AGENTS.md`, `CLAUDE.md`, and `.claude/CLAUDE.md`, a persisted advisory review disposition, and cost/latency as inventory and retained evidence grow. Evidence is local to the worktree; CI cannot reconstruct uncaptured pre-edit state. The implementation has explicit inventory and retention bounds and reports unsupported evidence rather than evicting unresolved findings. Keep this milestone within the broader growth roadmap.

Judge future progress by outcomes: appropriate activation without reminders; fewer repeated mistakes and missed updates; false-positive and irrelevant-context rates; latency and token cost as repository size, history, and knowledge grow; and whether another session can recover the right intent and unfinished work. Agree on acceptance thresholds before claiming a milestone is met.

For future strategy and prioritization tasks, read this roadmap and its linked Mason decision first. Preserve the distinction between maintainer direction, shipped capabilities, measured results, and assistant proposals. Update the relevant status when work or evidence changes. Do not replace this roadmap with the latest small feature discussion.

Sources: the maintainer conversation captured here, including the growth-focused question and explicitly listed five priorities; [CHANGELOG.md](CHANGELOG.md) for released behavior and the reported evaluation result; [README.md](README.md) and the current implementation for workflow scope. No permalink or full export of the earlier assessment was provided. The existing [strategy record](.mason/decisions/mason-s-lane-is-the-executable-external-layer-distributed-vi.json) and [tool-adoption record](.mason/decisions/tool-salience-lives-in-claude-md-not-tool-descriptions.json) provide older related context, remain legacy/unreviewed, and are not substitutes for this roadmap.
