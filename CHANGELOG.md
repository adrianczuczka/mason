# Changelog

## 0.14.1 — 2026-09-07

- Configure PATH automatically during standalone installation for Bash, Zsh, POSIX sh, and Windows. Supported installations finish with a simple instruction to open a new terminal and run setup.
- Preserve existing shell settings, profile symlinks, Windows PATH entries and registry value types. Track owned additions across repeat installs and upgrades; uninstall removes unchanged additions and retains user edits.
- Support `MASON_PROFILE` for custom shell profiles and `MASON_NO_MODIFY_PATH=1` for opt-out. Unsupported or unwritable settings receive explicit manual instructions.
- Test fresh-terminal discovery, duplicate prevention, and PATH cleanup in native package checks. Bound retries for transient Windows test-directory locks and report smoke success only after teardown completes.

Run the [installer](docs/distribution.md) again to upgrade from 0.14.0 and configure PATH. Existing project integrations remain pinned until you rerun `mason setup --host codex` or `--host claude` in each project.

## 0.14.0 — 2026-09-07

Install Mason without installing Node or npm. Standalone downloads bundle the runtime for macOS, Linux, and Windows.

- Add self-contained release archives with a pinned Node runtime and locked production dependencies for macOS, Linux (glibc), and Windows on x64/arm64. Shell and PowerShell installers verify downloads and retain unrelated launchers.
- Add `mason setup`, `status`, `check`, `audit`, `review`, `drift`, and `mcp`, plus standalone `upgrade` and `uninstall`. Existing dedicated binaries and npm installation remain supported.
- Run standalone project MCP and hooks from copied, pinned runtimes without system Node/npm. Global upgrades leave project versions unchanged; explicit setup preserves repair evidence and resets changed activation. Fresh clones install their own runtime.
- Gate standalone publication on native installer/MCP/hook/upgrade/uninstall smoke tests for all six targets. Protocol validation is separate from native host trust and agent-performance evidence.

See the [installation guide](docs/distribution.md). Existing npm users can continue with `npx --package mason-context@0.14.0 mason setup --host codex` (or `--host claude`), or install the standalone CLI and run `mason setup` for each host to switch its project runtime. Decision records and retained repair baselines need no migration.

## 0.13.0 — 2026-09-06

Mason now has one project setup operation for Codex and Claude Code. It preserves the original audit, installs a private pinned runtime, and configures MCP, lifecycle hooks, and assistant instructions without adding an npm manifest to the application. Status distinguishes configured integration from observed use.

- Add unified `mason-auto setup --host codex|claude` and explicit MCP `mason_init(mode: "setup", host)` onboarding. Preserve audit evidence before documentation edits; install a pinned private runtime without changing application manifests; merge MCP, lifecycle hooks, instructions, and ignore rules with repeatable/resumable setup.
- Add human-readable interactive setup status with structured JSON support. Distinguish configured, pending, active, and attention states using actual MCP context calls and complete hook lifecycles for the current installation and worktree/branch. Preserve native host trust and explicit disabled settings; configuration alone does not establish activation.
- Scope automation cache keys to the inputs each audit check observes. Generated build churn no longer reruns unrelated checks; documented generated paths, workspace membership, manifest contents, and decision evidence remain dependencies. Read independent instruction-file metadata concurrently.
- Classify automation failures in CLI JSON and MCP responses, preserve bounded execution receipts and durations, and keep unfinished or failed executions distinct from verified evidence. Report when storage exhaustion also prevents saving a failure receipt; clean up locks whose owner metadata could not be written.
- Omit dependency advisories for conservatively recognized Android release-version-only changes. Unknown or mixed manifest edits remain advisory, and original retained advisories still require review.

Install or upgrade from the target repository with `npx --package mason-context@0.13.0 mason-auto setup --host codex` (or `--host claude`). Review native MCP/hook trust and start a new session, then use `npx --package mason-context@0.13.0 mason-auto status` after an ordinary task. Setup never grants host trust. Existing manual installations remain supported; decision records and retained repair baselines require no migration.

