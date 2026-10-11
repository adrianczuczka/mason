# Knowledge capture and reuse evaluation

An ordinary investigation should retain useful project rationale as a sourced proposal. After independent review, a fresh session should retrieve it and avoid repeating the mistake. An unrelated greeting edit must not produce a knowledge record.

The [development smoke results](SMOKE_RESULTS.md) record the completed two-host workflow, earlier failures, and the limits of the comparison.

The [conditional lifecycle case](LIFECYCLE.md) extends this through changed requirements, a second independent review, and another fresh session. It uses a reduced R8 startup reproduction drawn from a real removal/reintroduction incident, with an ordinary-notes comparison and a no-capture control.

The [reasoning-loop pilot in the roadmap](../../../ROADMAP.md#reasoning-loop-pilot-preparation-and-acceptance-gates) is the current next evaluation: select real capture and historical-recovery cases, review recovered reasoning, and test fresh-session reuse against strong documents and separately verified native memory. The [selected preparation cases](../../../ROADMAP.md#selected-preparation-cases--2026-10-11) pair exposed Requests history with Mason’s upcoming inspection-state decision. A genuine lost-rationale example, frozen case-specific protocol and runner support remain pending.

The earlier [repeat-mistake prevention experiment](PREVENTION_EXPERIMENT.md) defines delivery-oriented evaluation, including capture and existing-lesson paths, grading gates, cost diagnostics, and the hook/conflict controls that the current lifecycle runner does not yet cover.

The [2026-10-10 prevention baseline](PREVENTION_BASELINE_RESULTS.md) completed eight live Codex sessions. Both current Mason and notes passed; Mason reported higher token usage. That baseline disabled hooks; the subsequent delivery comparison is described below.

The subsequent [seeded standard-hook protocol](HOOK_PREVENTION_EXPERIMENT.md) and [twelve-session Claude results](HOOK_PREVENTION_RESULTS.md) separate notes, MCP-only and standard lifecycle hooks. Hooks added post-edit inspections but delivered no technical lesson before edits; MCP and notes supplied that rationale. The conflict case and development grading defects are retained explicitly. This comparison is separate from the Codex baseline.

The [standard delivery candidate protocol](STANDARD_DELIVERY_EXPERIMENT.md) and [sixteen-session results](STANDARD_DELIVERY_RESULTS.md) compare saved baseline binaries with integrated file-scoped injection. The candidate delivered one full lesson after a supported read before a later edit, without duplicate or unrelated hook lessons. Ordinary Bash workflows remained uncovered, and correctness matched baseline hooks. PreToolUse context does not replan an already requested tool call.

The previously scoped [task-start delivery experiment](TASK_START_EXPERIMENT.md) scopes UserPromptSubmit selection for Bash workflows, cross-channel duplication and unrelated-task noise. The [harness-only probe](TASK_START_PROBE_RESULTS.md) verified synthetic consumption but found a weak-overlap false positive; no production adapter or Stage A/B comparison has run. The [incident candidate manifest](INCIDENT_CANDIDATES.md) tracks C1’s completed lifecycle pilot, C2’s recovery preparation and C3’s unvalidated candidate; independent maintainer review remains pending. Sourcegraph is a planned comparator contingent on verified access.

The [24-task competing-lesson grid](SELECTION_GRID_RESULTS.md) compares three small selection rules; none clears the noise/coverage gate. The [C1 cancellation checker](CANCELLATION_CASE.md) pins an upstream correction and rejects a constructed cleanup violation while accepting two alternatives; its subsequent lifecycle pilot is below.

The subsequent [C1 lifecycle protocol](CANCELLATION_LIFECYCLE_EXPERIMENT.md) and [eight-session results](CANCELLATION_LIFECYCLE_RESULTS.md) compare current Mason with equally informed maintained documents through pending, accepted, retired and unrelated tasks. Both passed all four mechanical tasks; Mason added cost and a pending-proposal review continuation. Reviews were synthetic and unblinded, with no independent maintainer or Sourcegraph comparison.

The [focused operative-inspection follow-up](../../../ROADMAP.md#focused-live-inspection-results--2026-10-11) reran only the pending case in four fresh sessions. Both Mason agents used the new scope truthfully; the draft remained unresolved, notes also succeeded, and Mason cost more. Original grader failures caused by receipt key order remain preserved; a tested value-equality correction passes separate retained-artifact replay without new model calls. Runner: `node bench/harness/run-operative-inspection.mjs --validate` or `--live`; live defaults to four $1/180-second sessions. Freeze its protocol and hashes before any new run; repetition of this exposed case is not independent product proof.

The [interrupted-upload probe](UPLOAD.md) tests maintenance of deliberately seeded, reviewed knowledge under a changed retention assumption, with a local publishing simulator, fresh-session reuse and a first-upload control. It measures maintenance rather than original capture.

```sh
npm run build
npm run bench:knowledge -- --validate
# Small live capture/control run, using existing host authentication:
npm run bench:knowledge -- --live --hosts claude --arms candidate --variants sandboxes
```

The live run prints its report directory and stops with exit 2 when proposals await review. Inspect `review-requests.json`, source evidence, and transcripts. A reviewer creates a separate JSON file keyed by run ID:

```json
{
  "claude-sandboxes-1-candidate": {
    "recordDigest": "copy-the-exact-digest-from-review-requests.json",
    "verdict": "accept",
    "reviewer": "actual reviewing person or agent",
    "reason": "The proposed directory and lasting operational reason match incident K17; attribution is sourced and IDE causation remains uncertain."
  }
}
```

Use `reject` with a reason when the record is inaccurate, unsupported, or not useful. Do not edit the agent's proposal to make it pass. Eligibility checks only establish necessary fields and observation; keyword matches never grant semantic approval. Evaluate whether the record preserves the correct constraint and reason, cites the supplied evidence, distinguishes the suspected staging cause, attributes ownership accurately, and avoids turning temporary task restrictions into standing policy. Note unnecessary detail separately from material false claims.

```sh
npm run bench:knowledge -- --resume /absolute/path/to/run --reviews /absolute/path/to/reviews.json
```

Acceptance uses Mason's actual prepare/accept API and a labelled evaluation reviewer, then commits the real captured record. Notes baseline reviews are recorded separately without rewriting the notes. The second host session starts in a fresh clone with no previous conversation, transient incident material, existing worktrees, or link back to the first checkout. It must create branch `task-change` under the reviewed directory. Mason runs also require an observed `get_context` response containing the accepted decision before that branch's worktree exists. The control checks the actual edit and absence of new decisions.

## Comparisons

- `current`: frozen project guidance from Mason 0.16.0 (`current-guidance.md`).
- `candidate`: the managed guidance in the working source tree.
- `notes`: an explicit portable file-memory workflow using `PROJECT_NOTES.md`. It has the same incident evidence and an independent review. This is not a measurement of native Claude/Codex auto-memory.

Both Mason arms use the built server by default, isolating the guidance comparison. Pass `--current-server /absolute/path/to/released/mason-mcp.js` to compare a separately installed release as well. Server and guidance hashes are recorded; changing a server between capture and reuse is rejected. Build before starting a run and finish reuse before rebuilding that server.

The `sandboxes` and `checkouts` variants change the selected directory. All candidate directories are ignored in both fixtures, so ignore rules and host-default worktree paths cannot reveal the answer. All arms receive identical synthetic incident evidence. No private repository or user transcript is copied into fixtures. The transient incident is available to the investigation, but only reviewed project records cross into the fresh checkout.

Defaults: both hosts, all three arms, both variants, one repetition. Select `--hosts`, `--arms`, `--variants`, and `--repeats` to bound a comparison. Arm order alternates across repetitions/variants. `--model` selects a model for the chosen host; run hosts separately to specify different models. Model defaults remain host-controlled, so compare recorded versions/settings as well as outcomes. Default limits are 180 seconds per session and $1 per Claude session; Codex records usage but has no enforced dollar cap. No automatic retries.

## Evidence and limits

`--validate` exercises real MCP calls, review, commits, cloning, and grading using reference actions. It does not invoke agents or demonstrate spontaneous use. Negative tests reject missing capture, failed sessions, invented attribution, premature approval, changed proposals, wrong directory choices, late retrieval and unnecessary control records.

Live transcripts, observer receipts, captured records, independent review verdicts, session costs/usage and reports remain in the output directory. Fixture paths are retained in the report. The observer preserves the real server's instructions and tool definitions. The grader does not execute agent-authored scripts, and its Git commands disable hooks and filesystem-monitor commands. Fixtures live outside the Mason checkout so its parent project instructions are not inherited. They are disposable directories, not a security sandbox for hostile agents; Claude uses its existing headless permission bypass. Codex uses a session-only workspace permission profile with `.git` writes allowed inside the fixture, so the task can create an actual branch and worktree. A native sandbox Git-write probe runs before model calls; unsupported or denied profiles fail the run without weakening the sandbox.

Hooks are disabled for this instruction/MCP comparison. Native automatic memory and conversation persistence are disabled; authentication and host binaries are retained. Codex receives session-only approval for `get_context`, `get_impact`, and `save_decision` on the exact generated fixture server; the observer confines calls to that repository. Other tools retain normal approval behavior, and their failures are reported. This is distinct from knowledge acceptance, which requires the separate review. No global host settings or trust records are changed. See the [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) for ephemeral sessions and the [MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) for per-tool approval settings. Local CLI support is verified by actual runs; unsupported hosts fail without being counted as successful captures.

Use the [automation evaluation](../automation/README.md) to measure hook lifecycle activation. A listed MCP server is not evidence that its tools were callable or used. Reports distinguish listing, observed tool calls, session failures and grading outcomes. A missed capture is a failure even though reuse cannot run. Compare independently reviewed useful captures, unnecessary records, retrieval before action, correct worktree behavior, latency and token cost across repeated scenarios before claiming an improvement. Single runs are smoke tests.

Exit codes: 0 all selected rows passed through reuse and control; 1 a completed evaluation has failures; 2 independent reviews are still required. `report.json` retains individual failures even when another row awaits review.
