# Automatic-use evaluation

This harness exercises ordinary requests such as "Rename the old-module directory to greeting-module and update the project to use it. Keep the behavior unchanged." The task prompt does not mention Mason. An unrelated greeting-text edit is a control for unnecessary repair continuations.

```bash
npm run build
npm run bench:automation -- --validate
npm run bench:automation -- --live
# Smaller host integration smoke test:
npm run bench:automation -- --live --arms hooks --tasks rename
```

`--validate` deterministically replays each adapter's JSON events through the built CLI. It checks real source/document edits, original capture, and final committed verification without models. It does **not** measure whether an assistant spontaneously uses Mason or loads hooks correctly.

`--live` runs the actual installed `claude` and `codex` executables in disposable Git fixtures. The default matrix has both hosts, rename/control tasks, and three arms: ordinary project instructions; those instructions plus Mason workflow guidance; and that same guidance with Mason hooks installed. No MCP server is required: instructions and hook output can use the CLI fallback. Hooks are disabled in the baseline/instructions arms, and the grader protects integration configuration from modification. Codex runs with its normal configuration/session lifecycle so project hooks can load. Before invoking its hook-trust bypass, the harness asks Codex to list effective hooks and refuses additional or altered handlers outside the exact generated configuration. Project trust is passed as a session override, including paths containing dots. Your own projects' hook trust is not changed. Unsupported hook inspection fails the evaluation before model calls.

The grading process is outside the fixture. It checks executable behavior, documentation updates without erasing essential instructions, unchanged integration configuration, observed lifecycle events, and original document fingerprints. It then commits the patch and checks the retained evidence again. Session failures never count as successful agent results even if a partial patch passes grading. The control must not cause a repair continuation.

Results under `bench/harness/results/automation/` retain fixtures, initial protected inputs, live transcripts, session completion/usage, grading failures, JSON, and a Markdown report. Review the actual activation evidence as well as patch correctness. `--output` selects another artifact directory.

Limits: default 180 seconds per session, 25 turns and $1 per Claude session, no automatic retries. Codex reports token usage and is time-limited; this driver does not enforce a dollar budget for Codex. `--timeout-ms`, `--budget-usd` (Claude), `--hosts`, `--arms`, and `--tasks` narrow or bound a run. `--model` selects one explicit model for the selected host; run hosts separately to use different model names.

One run per cell is a smoke test. It cannot establish a quality improvement, an acceptable false-positive rate, or large-repository performance. Compare repeated, reviewed results before making those claims. The original patch evaluation continues to disable hooks deliberately; this harness measures the separate automatic-use workflow.

See [recorded smoke results](SMOKE_RESULTS.md) for the tested build, actual activation in both hosts, and evaluation limits.

The maintainer has deferred a separate live forced-continuation scenario. The proposed test uses a disposable worktree and a test-only wrapper that restores one stale documentation reference immediately before the first Stop event, then invokes Mason's real handler. Passing requires exactly one continuation request, actual assistant repair edits without another user prompt, a subsequent stop without a repair loop, unchanged original baselines, and verified evidence after the final commit. Record the injected fault and native event sequence outside the agent's control. Label this as a fault-injection integration test, separate from ordinary-task performance evidence. A `resume` task is not implemented yet.
