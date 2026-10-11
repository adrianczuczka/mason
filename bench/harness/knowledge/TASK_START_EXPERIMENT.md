# Task-start decision delivery experiment — 2026-10-10

Status: harness-only probe completed; production candidate, Stage A and full Stage B comparisons pending. The [probe results](TASK_START_PROBE_RESULTS.md) verify synthetic hook consumption but expose a weak-overlap false positive; current matching fails the automatic-delivery noise gate. A separately frozen [C1 lifecycle subset](CANCELLATION_LIFECYCLE_RESULTS.md) completed eight sessions comparing current Mason with strong documents, with no correctness advantage. Follow-up to the [standard delivery results](STANDARD_DELIVERY_RESULTS.md) at `ed8a2e4`. The original question was whether relevant decision knowledge could reach a fresh agent before its first action, including when subsequent inspection and edits use Bash. A second question is whether that knowledge changes patch outcomes. Keep these claims separate.

Revised on 2026-10-11 following the maintainer's agreement to narrow positioning and strengthen comparators. Stage A remains a bounded delivery investigation. Stage B now tests decision maintenance against an equally informed document workflow, and replaces the earlier eighteen-session reuse-only outline. The C1 subset used a stronger document comparator and a sourced constructed incident; the full comparison and independent maintainer review remain pending.

