# Agent behavior pilot

This experiment asks whether Mason reduces errors left after an ordinary task, without increasing unrelated edits. It compares three conditions on fresh copies of the same synthetic project:

| Condition | Setup |
|---|---|
| baseline | Normal project instructions; no Mason MCP server or hooks |
| instructions | The same project plus current Mason guidance and MCP tools; hooks disabled |
| hooks | The same Mason guidance and tools, plus automatic hooks |

The first pilot uses Claude so every session has an explicit dollar budget. It holds the requested model, effort, time limit, tools and task prompt constant. Automatic memory and session persistence are disabled in all conditions. It does not measure native memory quality. A second-host replication is a separate experiment, not a pooled comparison.

## Planned tasks and outcomes

The follow-up [finding delivery diagnostic](DELIVERY_EXPERIMENT.md) uses three staged rename variants with references in multiple documents. Select complete matched blocks with `--tasks rename-root,rename-nested,rename-backlog --repeats 1` (nine sessions). Task selection is frozen on resume. The [initial incident review](INCIDENT_REVIEW.md) is an unblinded assessment, not an independent score.

Ten variants cover three module renames, two command renames, two unrelated-edit controls, and three incident investigations. Some projects start with an unrelated broken reference. Each task has three repeats in each condition: **90 planned sessions**. A seeded shuffle orders matched task/repeat blocks and randomizes the conditions within each block.

The primary automated outcome for the seven editing tasks requires a completed agent session, working executable behavior, correct affected documentation, and no unrelated edits. Grading reads files and runs the fixture directly; it never asks Mason to grade itself. Failed model sessions count as failures. Infrastructure interruptions stay visible and are not silently retried or treated as successes.

Incident investigations are separate: the harness exports the evidence, final response, and saved proposals/notes for independent review. Reviewers judge factual support, uncertainty, tentative remedies, attribution and duplication. Merely producing a JSON record is not success. A baseline agent can save a Markdown note; Mason agents can save proposals. No record is automatically accepted. Lesson tasks are excluded from the automated success rate until a separate semantic analysis is performed.

Other outputs include scope violations, elapsed time, reported dollars, raw token usage, MCP availability, model identity and hook activation. Hook receipts preserve the notice and subsequent repository diffs. Inspect those alongside transcripts to identify ignored feedback, relevant repairs and unnecessary work. A notice followed by an edit is observational evidence, not proof that the notice caused the repair. The randomized conditions estimate the overall effect.

Review packets hide condition labels behind opaque run IDs. The format of a proposal or mention of Mason can still reveal the condition, so this is partial blinding. Give reviewers only `review/`; keep `report.json`, which maps IDs to conditions, separate.

## Run safely and reproducibly

```bash
npm run build
# No model calls: tests the real fixture/observer/grader path across 30 cells.
npm run bench:behavior -- --validate --repeats 1 --output /tmp/mason-behavior-validation

# No model calls: writes the complete schedule and locks the protocol settings.
npm run bench:behavior -- --plan --budget-usd 0.50 --output /tmp/mason-behavior-pilot

# Paid calibration: attempt only the first nine scheduled cells ($4.50 configured cap).
npm run bench:behavior -- --live --resume /tmp/mason-behavior-pilot --limit 9

# Continue the remaining schedule after reviewing calibration results.
npm run bench:behavior -- --live --resume /tmp/mason-behavior-pilot
```

The default is `claude-opus-5-5`, medium effort, 180 seconds and $0.50 per session: a $45 configured ceiling for all 90 attempts. The time ceiling is 4.5 model-hours plus fixture/grading overhead, although typical sessions may finish much sooner. These are limits, not an estimated invoice. Inspect budget-truncated sessions before deciding whether the protocol needs a higher cap; changing limits requires a new experiment rather than selectively rescuing failures.

`--limit` bounds attempts in one invocation. Resume preserves completed, failed and interrupted rows; it does not retry them. A lock prevents concurrent execution of the same schedule. After an ungraceful process exit, confirm its owner has exited before removing `run.lock`. Build and protocol hashes must match the saved plan. Validation runs cannot be resumed as paid results. Fresh conversations and fixture directories keep repeats separate, and output is saved after each attempt.

`report.json` contains the full data and paths to retained fixtures; `report.md` summarizes outcomes and costs. Transcripts, MCP observations, hook receipts and reviewer packets remain beside the report. Generated results are ignored by Git under `bench/harness/results/` when the default location is used. Agent processes can access the machine according to the existing automation harness's permissions; these synthetic fixtures contain no credentials, and this is not an adversarial isolation benchmark.

## Interpretation

Compare instructions minus baseline for the Mason guidance/tools bundle, then hooks minus instructions for the incremental effect of hooks. Preserve integration failures in the results and investigate them before attributing a difference to Mason's behavior. Verify actual model identities against the requested model.

The report pairs matching task/repeat cells and gives exploratory 95% bootstrap intervals, resampling whole task families. Seven editing families are a small, partly related synthetic sample; repeating them does not turn this into 63 independent real-world tasks. Treat the pilot as evidence about the tested fixtures and as a check of the experiment itself. Examine documentation errors, scope violations, cost, and individual traces before deciding on a larger study. No live improvement claim is supported by deterministic validation or incomplete review packets.
