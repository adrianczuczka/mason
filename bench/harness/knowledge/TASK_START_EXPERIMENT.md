# Task-start decision delivery experiment — 2026-10-10

Status: scoped, not implemented or run. Follow-up to the [standard delivery results](STANDARD_DELIVERY_RESULTS.md) at `ed8a2e4`. The immediate question is whether relevant decision knowledge can reach a fresh agent before its first action, including when subsequent inspection and edits use Bash. A second question is whether that knowledge changes patch outcomes. Keep these claims separate.

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

## Stage B: outcome evidence

Select at least three new incident families before tuning against them. Each needs a traceable incident/correction, a reviewed reusable lesson, a fresh task that could repeat the mistake, a private checker that fails a deliberate violation and passes a valid alternative, and a matched unrelated task. Source public repository history or authorized local evidence; preserve uncertainty and attribution. No participants, new incidents or independent reviews have been secured yet. The startup, interrupted-upload and worktree fixtures are already development evidence and do not qualify as held-out incidents.

Freeze an incident manifest with source reference, selection reason, prior exposure, accepted lesson/review receipt, task, valid alternatives and checker. Do not put the intended solution into the task prompt. Keep incidental instructions, tools, starting files and facts matched across arms. Reviewer involvement and blinding must be recorded honestly; coordinating-agent review is not independent maintainer approval.

Compare current standard hooks, candidate task-start hooks and well-maintained notes containing the same reviewed facts. Keep MCP available in both Mason arms. Run three families × three arms × two repetitions: 18 sessions, maximum configured spend $18 at $1/session and 180 seconds/session. This schedule is scoped; it cannot run until incident/checker validation and protocol freezing are complete. A no-retrieval ablation, if needed, is a separate labelled mechanism test and cannot substitute for the ordinary-work comparison.

Grade correct patch/check outcome, relevant knowledge before the first risky action, stale/conflicting evidence handling, unrelated noise, repeated bodies, review burden and cost. Report per-incident results as well as totals. If all arms succeed, conclude no observed outcome gain. If candidate succeeds where baseline fails, inspect the causal sequence and alternative explanations before claiming prevention. Eighteen sessions remain exploratory rather than population-level proof.

## Implementation order and decision

1. Add a harness-only UserPromptSubmit probe and selector measurements using existing decision matching; expose weak matches and payload omissions before changing production hooks.
2. Implement the smallest candidate adapter and shared delivery identity only after those measurements support its rules. Validate deterministic gates, then freeze and run Stage A.
3. Assemble and review the independent incident manifest while delivery work proceeds. Freeze Stage B before its model calls.
4. Publish results and decide whether to ship task-start delivery, improve selection/deduplication, or stop the candidate. Do not mark the repeat-mistake milestone complete from hook timing alone.

This protocol records the next experiment. No product behavior, global setup, release, outreach or live-model run changes as part of this scoping step.