Current priority: the [reasoning-loop pilot](../../../ROADMAP.md#reasoning-loop-pilot-preparation-and-acceptance-gates) supersedes this protocol as the next product evaluation. Retain this delivery design and its results for reference. Production task-start delivery, further matcher tuning and the full 72-session schedule are deferred; the schedule is a planning estimate, not an approved or automatic next run. Reopen only if the reasoning-loop pilot identifies delivery as a material failure.

## Candidate and boundaries

Evaluate **Claude UserPromptSubmit**, rather than a repository-wide lesson dump at SessionStart. The host supplies the submitted task before model processing; SessionStart does not supply the task. The [official hook contract](https://code.claude.com/docs/en/hooks#userpromptsubmit) permits additionalContext alongside the prompt. Confirm the installed CLI's actual behavior with a controlled probe before relying on this contract. Hook stdout alone proves emission, not consumption; retain debug evidence and subsequent behavior where available.

Reuse task matching from `src/context/assemble.ts` as the initial candidate. Its lexical matcher currently admits any positive score and may include proposed records; that is an evaluation starting point, not an established threshold for automatic delivery. Use operative accepted knowledge, existing anchors and provenance/freshness labels. Keep pending revisions visibly separate from accepted content. Do not promote proposals, invent approval requirements or treat empty matches as proof of safety.

Bound the initial automatic payload to three decisions and 6,000 UTF-8 bytes including labels. Preserve each selected decision's full operative body; omit whole records that do not fit rather than silently cutting a constraint. Record omissions locally in the evaluation receipts. These are provisional experiment limits, not published product defaults. Evaluate weak lexical matches and map-free operation before choosing a production threshold. Do not require a map, parse shell command targets, add an LLM selector or block prompts/edits in this slice.

Keep existing file delivery and audit behavior intact. Confine selection to the active checkout. Process prompt text transiently; do not add raw prompt storage to production state. Evaluation transcripts contain only synthetic tasks. SessionStart remains quiet about task-specific lessons. Follow-up prompts may change the task, so scope delivery to the current prompt and session rather than assuming the first prompt describes all later work.

## Stage A: delivery and noise

Use the existing startup fixture only as development evidence. Compare current standard hooks with the candidate under identical MCP availability, project instructions and lesson records. Do not instruct either agent to consult Mason. Require Bash-only inspection/editing in a labelled coverage case; retain an ordinary unrestricted case separately.

| Control | Required evidence |
|---|---|
| Relevant task with no file names | Operative lesson selected from ordinary task wording; candidate context emitted before the first model action |
| Relevant Bash-only task | Same timing without Read/Edit/Write hooks; actual edit and private native check graded independently |
| Unrelated task | No startup lesson body or approval interruption; no new knowledge record |
| Weak vocabulary overlap | Generic shared words do not create a useful-match claim; retain false positives and misses |
| Repeated/follow-up prompts | Unchanged relevant body delivered once; a later newly relevant lesson can appear |
| MCP then supported file read | Count repeated operative bodies across prompt, MCP and file hooks separately |
| Changed source, accepted revision, retirement | Freshness and updated operative guidance remain explicit; obsolete guidance is withdrawn |
| Pending proposal or conflicting policy | Accepted content remains distinguishable; conflict inspection does not become automatic acceptance |
| Missing/malformed prompt, inactive setup, foreign checkout | No unintended delivery; existing activation/audit diagnostics remain observable |
| Many/large matches | Deterministic bounded selection and omission receipts; no partially truncated constraint |

Cross-channel deduplication needs an exact content identity, not only a decision ID: record operative revision, approval and source/freshness state. A get_context response that merely names a record does not prove its full body arrived. Suppress later hook copies only when equivalent content was observed; changed evidence must remain eligible. Leave explicit MCP responses complete during this experiment and count their repeated bytes. Shared hook deduplication cannot by itself eliminate duplication from an agent requesting MCP context again.

Before live calls, deterministic tests must prove selection, payload bounds, delivery event shape, deduplication and updated/withdrawn guidance. Tests must also preserve audit receipts, Stop behavior and approval history. A host probe must establish UserPromptSubmit invocation and available consumption evidence for the installed version. Freeze prompts, candidate selection rules, sources, binaries and graders after development validation; failed or interrupted runs remain separate, with no automatic retries.

Use two arms, two repetitions and four initial live tasks: relevant unrestricted, relevant Bash-only, unrelated and weak-overlap. Rotate arm order: 16 sessions, $1/session and 180 seconds/session, maximum configured spend $16. Keep host model/effort defaults and record actual identity, versions and token/cache accounting. This run is a delivery/noise comparison; repeated startup variants are not independent prevention incidents. Apply the existing provisional 25% paired time/token overhead diagnostic, report dollars and hook payload bytes, and retain failures rather than tuning selection during the run.

Stage A passes only if relevant Bash cases receive the operative lesson before first action, irrelevant controls stay quiet, deterministic update/withdrawal checks pass, and existing correctness does not regress. If a paraphrase misses, or weak overlap injects unrelated guidance, diagnose selection before adding a broader automatic rollout. Successful emission with unknown consumption remains explicitly unverified.

Stop after this frozen comparison to publish the outcome and choose a next step. Do not keep tuning and rerunning the startup fixture as evidence of a competitive advantage. Prepare Stage B incident evidence alongside the harness-only probe; further production expansion depends on outcome or maintenance benefit, not hook timing alone.

## Stage B: outcome evidence

Select at least three new incident families before tuning against them. Each needs a traceable incident/correction, a reviewed reusable lesson, a fresh task that could repeat the mistake, a private checker that fails a deliberate violation and passes a valid alternative, and a matched unrelated task. Source public repository history or authorized local evidence; preserve uncertainty and attribution. The [candidate manifest](INCIDENT_CANDIDATES.md) starts three sourced families; C1 has a completed one-family pilot with synthetic coordinating-agent review, C2 has pinned historical source and isolated predicate validation for recovery development, while distributed fixtures, full prepared-header validation and independent lesson review remain pending; C3 still awaits pinning and validation. No participants or independent maintainer reviews have been secured. The startup, interrupted-upload and worktree fixtures are already development evidence and do not qualify as held-out incidents. C1 is now exposed pilot evidence and must not be retuned and counted as a new held-out success.

Freeze an incident manifest with source reference, selection reason, prior exposure, accepted lesson/review receipt, task, valid alternatives and checker. Do not put the intended solution into the task prompt. Keep incidental instructions, tools, starting files and facts matched across arms. Reviewer involvement and blinding must be recorded honestly; coordinating-agent review is not independent maintainer approval.

Compare current standard hooks, candidate task-start hooks and well-maintained notes. The document baseline receives the same operative accepted content, pending proposal, scope, sources, review receipts, revision/retirement history and changed-evidence facts, in readable Git-tracked documents. Its project instructions explicitly direct the agent to consult applicable guidance before edits, distinguish pending from accepted content, verify changed sources and propose maintenance without inventing approval. Provide equally prominent instructions in Mason arms. Do not hide the notes or make their interpretation depend on knowing Mason's storage format. Keep MCP available in both Mason arms. Freeze all arm instructions and record any remaining differences in delivery, evidence checks and maintenance workflow.

For each of three incident families, create four fresh-session tasks:

| Task | Required outcome in every arm |
|---|---|
| Relevant reuse with a pending replacement | Apply the accepted guidance when still applicable; do not silently promote the proposal |
| Changed assumptions with an accepted replacement | Inspect changed evidence, use the current accepted revision and preserve history; propose further maintenance if the evidence warrants it |
| Retired guidance | Distinguish the historical reason from an active constraint; avoid enforcing retired advice, and validate the current alternative |
| Matched unrelated task | No unnecessary lesson, maintenance request or interruption; correct ordinary patch |

Freeze the task's authority explicitly. A request to implement a change must not be graded as requiring another confirmation unless the matched project policy actually requires it. Technical constraints and approval authority are separate. Maintenance proposals are graded against sources; simulated fixture review does not become authenticated team approval.

The revised full schedule is three families × four tasks × three arms × two repetitions: 72 sessions, maximum configured spend $72 at $1/session and 180 seconds/session. This is a scoped budget, not an executed run; incident/checker validation and protocol freezing must precede model calls. A no-retrieval ablation, if needed, is a separate labelled mechanism test and cannot substitute for the ordinary-work comparison.

Sourcegraph retrieving the same decision documents is an additional planned comparator. Its documented history/search and Deep Search tools can expose rationale as well as code. [Sourcegraph MCP documentation](https://sourcegraph.com/docs/api/mcp) Before adding that arm, verify an accessible instance, tools, indexed repository revision and document completeness; keep facts and task instructions matched, record actual calls and costs, and freeze a separate protocol extension. The fourth arm would add 24 sessions ($24 configured host cap; Sourcegraph service charges recorded separately). No access or integration has been secured. A local search surrogate cannot be reported as Sourcegraph, and an unavailable arm cannot support a superiority claim. Do not build a production Sourcegraph integration as a prerequisite to this experiment.

Grade correct patch/check outcome, relevant knowledge before the first risky action, accepted/proposed/retired interpretation, changed-evidence handling, unrelated noise, repeated bodies, review burden and cost. Measure setup and human review time separately from agent runtime; unknown effort is not zero. Record whether maintenance proposals are useful, sourced and necessary, and how much correction they require. Report per-incident results as well as totals. If all arms succeed, conclude no observed correctness gain and compare maintenance effort and cost. If candidate succeeds where baseline fails, inspect the causal sequence and alternative explanations before claiming prevention. Repeated variants remain exploratory rather than population-level proof.

Prepare ordinary-work pilot criteria alongside the incident manifest: three to five maintainers, each with an actual reviewed correction, a later relevant task and a guidance-maintenance event. Record outcomes and total effort under their existing workflow and Mason, with exposure/order limits stated. Participants and outreach remain pending; do not contact maintainers without authorization. Before a pilot, agree with each maintainer what benefit would justify the review/setup effort. A positive delivery demonstration is insufficient to expand continuity, team features or search infrastructure; require repeatable prevention or maintenance benefit, or comparable correctness with lower total effort. If strong document workflows match outcomes at lower effort, narrow or improve Mason rather than claiming a moat.

## Deferred implementation order and decision

1. Add a harness-only UserPromptSubmit probe and selector measurements using existing decision matching; expose weak matches and payload omissions before changing production hooks.
2. Implement the smallest candidate adapter and shared delivery identity only after those measurements support its rules. Validate deterministic gates, then freeze and run Stage A.
3. Assemble and review the independent incident manifest, strong document instructions and ordinary-work pilot criteria while delivery work proceeds. Freeze Stage B before its model calls. Add a Sourcegraph arm only with verified access and a separate frozen extension.
4. Publish results and decide whether to ship task-start delivery, improve selection/deduplication, or stop the candidate. Gate broader development on demonstrated prevention or maintenance benefit. Do not mark the repeat-mistake milestone complete from hook timing alone.

This protocol records the experiment and its current progress. The completed laboratory probe changed no product behavior, global setup or release. Broader comparisons, production delivery and outreach remain pending.
