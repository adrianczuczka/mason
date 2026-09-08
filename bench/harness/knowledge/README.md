# Knowledge capture and reuse evaluation

An ordinary investigation should retain useful project rationale as a sourced proposal. After independent review, a fresh session should retrieve it and avoid repeating the mistake. An unrelated greeting edit must not produce a knowledge record.

The [development smoke results](SMOKE_RESULTS.md) record the completed two-host workflow, earlier failures, and the limits of the comparison.

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
