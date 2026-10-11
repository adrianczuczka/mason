# Independent incident candidate manifest — 2026-10-11

Status: C1 completed a separately frozen one-family lifecycle pilot; the full three-family comparison is not frozen. The coordinating agent read the primary sources below after scoping the task-start probe. None was used in Mason's startup/upload/worktree development fixtures or competing-lesson grid. Public incidents may exist in model training data; held-out from our development fixtures does not mean unknown to the model. Independent maintainer lesson reviews and participants remain pending.

These candidates support the [Stage B protocol](TASK_START_EXPERIMENT.md#stage-b-outcome-evidence). Capture pinned source revisions, accepted review receipts, matched strong-document instructions, all four lifecycle tasks and checker witnesses before promoting any candidate into a frozen manifest. Proposed tasks below are constructed transfers of a reported bug, not claims that an upstream team has adopted Mason or the proposed lesson.

## C1: cancellation-listener cleanup after successful completion

Primary evidence: [Node issue #35990](https://github.com/nodejs/node/issues/35990). The report describes abort listeners accumulating on a long-lived signal when operations complete successfully. It explicitly notes that once-only listeners still remain when abort never fires; discussion calls for a fix to the timer path. This establishes a reported failure and correction direction, not the affected range of current Node releases.

- Proposed lesson: an operation that registers a cancellation listener must account for cleanup after normal completion as well as abort.
- Transfer task: extend a small signal-aware queue with another completed-operation path while preserving cancellation behavior.
- Proposed checker: deterministically count listeners across repeated successful operations; separately exercise abort and error cleanup. A deliberate once-only/no-success-cleanup violation must fail; explicit cleanup and a validated managed wrapper must pass.
- Maintenance variants: a pending wrapper migration does not supersede accepted cleanup guidance; verified wrapper-owned cleanup can replace the caller-specific instruction; retirement requires the old custom path to be removed, not a claim that cleanup stopped mattering.
- Completed source/checker step: [C1 validation](CANCELLATION_CASE.md) pins correction `aa1eb1fd597f68c6cb67c2a4d631a8d66f2cb94e` and before/after source receipts. On Node v25.9.0 the deliberate once-only violation fails; explicit removal and managed disposal pass. This is a constructed transfer, not execution of the historical Node implementation.
- Completed pilot: [eight-session lifecycle results](CANCELLATION_LIFECYCLE_RESULTS.md) cover pending, accepted migration, retired and unrelated states against equally informed notes. Both arms passed all four tasks; Mason cost more and added a pending-draft review continuation. Exact synthetic fixture review receipts exist through actual APIs; the coordinating implementation reviewer was unblinded. This is not independent maintainer approval or spontaneous correction capture.
- Outstanding: supported deployment-runtime validation, independent lesson review, human-effort/user-benefit evidence and additional incident families. C1 is now exposed development/pilot evidence; do not tune against it and call a later repeat held-out.

## C2: authentication across redirect scheme changes

Primary evidence: [Requests issue #4716](https://github.com/psf/requests/issues/4716). The report reproduces credentials retained on a same-host HTTPS-to-HTTP redirect. [Current session implementation](https://github.com/psf/requests/blob/main/src/requests/sessions.py) contains `should_strip_auth` and auth rebuilding; the historical fixing change is now pinned below; the moving current implementation is not a frozen comparator. Do not infer a release range from a moving main-branch document.

- Proposed lesson: retaining authentication across redirects depends on the destination's host/scheme/port boundary; same host alone is insufficient.
- Transfer task: add redirect support to a small local HTTP client with a synthetic credential. Use an in-process transport stub; no real credentials or external endpoints are needed.
- Proposed checker: observe the final prepared request under downgrade, different host, same-origin and explicitly justified upgrade cases. A same-host-only predicate must fail. A reviewed boundary predicate or a verified delegation to a mature client must pass.
- Maintenance variants: a pending client migration does not authorize dropping the existing protection; an accepted delegation changes who enforces it; retiring obsolete wrapper guidance must preserve the credential boundary check. Do not construct retirement as permission to expose credentials.
- Recovery preparation: merged [PR #4718](https://github.com/psf/requests/pull/4718), correction `c45d7c49ea75133e52ab22a8e9e13173938e36ff`, first parent `dd754d13de250a6af8a68a6a83a8b4419fd429c6`; pinned historical `requests/sessions.py` and `tests/test_requests.py`. Eleven isolated URL-pair checks pass the fixed predicate and reject the parent auth-rebuild method, strip-all and strict-origin mutations. Full historical suite and current-runtime integration are untested. Local receipts/checker: `.mason/reports/reasoning-case-selection-2026-10-11/` from the repository root.
- The [roadmap preparation cases](../../../ROADMAP.md#selected-preparation-cases--2026-10-11) use C2 to develop historical recovery, alongside a real upcoming Mason inspection-state decision. Source comments already mention compatibility, and public QA benchmark exposure was discovered during search; C2 is now exposed development evidence, not a genuinely undocumented or model-unknown case.
- Outstanding: freeze the recovery/review/reuse protocol, promote the checker to a distributed fixture, validate full prepared-header behavior and alternatives, and review lesson usefulness. Independent reviewer/accepted receipt: **none**. The local receipt records the Python version used for predicate validation; no supported deployment-runtime matrix has run.

## C3: timeout versus external cancellation races

Primary evidence: [CPython issue #86296](https://github.com/python/cpython/issues/86296), which reports `asyncio.wait_for` hiding cancellation in a race and links a correction/testing PR [#98607](https://github.com/python/cpython/pull/98607). The issue is evidence of the historical failure; supported-runtime behavior and the exact correction require separate verification.

- Proposed lesson: distinguish externally requested cancellation from an operation's timeout/completion; do not convert caller cancellation into successful work merely because the inner task finished.
- Transfer task: extend a small cancellable background-worker timeout helper with a fast-completion path.
- Proposed checker: use explicit scheduling barriers to reproduce external cancellation adjacent to completion, and check normal success, timeout and cleanup separately. A deliberate cancellation-swallowing violation must fail; a cancellation-preserving alternative must pass.
- Maintenance variants: a pending runtime upgrade does not prove the workaround obsolete; a verified corrected runtime/helper may replace it; retirement needs tested behavior on the pinned deployment runtime.
- Outstanding: read and pin the actual correction, ensure the reproduction is deterministic, validate alternatives and runtime matrix, review lesson usefulness. Reject this family if it cannot be reduced faithfully without flaky scheduling. Reviewer/accepted receipt/runtime pin: **none**.

## Promotion and pilot criteria

For every family, the frozen manifest must include: exact source/commit and local digest; exposure history; original reported failure and supported correction; reviewed lesson and acceptance receipt; explicit task authority; reuse/pending, changed/accepted, retired and unrelated task inputs; deliberate-failure and valid-alternative checker results; equivalent Mason and document facts/instructions; runtime/tool identities; reviewer role and blinding limits. A source issue alone does not establish a useful project lesson.

Pilot preparation remains separate from public fixture construction. Seek three to five maintainers only after outreach is authorized. For each, record an ordinary correction, separately reviewed guidance, a later relevant task and maintenance event; agree beforehand what improvement would justify setup/review effort. Measure repeat errors, necessary maintenance, irrelevant guidance, review corrections and total human/agent effort. Keep the existing-workflow comparator informed and report order/exposure effects. No pilot benefit thresholds, participants or results have yet been agreed.
