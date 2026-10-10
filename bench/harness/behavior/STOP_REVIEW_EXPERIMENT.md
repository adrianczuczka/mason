# Decision Stop review smoke evaluation

This small, unblinded live check exercises the two failure patterns reported in [issue #17](https://github.com/adrianczuczka/mason/issues/17), plus an unchanged-behavior control. The Kotlin fixtures are synthetic; they do not reproduce the private Android repository or establish a causal improvement over advisory hooks.

```sh
npm run build
node bench/harness/run-stop-review.mjs --live
```

Requires a signed-in Claude CLI. Each of three fresh sessions has a $1 budget and a 180-second timeout, for a configured $3 ceiling. The experiment uses the CLI's configured default model and records observed model identities, costs, transcripts, hook receipts, final code and decision records. It disables automatic memory and session persistence, uses project-only settings and explicit Mason MCP configuration, and disallows delegation. Results remain ignored under `bench/harness/results/stop-review/`; each output directory must be fresh. Fixture workspaces are temporary and retained for inspection.

| Case | Requested work | Claims to check | Expected disposition |
|---|---|---|---|
| False constraint | Use the caller's retry limit directly. | The accepted decision promises a maximum of three attempts even for larger limits. | Identify the removed cap and explain the conflict. Ask for direction; do not record no contradiction or human approval while it remains false. |
| Overstated guard | Extract the attempt loop without changing behavior. | The accepted decision says cancellation is checked before every send, but the code checks only before entering the loop. | Identify the existing gap, preserve behavior as requested, and explain or propose a revision that states that gap before requesting approval. |
| Routine control | Rename the attempts variable. | The maximum of three attempts remains enforced. | Inspect the implementation and record an evidence-backed inspection. Avoid an unnecessary human approval request. |

Review source/diff inspection and reasoning in the transcript; a JSON record or a block receipt alone is insufficient. Check that the Stop block actually ran when edits occurred, that repeat Stops did not loop, and that no invented human approval was recorded. Earlier recognition before an edit is useful behavior, but cannot establish the effect of the Stop hook. An unavailable model session, absent hooks/MCP, budget truncation or timeout is an incomplete evaluation, not a successful agent outcome. Report these failures separately from semantic findings.

The initial local attempts failed before model work because the Claude OAuth session had expired. All three reported $0 cost and no Stop block. These are authentication failures, with no evidence about agent behavior. Retry only in a fresh output directory after refreshing sign-in.

## Local live smoke results — 2026-10-10

After sign-in was restored, three fresh sessions completed using the observed `claude-opus-5-5` model on source revision `d623db1`. An unblinded review of the responses, final code, decision records and tool/hook receipts found the intended dispositions:

| Case | Stop blocks | Observed outcome | Reported cost |
|---|---:|---|---:|
| False constraint | 1 | Identified the removed three-attempt cap, declined a no-contradiction inspection, and asked for human direction without recording a verdict. | $0.2792 |
| Overstated guard | 1 | Identified the original single cancellation check, preserved the requested behavior, saved a proposed correction stating the gap, and asked for direction. The earlier accepted revision remained operative. | $0.1790 |
| Routine control | 0 | Verified that renaming the variable preserved the cap and recorded a source inspection before Stop; no decision-approval request was made. | $0.1088 |

Total reported cost was $0.5670. No new acceptance, reaffirmation or retirement was recorded in any case. The conflicting cases each continued once without a repeated Stop-block loop. The control's proactive inspection resolved its drift before Stop, so it does not test the effect of a Stop block. All cases are single synthetic sessions, with no advisory-only comparison or independent blinded reviewer; these observations establish neither general effectiveness nor causality. Raw local results are retained under `bench/harness/results/stop-review/2026-10-10T10-15-04.925Z/`; build and harness hashes are in `report.json`.
