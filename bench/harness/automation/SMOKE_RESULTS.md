# Automation smoke results — 2026-09-05

Local validation passed 414 tests across 25 files, type checking, and the MCP tool/manifest smoke check (21 tools). Deterministic lifecycle replay passed the rename and unrelated-edit scenarios for both adapters, including verification after the final documentation commit.

Live Codex run `2026-09-05T21-06-44.300Z-dca40f20` recorded `codex-cli 0.153.4`. Live Claude run `2026-09-05T21-23-42.954Z-0b2bce67` recorded `2.1.261 (Claude Code)`. Both used Mason bundle SHA-256 `e0b276429f037f39b0164f75f7ec5507216dce912291997084334a00d48a8721`.

| Host | Arm | Ordinary request | Session | Original capture | Observed lifecycle | Final committed verification | Repair continuations |
|---|---|---|---|---|---|---|---|
| Codex | Hooks + instructions | Rename the module | Complete | Before edits | Session, prompt, before/after tool, stop | Verified | 0 |
| Codex | Hooks + instructions | Change greeting text | Complete | Before edits | Session, prompt, before/after tool, stop | Verified | 0 |
| Claude Code | Hooks + instructions | Rename the module | Complete | Before edits | Session, prompt, before/after tool, stop | Verified | 0 |
| Claude Code | Hooks + instructions | Change greeting text | Complete | Before edits | Session, prompt, before/after tool, stop | Verified | 0 |

Full reports, fixtures, preflight observations, usage, and transcripts are retained locally under `bench/harness/results/automation/<run-id>/`; those generated artifacts are ignored by Git. The live driver records the host version and built bundle hash for subsequent comparisons. Earlier unsuccessful runs are retained too: their missing hook activation was correctly graded as failure, even when instruction-driven edits succeeded.

Claude Code's initial live attempt failed before model execution because its OAuth session had expired. After the maintainer restored the login, `npm run bench:automation -- --live --hosts claude --arms hooks` passed both scenarios without code changes. The rename session cost $0.267576 and took 48.740 seconds; the control cost $0.1947925 and took 28.209 seconds. During the rename, Claude reported incomplete verification while the documentation edits were uncommitted; the grader's final commit and retained-evidence check then passed.

Final commit review subsequently found and corrected an installer preservation bug: first installation could remove existing prompt or agent handlers without a command field. The installation regression reproduced the loss before the fix and passed afterward, including repeated installation and changing Mason's command. This correction changes the bundle after the live runs recorded above; the hook adapters and repair runtime are unchanged.

The corrected build was subsequently packed and installed into an isolated runtime for a trial in the maintainer's existing Kotlin Multiplatform/iOS repository. Its Mason bundle SHA-256 was `1663838b48bd6e38ec8e7c0759588f0f86691f3c4396318d93193ef667bfc727`. Codex CLI 0.153.4 loaded the five project hooks after explicit trust and exposed all 21 MCP tools. Project configuration selected the packaged MCP server and the existing `CLAUDE.md` instructions. This trial used an explicit installed executable path; the default `npx --no-install` handler was not exercised.

The initial request renamed a Swift source file and updated references without mentioning Mason. The first turn recorded session start, prompt, 16 paired before/after tool events, and Stop, with no pending tool receipts or recorded coverage gaps. Mason's initial document fingerprint matched the committed original. After the source rename, Mason captured the newly stale documentation reference in a second baseline before the documentation edit. It subsequently marked that finding resolved while keeping overall verification incomplete until the documentation was committed. The file contents remained identical, and the widget simulator build passed for arm64 and x86_64.

A second user prompt explicitly requested committing only the rename and reference updates, then checking retained evidence. That follow-up was not an unprompted agent action. The commit contained exactly the rename and three reference updates; unrelated files remained uncommitted. All six audit checks reran against the new commit, with no skipped checks or outstanding findings. Both original baseline files were retained byte-for-byte. Independent uncached repair verification also passed. Across the two turns, 23 before/after tool pairs and two Stop events were recorded, with no forced continuation.

The roughly 11,000-path checkout's initial standalone check took 562 ms and a cached follow-up took 457 ms. Those two observations do not establish hook latency under load or large-repository performance. Detailed inspection records and the trial commit/configuration/evidence archive are retained locally under `.mason/reports/jacket-test-runtime/`, ignored by Git. After verification, the temporary installation and branch were removed from the trial repository, its original branch and files were restored, and unrelated work was preserved.

The maintainer deferred the live forced-continuation scenario. No live run has yet demonstrated a Stop request causing an assistant to resume and repair an outstanding finding. The proposed controlled fault-injection procedure is recorded in the [evaluation guide](README.md); it remains unimplemented.

These are single-case integration smoke results. No live baseline-versus-instructions-versus-hooks improvement has been established. One unrelated edit per host without a continuation is insufficient to estimate a false-positive rate. Session duration includes agent execution and machine load; it does not isolate hook overhead. Larger repositories, repeated sessions, additional host versions, and advisory review workflows still need evaluation.

## Release packaging check — 2026-09-06

The 0.12.0 npm tarball was installed with its dependencies in a fresh temporary project. Both adapters installed their default `npx --no-install --package mason-context mason-auto` handlers. With npm offline, replaying all five lifecycle events through those exact commands passed and retained verification against the fixture's clean commit. The packaged MCP server reported version 0.12.0, exposed the same 21 tools as the bundle manifest, and returned the observed automation status. This closes the default-command packaging gap from the existing-project trial; it is deterministic command replay, not an additional live host test. The detailed check and result are retained locally under `.mason/reports/release-0.12.0/`.
