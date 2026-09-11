# Mason: becoming the definitive context engineer

Originally captured by Codex on 2026-09-05, against release 0.11.0. Combined priorities updated on 2026-09-09, against release 0.16.1.

Linked Mason memory: [direction and growth roadmap](.mason/decisions/mason-s-definitive-context-engineer-direction-and-growth-roa.json), recorded as a sourced proposal.

The maintainer's ambition is for Mason to become the definitive context engineer as projects grow: help coding assistants retain engineering intent, respect evolving constraints, notice coupled changes, and avoid repeating mistakes that create technical debt.

The earlier question was: "how close is this to becoming the definitive context engineer that we talked about? think about what usually happens as projects grow". This document preserves the direction recoverable from the conversation and the subsequent implementation. The earlier assistant assessment is not available verbatim. The growth requirements below are explicitly a synthesis, not a recovered quotation or a claim that every proposed solution was approved.

The maintainer requested that this direction be recorded and later asked to combine the ranked knowledge-debt ideas with the maintenance workflow below. This authorizes updating the roadmap and linked memory; the delivery sequence is a recommendation, not a claim that its implementation or every milestone has been approved. No roadmap owner or formal acceptance has been recorded.

## Combined priorities: capture, maintain, and enforce

Context engineering supplies relevant information for the current task. Managing knowledge debt keeps the project's reasoning useful and trustworthy as its code, dependencies, and team change. Mason's proposed product loop is **capture useful rationale → review → retrieve during work → reconsider when evidence changes → reaffirm, revise, or retire**. Constraints that can be tested should also gain executable checks.

The earlier ranking described likely everyday usefulness at Mason's current stage. The maintenance proposal supplies the lifecycle those ideas need. Preserve the ranking while distinguishing it from implementation order:

| Earlier rank | Idea | Place in the combined roadmap |
|---|---|---|
| 1 | Capture knowledge from review corrections | First product outcome to prove: preserve a useful, sourced correction during ordinary work and prevent the mistake in a fresh session. Deliver alongside the maintenance foundation below. |
| 2 | Turn constraints into executable checks | Next major capability after that loop: link accepted, testable constraints to reviewed tests or established analysis rules and current execution evidence. |
| 3 | Detect contradictory guidance | Surface conflicting claims with their sources, scope, approval, and freshness for review; do not silently select or rewrite the winner. |
| 4 | Context debugger | Explain why knowledge was included, omitted, or treated as uncertain. Include basic diagnostics in each milestone; a dedicated debugging workflow follows contradiction review. |
| 5 | Conditions for reconsidering decisions | Begin now with existing anchor changes and durable review outcomes. Add explicit dependency, assumption, and retirement conditions after the basic lifecycle works. |
| 6 | Track changes across repositories | Expand when real multi-service users justify the added identity, access, ownership, and revision handling. Could move into the top two for those users. |
| 7 | Measure individual context contributions | Run evaluation throughout, including comparisons with ordinary project notes and removal of individual context sources. Low customer-facing rank does not make this last in the build order. |

### First milestone: a useful lesson survives change

**Slice A — close the maintenance gap first.** Basic proposal capture, decision review, hooks, and retained repair evidence already exist in 0.16.1. At that release, retained audit advisories remained `review-required` without a persisted assessment that verification could consume. The implementation authorized on 2026-09-11 builds on the existing CLI/MCP and decision history:

- Record an advisory's assessment, reviewer, reason, and exact evidence inspected. Distinguish addressed, inapplicable, and deferred outcomes; deferral remains outstanding. Reuse decision acceptance, reaffirmation, revision, and retirement for decision findings. Closing an advisory must not implicitly approve a decision.
- Bind the assessment to the finding, relevant code/document evidence, and decision revision. Reject a stale prepared review. Preserve closure across sessions, unrelated commits, and the final metadata commit; reopen it when relevant evidence changes. Unavailable evidence remains unknown.
- Keep original findings and review history. Deduplicate equivalent findings across retained baselines and keep completed work out of the active queue without deleting its evidence. Version review outcomes needed by other clones; keep execution receipts and caches local. No GitHub/GitLab connection is required for this first milestone.

Acceptance: a recorded review closes only its inspected scope; a fresh session and the final commit retain it; a relevant change reopens it; unrelated changes do not. Deferred findings, missing evidence, conflicting edits, and unapproved decisions never become a clean result merely to reduce the backlog.

**Slice B — prove selective correction capture and maintained reuse.** Extend the existing investigation/capture evaluation to ordinary review corrections. An assistant should propose only a reusable project constraint or explanation that could change a future engineering choice. Keep the reason, narrow scope, and known source; preserve unknown attribution. Skip code summaries, temporary instructions, duplicates, and speculative conclusions. Capture starts from the current conversation or local review evidence; hosting-service ingestion can follow demonstrated demand.

