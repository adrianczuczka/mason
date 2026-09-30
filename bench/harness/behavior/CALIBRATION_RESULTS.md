# Opus 5.5 calibration — 2026-09-28

Nine live sessions completed using `claude-opus-5-5`, medium effort, Claude Code 2.1.284, and a configured $0.50 limit per session. Reported total cost was **$0.7031014**. All nine used the requested model and passed integration checks. The remaining 81 cells were not run.

The first three scheduled matched blocks covered a command rename with unrelated backlog, an uncertain incident investigation, and an unrelated-edit control with backlog. Each block ran baseline, Mason instructions/tools, and Mason instructions/tools/hooks once.

## Findings

- All six editing sessions passed after correcting a grader bug. All conditions preserved unrelated backlog and completed the requested behavior.
- The original grader falsely rejected `npm start` in two README edits because it expected `npm run start`. These commands are equivalent. The grader now accepts npm lifecycle aliases and has regression coverage for aliases and stale command names.
- The three incident sessions remain pending independent semantic review. Initial inspection found uncertainty preserved in each response. Both Mason conditions saved one proposed record; baseline gave a response without saving a note. Record creation alone does not establish better behavior.
- Hooks recorded all five expected lifecycle events without errors. No new-or-worsened finding notices were delivered, so this sample does not test whether agents act on a notice.
- This calibration establishes that the harness runs on Opus 5.5. It provides no evidence yet of improved editing outcomes from Mason.

## Evidence and protocol correction

Raw reports, transcripts, hook/MCP receipts and review packets are retained locally under `bench/harness/results/behavior/pilot-20260928-opus55-calibration/`. Original `report.json` and `report.md` preserve the original grades. `corrected-grades.json` records the corrected grader hash and both grades for every completed cell. Regrading used retained fixtures without further model calls.

An earlier attempt under Claude Code 2.1.278 failed seven sessions before model usage because Opus 5.5 requires 2.1.280 or newer. Reported cost was zero. Those failures remain separately recorded under `pilot-20260928/`; they are excluded from this calibration.

The grader change invalidates the saved protocol hash for continuation. Use a new frozen plan for a subsequent study and keep this calibration separate. Do not silently rewrite the original report or resume it under changed code.

Validation: all 20 behavior benchmark tests passed with a 30-second per-test timeout. An earlier run hit the default five-second timeout on fixture setup; it also exposed a regression test targeting the wrong command fixture, which was corrected before the passing run.