Validation covers both hosts' setup, original evidence retention, resumable installs, native Claude guidance imports, configuration preservation, and uncertain activation states. Packaged npm installation, real MCP connections, deterministic hook replay, and fresh-clone recovery passed. Replay establishes mechanism behavior; broader agent usefulness and large-repository performance remain separate evidence gaps.

## 0.12.0 — 2026-09-06

Mason can now run documentation checks automatically through Claude Code and Codex hooks. It preserves findings before edits can hide them, resumes retained evidence across sessions, and verifies repairs against the final commit. Hook installation is opt-in.

- Add a shared documentation automation runtime with Claude Code and Codex lifecycle adapters, `mason-auto` installation/status/check commands, and the `mason_automation` MCP tool. Retain original and newly discovered findings across sessions, isolate branch/worktree state, verify after the final commit, and distinguish configured hooks from observed runtime events.
- Cache audit checks by their evidence dependencies, retry skipped checks, serialize concurrent captures, and keep full reports accessible behind concise notifications. Request at most one task-relevant continuation per session; never infer advisory approval or expand repair authorization.
- Add ordinary-request automation evaluations for module renames and unrelated edits, with baseline, instructions, and hooks arms. Offline lifecycle replay is separate from live agent performance evidence.

Upgrade with `npm install -D mason-context@0.12.0` in each project that will use the default hook command. Run `npx mason-auto install --host claude` or `npx mason-auto install --host codex`, then start a new assistant session; Codex also requires review/trust through `/hooks`. Keep the host configuration and `.mason/automation.json` together in version control, and ignore `.mason/reports/`. Update any separately pinned MCP server command, restart it, and refresh the Mason instructions through `mason_init`. No decision-store migration is required.