Bring a small number of relevant open reviews into the current task, with the full backlog accessible separately. The assistant prepares the original rationale, relevant diff, available test evidence, and a proposed outcome. Record approval only through the authorized project review workflow. Preserve prior accepted guidance while its replacement is still proposed, and preserve history after retirement.

Acceptance: an ordinary correction yields a useful sourced proposal without mentioning Mason; after semantic review, a fresh session avoids the mistake. Change the underlying assumption, review the revision or retirement, and verify that another fresh session uses the updated guidance. An unrelated task creates no record and causes no unnecessary review.

The first development case is the [conditional R8 startup lifecycle](bench/harness/knowledge/LIFECYCLE.md), reconstructed from Jacket's unused-scheduler removal, later reintroduction and repeated startup crash. It compares Mason with ordinary notes through two review boundaries and actual reduced JVM release checks. It is not a full Android reproduction or proof of an advantage over notes. Additional incident cases and independent ElevenLabs validation follow the development trial.

The [first live Codex development trial](bench/harness/knowledge/LIFECYCLE_RESULTS.md) captured useful proposals and preserved release startup in both arms, with no records on the unrelated control. Notes completed the reviewed revision and subsequent reuse; Mason created a second proposal instead of revising the original accepted lesson. Revision guidance now explicitly favors the existing ID when that lesson's assumptions, scope or recommendation changes, while allowing distinct records and retaining approval boundaries. In the [unchanged repeat and interrupted-upload probe](bench/harness/knowledge/REVISION_GUIDANCE_RESULTS.md), both Mason and notes passed reviewed revision, fresh reuse and no-extra-record controls. These small development trials support the guidance change; they do not establish superiority or long-term reliability. Broader independent cases and distinct-lesson controls remain to be evaluated.

### Subsequent delivery

1. **Enforce testable constraints.** Link a specific accepted revision to a reviewed regression test or existing check. Demonstrate that a deliberate violation fails and a valid alternative passes. Execution evidence must stay current; passing one check does not prove an entire decision, and revised or retired constraints require reviewing their checks too.
2. **Review contradictions.** Begin with overlapping scope and explicit incompatible claims. Present both sources and a proposed resolution; distinguish an actual conflict from historical, superseded, or differently scoped guidance. Measure false alarms before broadening detection.
3. **Make context explainable.** Build the dedicated context debugger around retrieval reasons, exclusions, freshness, and missing evidence. Validate that it helps diagnose a missed lesson or irrelevant result. Basic diagnostics and evaluation traces remain part of earlier work.
4. **Express reconsideration conditions.** Extend file-anchor triggers with reviewable conditions such as a dependency upgrade or a workaround's removal criterion. A trigger requests investigation; it does not prove the decision obsolete. Avoid recurring review based solely on age.
5. **Coordinate repositories when needed.** Start with a concrete shared-contract change across known repositories, preserving each revision and owner. Require evidence of missed cross-repository updates before expanding scope. Confluence remains lower priority until customer demand justifies it.

### Evaluation throughout

Extend the [knowledge evaluation](bench/harness/knowledge/README.md) through capture, reviewed reuse, changed assumptions, reviewed revision/retirement, and subsequent reuse. Include unrelated-change, no-capture, missing-evidence, and valid-alternative controls. Compare Mason with ordinary notes given the same task evidence; retain missed captures, rejected proposals, and failed sessions. Separate deterministic mechanism checks from live agent outcomes and real-project evidence.

Measure repeated mistakes and missed updates, capture usefulness, unnecessary reviews, incorrect closures, repeated warnings, irrelevant context, review effort, latency, and token cost. Use context-source ablations to investigate contributions; retrieval or injection alone is not proof of usefulness. Define thresholds and representative tasks before live evaluations. A smaller backlog counts as progress only when knowledge remains trustworthy.

On 2026-09-11 the maintainer authorized implementing **Slice A with its verification cases**, alongside broader audit evaluation and their ongoing decision-record trial. The unreleased implementation adds prepared advisory assessments, persisted addressed/inapplicable/deferred outcomes, scoped reopening, and reuse of decision reviews. [Lifecycle regressions](test/advisory-review.test.ts) cover final metadata commits, fresh clones, relevant and unrelated changes, stale tokens, concurrent submissions, malformed or unavailable evidence, and closure across multiple retained baselines. These are deterministic mechanism checks; ordinary-task use, review effort, and long-term usefulness remain to be measured. Slice B remains the next knowledge outcome to prove on that lifecycle. The original five priorities below remain the product's broader commitments.

## Initial-check precision and language integrations

