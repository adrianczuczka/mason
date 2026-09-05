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

These are single-case integration smoke results. No live baseline-versus-instructions-versus-hooks improvement has been established. One unrelated edit per host without a continuation is insufficient to estimate a false-positive rate. Session duration includes agent execution and machine load; it does not isolate hook overhead. Larger repositories, repeated sessions, additional host versions, and advisory review workflows still need evaluation.
