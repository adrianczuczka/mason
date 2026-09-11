# Revision guidance development trials — 2026-09-11

The guidance change makes revision of a matching lesson explicit when its assumptions, scope or recommended action changes. Agents should pass the existing record ID, preserve supported rationale and sources, replace obsolete instructions, and leave approval to a separate review. Distinct lessons may still become separate records; unchanged restatements need no save. Project instructions, the quickstart, MCP descriptions, bundle metadata and reference documentation carry this distinction.

## Unchanged R8 lifecycle repeat

The [earlier trial](LIFECYCLE_RESULTS.md) retained a useful lesson and working release behavior, but the Mason session created a second proposal instead of revising the existing record. With the new guidance, both arms completed the full [R8 lifecycle](LIFECYCLE.md):

| Outcome | Mason | Explicit notes |
|---|---|---|
| Useful initial proposal, separately reviewed | Pass | Pass |
| Release startup after unused integration removal | Pass | Pass |
| Revise the existing lesson for required background work | Pass; same ID, revision 2 | Pass; revised notes with prior accepted text retained |
| Separate review and final metadata commit | Pass | Pass |
| Fresh-session reuse, preserving startup and adding cleanup | Pass; accepted revision retrieved before edits | Pass |
| Unrelated greeting edit without new knowledge | Pass | Pass |

The original failed run remains intact. The repeat used the same task prompts, fixture, native toolchain and grading criteria. Comparing execution fingerprints found only the built Mason server changed; the new project guidance is fingerprinted separately. No regrading, proposal rewriting, model retries or seeded captures were used in this repeat. This is a sequential development comparison, not a randomized or blinded causal study.

## Interrupted-upload maintenance probe

The [second case](UPLOAD.md) deliberately starts with a reviewed reference lesson. It measures maintaining existing knowledge, not spontaneous capture of the earlier upload incident. A constructed retention change makes the original publishing edit expire.

| Outcome | Mason | Explicit notes |
|---|---|---|
| Inspect the original edit before side effects | Pass | Pass |
| Create a replacement only after detecting expiry; retain artifact/version | Pass | Pass |
| Revise the existing lesson with the expiration branch | Pass; same ID, revision 2 | Pass |
| Preserve uncertainty about former contents, transport cause and chunk size | Passed separate semantic review | Passed separate semantic review |
| Fresh-session recovery after revision review | Pass; accepted revision retrieved before side effects | Pass |
| Routine first upload without creating or revising knowledge | Pass | Pass |

The final sessions used a different release/edit in fresh clones without the incident file. Both finished the modeled release with its expected version and SHA-256 and preserved reviewed knowledge. Deterministic controls additionally reject duplicate uploads, missing pre-action inspection, mismatched identities, forged completion receipts, changed release inputs and stale proposal reviews. The publishing server is a local protocol model; no production API, account, upload or release was involved.

## Evidence and limits

- Fourteen actual Codex sessions: eight for R8, six for upload. Codex CLI `0.153.4`, host-default model selection; model identity was unreported. Hooks and native private memory were disabled. All sessions completed; no model retries.
- The implementing Codex agent inspected actual proposals, prior content, supplied evidence, patches or publishing journals, and recorded separate semantic verdicts. These reviews were **not blind** and authorize only synthetic fixture knowledge.
- R8 runs real shrinking and startup in a reduced JVM model, not Android/Room/WorkManager or real job timing. The upload expiration branch is a constructed extension of an incident recorded in project knowledge; original release logs were unavailable. Neither is independent production validation.
- One R8 Mason session attempted an unrelated automation-status call that the isolated host policy denied. The failure and its cost remain in the transcript/report; it was not needed for the evaluated revision or release checks.
- The local run directories are `.mason/reports/lifecycle-live-codex-revision-guidance-1` and `.mason/reports/upload-live-codex-revision-guidance-1`. They retain exact prompts, snapshots, fingerprints, proposals, reviews, transcripts, tool journals, per-session latency and token usage. Dollar costs remain unknown.
- Build and typecheck passed, along with 52 existing setup/provenance tests and six upload-harness regressions. Native R8 preflight, alternative repairs and final release checks ran in the live lifecycle. The broader application suite was not repeated for this guidance change.

The result supports keeping the clearer revision guidance: it addresses the observed miss and works in a second domain. Both baselines passed, so these trials establish no advantage over ordinary notes, population false-positive rate, or long-term maintenance reliability. More independent incidents, repeated trials and cases where a genuinely distinct lesson should create another record remain necessary before stronger claims.