On 2026-09-10 the maintainer authorized the shared foundation after an exploratory ElevenLabs trial. The current unreleased implementation expands discovery to nested instructions and READMEs with exact filename casing, preserves path/command scope, makes speculative omissions advisory, and carries scope through repair baselines and cache dependencies. New recheckable candidates can cease to be detected; historical advisories still need an assessment. Native validators can import individual outcomes and environment metadata through `mason-check-json`, alongside Vitest and SARIF.

### Separate feature: documentation examples backed by tests

On 2026-09-11, review of existing documentation-test tools changed the implementation approach. Treat executable documentation as a separately scoped feature. Prefer established facilities such as [Rust documentation tests](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html), [Python doctest](https://docs.python.org/3/library/doctest.html), [Go examples](https://pkg.go.dev/testing#hdr-Examples), and [TypeScript Twoslash](https://www.typescriptlang.org/dev/twoslash/). Evaluate integration with the project's existing tooling before maintaining custom example conventions. The exploratory custom TypeScript adapter was paused and kept outside the production source tree; automatic compiler selection and snippet execution remain unimplemented.

An example's language, package/version, setup, intended failure or success, and expected behavior need explicit scope. Compiler acceptance, successful execution, behavioral assertions, source synchronization, and a recorded human assessment establish different facts. Report exactly which examples and environments were checked, preserve unsupported/unchecked scope, and do not label arbitrary README snippets correct merely because a compiler accepts them. The connected assistant can help establish a reviewed repeatable check; Mason maintains its association with current guidance and evidence. Execution belongs to explicit validation or CI, outside routine hooks. Examples included from tested source files are another useful integration path.

First evaluation: use existing tooling on the two exploratory ElevenLabs examples, corrected alternatives, fragments, mixed-language documents, and deliberate expected-error examples. Measure actionability and setup effort before adding an adapter. This is proposed work; neither integration nor a population accuracy claim is established. [Prior research](https://arxiv.org/pdf/2308.12079) also distinguishes compiler diagnostics from runtime correctness and warns that missing context or error-reducing edits can distort conclusions.

### Initial-check follow-ups

- Deliver the completed passive audit foundation independently of executable documentation. Evaluate findings on multiple repository layouts and languages; distinguish correct findings from useful findings and keep scope omissions visible.
- The [2026-09-11 four-repository evaluation](bench/audits/2026-09-11.md) found a directory-alias abort (fixed), three questionable directory-omission prompts, and twenty manifest-recency advisories requiring assessment. Final passive runs reported no issues across 26 discovered documents. This is exploratory evidence, not a precision or usefulness score. Evaluate document intent and release-metadata noise before broadening default checks.
- Prioritize the advisory assessment lifecycle and the maintainer's real decision-record trial. Use those results to guide capture, retrieval, review effort, and reconsideration work.
- Keep cache-dependency validation as a later investigation. The controlled Turbo experiment established that one test-configuration edit did not change its task hash; it did not demonstrate an actual stale cached test execution. Do not mutate source during normal onboarding to probe this.

This foundation supports adoption and executable constraints; it does not replace the correction-capture and maintenance milestone above.

## Original direction and shipped evidence

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

An earlier discussion proposed **dependable automatic use** as the next milestone within this broader roadmap:

1. Trigger relevant checks through host integrations and preserve original evidence before documentation edits, within standing project authorization.
2. Resume an active repair across sessions and verify it after edits and the final documentation commit.
3. Use cached, change-scoped checks and concise results, with access to full evidence.
4. Evaluate ordinary prompts such as "rename this module" without telling the assistant to use Mason.

The maintainer subsequently authorized implementing the shared automation core and Claude Code/Codex adapters. Release **0.12.0** includes that implementation: `mason-auto` and `mason_automation` retain repair evidence across sessions, isolate branch/worktree state, cache checks by evidence dependencies, and return concise results. Installation and observed hook execution are reported separately. Original findings survive later edits and commits; advisory approval is still a separate review.

The new [automation evaluation](bench/harness/automation/README.md) separates deterministic event replay from real host sessions. Both adapters passed the rename/control replay. Live Codex and Claude Code smoke tests each passed both ordinary requests with all five lifecycle events, original capture before edits, and verification after the final commit. Neither host caused an unnecessary continuation on the control. Claude's initial attempt was blocked by expired OAuth credentials; after the maintainer restored the login, both scenarios passed on the same build. [Recorded smoke results](bench/harness/automation/SMOKE_RESULTS.md) identify the tested build and evaluation limits. These are mechanism and smoke-test results, not evidence of a lower mistake rate, an acceptable population false-positive rate, or large-repository performance.

A subsequent Codex trial used the locally packaged build in the maintainer's existing Kotlin Multiplatform/iOS repository. An ordinary rename triggered the hooks, retained a newly stale documentation claim before its repair, and kept verification incomplete while documentation was uncommitted. After an explicit commit-and-check request, all six checks passed against the new commit and both original baselines remained byte-for-byte unchanged. No forced continuation was needed. The maintainer deferred the controlled live resumption test and requested cleanup of the trial; its evidence and test commit were archived locally before restoring the original repository state. The [evaluation guide](bench/harness/automation/README.md) records the proposed fault-injection scenario without claiming it has been implemented or passed.

Release **0.13.0** adds unified setup for both hosts: a private pinned runtime, MCP configuration, native assistant instruction entry points, hooks, and retained audit evidence captured before instruction edits. Activation now requires observed MCP context use and a complete hook lifecycle for the current setup revision and worktree/branch; native host trust remains separate. The release also narrows cache invalidation to each check's inputs, records failed or unfinished execution attempts, and conservatively filters Android release-version-only dependency advisories. Packaged protocol replay and fresh-clone recovery passed; these results establish setup and evidence handling, not a measured reduction in engineering mistakes.

Release **0.14.2** addresses a setup failure reported on another laptop: the automation inventory counted more than 100,000 filesystem paths without distinguishing their relevance to the checks. The affected laptop's actual inventory has not been inspected. Discovery now follows check dependencies, uses Git and Mason exclusions for module source, and retains explicit ignored-path/workspace evidence. A regression covers setup with 100,001 ignored generated files, preservation of the initial baseline, and detection of a subsequent source module. This covers that failure mode; it does not establish performance across large repositories generally.

Version **0.16.1** adds reference evidence that separates resolved imports from textual mentions and uncertain names, explicit investigation-capture guidance, and a [two-session knowledge evaluation](bench/harness/knowledge/README.md). Candidate Claude Code and Codex smoke runs each captured a sourced proposal without Mason in the task prompt, retrieved it in a fresh session after separate review, and created the worktree in the reviewed directory. Their unrelated controls created no records. The [recorded results](bench/harness/knowledge/SMOKE_RESULTS.md) retain rejected proposals, earlier harness failures, residual capture noise, and reviewer limitations. Existing guidance and ordinary notes also captured the lesson in a prototype comparison; a performance advantage is not established.

Remaining gaps include broader ordinary-task evaluations, native verification on additional host versions and environments, broader native-validator adapters, real-project evaluation of the new advisory review lifecycle, and cost/latency as relevant inputs and retained evidence grow. Execution evidence is local to the worktree; CI cannot reconstruct uncaptured pre-edit state. Shareable advisory assessments now live in Git. The implementation bounds scoped discovery and retention and reports unsupported evidence rather than evicting unresolved findings. Keep this milestone within the broader growth roadmap.

Version **0.16.2** addresses team-adoption feedback before the next knowledge-lifecycle milestone: generated hooks are quiet for missing executables and locally unconfigured checkouts, while active failures stay visible. Read-only observations avoid repository rescans without refreshing verification; potentially mutating tools retain original evidence capture. [Data/network documentation](docs/data-and-network.md), internal-mirror version requirements, and [hook measurements](docs/hook-performance.md) make the operating costs and boundaries reviewable. Local regression and benchmark evidence does not establish company approval, universal hook coverage, or large-repository performance. The advisory review-to-resolution implementation followed in the unreleased Slice A described above.

Judge future progress by outcomes: appropriate activation without reminders; fewer repeated mistakes and missed updates; false-positive and irrelevant-context rates; latency and token cost as repository size, history, and knowledge grow; and whether another session can recover the right intent and unfinished work. Agree on acceptance thresholds before claiming a milestone is met.

For future strategy and prioritization tasks, read this roadmap and its linked Mason decision first. Preserve the distinction between maintainer direction, shipped capabilities, measured results, and assistant proposals. Update the relevant status when work or evidence changes. Do not replace this roadmap with the latest small feature discussion.

Sources: the maintainer conversation captured here, including the growth-focused question and explicitly listed five priorities; the seven-idea ranking quoted by the maintainer on 2026-09-09 and the preceding review-to-resolution proposal, combined at their request; [CHANGELOG.md](CHANGELOG.md) for released behavior and the reported evaluation result; [README.md](README.md) and the current implementation for workflow scope. The combined sequence and acceptance criteria are Codex's synthesis. No permalink or full export of the original assessment was provided. The existing [strategy record](.mason/decisions/mason-s-lane-is-the-executable-external-layer-distributed-vi.json) and [tool-adoption record](.mason/decisions/tool-salience-lives-in-claude-md-not-tool-descriptions.json) provide older related context, remain legacy/unreviewed, and are not substitutes for this roadmap.