Validation includes 414 automated tests, live rename/control smoke tests in both hosts, and a Codex trial in an existing Kotlin Multiplatform/iOS project. These trials observed capture and final-commit verification without requiring forced continuation. The controlled live forced-repair continuation test remains deferred; broader mistake-rate, false-positive, and large-repository performance claims remain unproven. See the [recorded smoke results](https://github.com/adrianczuczka/mason/blob/v0.12.0/bench/harness/automation/SMOKE_RESULTS.md).

## 0.11.0 — 2026-09-05

Mason now keeps the original audit evidence visible while an assistant repairs documentation. A dependency warning suppressed by local edits stays unresolved, and a later documentation commit does not silently clear its review requirement.

- Add `mason_repair` and `mason-audit --prepare-repair` / `--verify-repair` to retain original audit evidence through edits and the final documentation commit. Verification distinguishes resolved, unresolved, review-required, unverified, and new findings; it preserves unavailable history and missing-document diagnostics.
- Retain suppressed dependency advisories when setup or repairs dirty context files. An advisory disappearing after a documentation commit no longer loses its evidence in a prepared repair. Ordinary audit exit codes stay unchanged; explicit repair verification reports incomplete scope separately.
- Route authorized repairs through preparation and verification in assistant instructions and work orders. Setup alone does not authorize rewriting existing claims; advisories require a separate assessment.

Upgrade to `mason-context@0.11.0`, restart the assistant, and refresh its marker-delimited Mason instructions through `mason_init` to enable the repair workflow. No decision-store migration is required. Explicit repair verification exits 2 for incomplete checks or outstanding advisory review; ordinary audit exit codes are unchanged.

## 0.10.1 — 2026-09-05

Editing an accepted decision previously hid its accepted content from ordinary retrieval until the draft was reviewed. Mason now keeps the accepted constraint visible alongside the proposed replacement.

- Preserve the last accepted decision while a replacement revision is proposed. Retrieval, hooks, map indexes, reviews, and audits distinguish the accepted revision from its pending proposal, including separate anchors, ownership, and freshness. CI evidence remains associated with accepted anchors. Existing version 2 history supplies both revisions without a storage migration.
- Keep review evidence for both revisions, block superseding a draft that still has an operative accepted constraint, and update existing hook sessions when acceptance or retirement moves the anchors.

Upgrade every client using the decision store to `mason-context@0.10.1` and restart it. No data migration is required; older clients still have the old retrieval behavior. Accepting a draft replaces the operative revision, and retiring a decision withdraws both the accepted revision and its draft.

## 0.10.0 — 2026-09-05

Mason now provides useful project checks and decision capture without building an architecture map. This release strengthens the trust evidence around stored knowledge and brings existing test and analysis results into the same review.

### Added and improved

- **Trust and storage:** preserve unknown freshness, invalid-store diagnostics, and failed verification throughout retrieval and review. Use shared file-access policy and bounded reads, store metadata atomically, and distinguish committed drift from local edits. Refreshes stay current through the final metadata commit.
- **Faster onboarding:** `mason_init` returns documentation audit and committed-diff review findings with a short setup guide. Decision capture, context, and file impact work immediately; architecture mapping is optional.
- **Decision provenance:** new records start as proposals with optional owner, source, and recorder information. `review_decision` prepares source and history evidence before recording acceptance, reaffirmation, or retirement with a named reviewer and reason. Revisions and prior reviews remain in the record history.
- **Combined review evidence:** `mason-review --evidence <manifest>` and the `mason_init` evidence input import Vitest JSON and SARIF 2.1.0 artifacts. Findings associate changed files with accepted decisions. Check outcomes and commit freshness remain separate, including skipped, unavailable, stale, and unknown states. `--require-evidence` opts into a CI gate.
- **Patch evaluations:** an offline-verifiable benchmark grades actual patches and missed companion updates, supports configurable agent adapters, and preserves artifacts for review. The initial ten-task live comparison tied at 10/10 for both arms; fewer coding mistakes and an acceptable false-positive rate are not established by this release.
- **CI:** run tests with recorded exit status and checkout provenance, review their artifacts, and check types before publishing. Empty-project tests create their own temporary directories so fresh checkouts reproduce local results.
- **Packaging fixes:** hook help and configuration commands return immediately even when stdin is an open pipe. Update compatible locked runtime dependencies to resolve the six advisories found during release preparation, including the [fast-uri](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [ip-address](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), and [Hono](https://github.com/advisories/GHSA-88fw-hqm2-52qc) advisories. The production dependency audit reports zero known vulnerabilities for the release lockfile.

### Upgrading from 0.9.0

1. Update the `mason-context` package in all clients that share a decision store, then restart those clients. For a pinned MCP command, use `npx -p mason-context@0.10.0 mason-mcp`. Existing version 1 decision files remain readable and are not automatically rewritten. Their first edit or review upgrades them to version 2; older clients must be updated before using those records.
2. Re-run `mason_init` and refresh the Mason block in the project's existing assistant instructions. It now defaults to a quickstart audit/review. Automation that needs the previous full architecture build must pass `mode: "map"`. Existing maps remain usable, and initialization markers are no longer a prerequisite for decision capture, context, or impact.
3. Treat new decisions as **proposed** and legacy records as **unreviewed**. Acceptance needs an owner, source, named reviewer, reason, and committed anchor evidence. Use `review_decision` to prepare and record authorized verdicts. These are recorded assertions for review, not authenticated approvals.
4. Replace workflows that re-verify a decision by saving identical content. An unchanged `save_decision` is now a no-op; use `review_decision` with `action: "reaffirm"` for accepted records. Content or attribution changes create a new proposed revision. A proposal cannot supersede an accepted record; review the replacement and retire the original separately.
5. Audit, drift, and review JSON contracts remain additive. Review evidence is optional and advisory for default exit codes. With `--require-evidence`, current failures exit 1; incomplete, missing, skipped, stale, or unknown evidence exits 2. A current failure takes precedence over incomplete evidence. The existing missing-partner check still drives exit 1.

Imported commands are never executed. Check provenance applies to its recorded commit and clean checkout, not local edits or complete test coverage. File associations identify relevant knowledge without claiming that a decision was violated. See [CI evidence usage](docs/checks.md#combine-ci-evidence-with-project-knowledge) for manifests and supported formats.
