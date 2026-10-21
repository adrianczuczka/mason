# Changelog

## Unreleased

- Stop publishing to Smithery on release: Smithery now rejects server updates (`403 Updating servers has been removed`). Releases continue to npm, the official MCP Registry and GitHub release downloads; the existing Smithery listing is no longer updated.

## 0.23.0 — 2026-10-21

- `save_decision` guidance asks for the constrained functions, types, or settings to be named in backticks, so drift notices can judge relevance. Anchors remain whole files or directories, and anchored changes still require inspection; symbol anchors and automatic clearing of trivial drift were considered and not adopted.
- Attribute decision drift on a branch to the branch or to the default branch it builds on. Previously a rebase made every decision the default branch had changed look like this checkout's unchecked work. Drift in anchors this branch touched is reported as before; drift that arrived only from the default branch is listed once per session, never blocks Stop, and is reported as usual on the default branch. `review_decision(prepare)` reports the same split in `previews.attribution`. Explicit audits still report all drift.
- `review_decision(action: "prepare")` previews source, diff and anchor commits since the latest inspection still valid for the record and scope, instead of since the original evidence baseline, and reports the commit used in `previews.diffSince`. Earlier changes were already inspected, so long-lived records no longer return months of truncated history. Pass `diffFrom: "capture"` for the full history. Responses include the latest two inspections and count older ones; the record file keeps them all. Review evidence, tokens and verdict requirements are unchanged.
- Stop failed, denied and interrupted tool calls from filling the automation store. Previously every new session failed once 128 sessions held unfinished calls, or once `state.json` passed 10 MiB, until the file was edited by hand. Claude configurations now register `PostToolUseFailure`; run `mason init --host claude` to add it, as older configurations stay compatible without it. Pending captures are dropped when the turn ends or after 24 idle hours. Sessions are evicted least recently used even with unfinished calls. `state.json` is written compactly and shrunk instead of failing when oversized, including files left by earlier versions. `mason status --json` reports unfinished tool calls, and an attempt still in flight no longer makes status `unavailable`.
- Show the changed lines in decision drift notices, including the Claude Stop review, so most irrelevant edits can be dismissed without another tool call. Hunks are diffed against the exact captured content of the last inspection or save. Each notice reports code identifiers named by the decision (backticked names, calls, camelCase or snake_case) that the changed lines or their enclosing declarations mention, or `Low relevance` when none are; decisions naming no identifiers are not assessed. Relevance is a name match only: findings, inspection requirements and Stop blocking are unchanged.
- Merge decision records automatically when branches each append inspections or review history, instead of conflicting inside the JSON on every rebase of a stacked branch. `mason init` adds a `.gitattributes` entry for `.mason/decisions/*.json`; `mason setup` configures the local `mason-decision` Git merge driver, and `mason status` reports a committed attribute without it. Two different changes to the same field still conflict, and Git's ordinary text conflict is used whenever Mason refuses a merge or is not on PATH. Run `mason init --host <host>` to add the attribute, commit `.gitattributes`, then run `mason setup` in each checkout.
- Leave Git-ignored files beneath a directory anchor out of its capture instead of marking the capture incomplete, so local setup files no longer block `review_decision` inspection or make the anchor's freshness unknown. Anchors naming only ignored content still stay unknown. An incomplete capture now leaves only its own decision's earlier drift findings unverified instead of every decision's.

## 0.22.0 — 2026-10-12

- Separate CLI scopes: `mason init` prepares shared repository integration without activating it; `mason setup` activates compatible existing configuration using local state only. `mason teardown` now disconnects locally; use `--project` explicitly for shared removal. Initialization and teardown support read-only `--dry-run` previews. Compatible older instructions, supported legacy hooks and JSON formatting do not force shared rewrites; status reports optional template updates separately. MCP exposes matching `init`/`setup` modes. Setup no longer triggers background update checks. Migrate scripts that used setup to generate configuration to `mason init` followed by `mason setup`; scripts removing shared configuration must add `teardown --project`.

- Simplify project integration to MCP, reasoning instructions and decision hooks, prepared by `mason init` and activated locally by `mason setup`. Remove automatic documentation audits, committed-diff review, repair capture and statistics enrollment. Setup results expose a configuration receipt instead of audit findings/report paths; legacy receipt pointers and existing audit artifacts remain intact. Statistics are opt-in through `mason stats --enable`; existing preferences are unchanged. Run `mason init --host <host>` after upgrading to refresh the shorter shared project guidance, review and commit those changes, then run `mason setup --host <host>` locally.

- Separate lifecycle decision checks from documentation-repair automation. Hooks check current decision anchors without discovering document claims, creating repair baselines, or verifying old audit findings. Preserve paired edit observation, source-inspection and human-review boundaries, Stop deduplication, guidance delivery and explicit audit checks. Reuse the event/receipt store with a separate guidance report pointer; status and setup output label verification scope. Old baselines and assessments stay available to explicit checks.

- Consolidate documentation repair and advisory assessment on the existing CLI: remove the duplicate `mason_repair` and `review_advisory` MCP tools. Use `mason audit --prepare-repair`, `mason audit --verify-repair <baselinePath>`, and `mason audit review`. Update project instructions, work orders and hook notices to point to these commands. Run `mason init --host <host>` after upgrading to refresh shared instructions. Existing baselines, review records, hooks and decision review semantics remain supported.

- Remove managed architecture-map creation (`generate_snapshot_batch`, `save_partial_snapshot`, `reduce_snapshot`, and `mason_init` map mode) and general orientation (`full_analysis`, `analyze_project`, `get_code_samples`). Remove batch prompts, partial-store management, the orientation analyzer and sampler. Keep existing map reading, direct saving, drift and verification; direct saves merge supported updates and no longer consume or clear old partials. Missing maps return a short decision-context pointer. Refresh instructions use the agent's source tools and direct saving. Keep 0.21.0 for the old managed build workflow and run `mason init --host <host>` after upgrading to refresh shared project instructions.

- Remove Confluence publishing (`mason_set_confluence`, `export_to_confluence`) and its standalone LLM provider/configuration layer to focus maintenance on engineering reasoning. Remove the Anthropic/OpenAI SDK dependencies. Existing wiki pages, legacy feature settings, and user credentials are left untouched; Mason no longer reads or updates them. `mason_complete_init` no longer accepts `confluenceConfigured` or advertises Confluence status. Users needing wiki publishing should keep 0.21.0 until they migrate that workflow to a separate publisher.

- Deliver file-scoped decision knowledge through standard Claude hooks after `Read` and before `Edit`/`Write`, reusing the existing injector and session deduplication. Confine delivery to the active checkout, retain approval/freshness labels and audit diagnostics, and preserve the standalone PostToolUse contract. Shell commands and Codex remain outside direct lesson injection.
- Flatten hook commands to `mason install`, `mason config`, and `mason hook --host claude|codex`. Generate shorter hook handlers and migrate existing configurations without duplicates. Retain `mason auto …` aliases and the standalone decision injector for compatibility.

## 0.21.0 — 2026-10-10

- Continue Claude once at Stop when outstanding decision drift overlaps observed session anchor edits. Require source inspection, preserve human approval boundaries, and keep repeat Stops and Codex advisory. Add local `mason auto config --stop-block off|drift` controls and status reporting. Include uncommitted anchor changes in drift findings for accepted and legacy decisions using Git baselines.

- Capture readable decision anchors when saving proposals, so committing a proposal with its implementing code does not create false drift. Later source edits still require inspection; unreadable scopes retain unknown freshness.
- Add separate source inspections that resolve covered drift without claiming human acceptance or changing the accepted revision. Bind preparation tokens to source bytes, preserve original audit evidence, and reopen inspections after relevant changes.
- Batch anchor inventories, index path scopes, and reuse decision reads within each inspection while retaining fresh final validation. Add reproducible validation against pinned Now in Android and WordPress Android repositories, with measured hook costs documented in `docs/hook-performance.md`.

## 0.20.2 — 2026-09-30

- Show decision titles and the inspection command before changed file paths in completion warnings, so long paths cannot hide the reason for review or the next step.
- Add regression coverage for long Android paths and historical advisory closure after accepting a replacement decision, including automation checks.

## 0.20.1 — 2026-09-30

- Retry temporary Windows lock access failures during concurrent snapshot writes, preserving the acquisition timeout and persistent permission errors.
- Includes the stats and CLI changes below; 0.20.0 was tagged but not published after its Windows release check failed.

## 0.20.0 — not published

- Keep optional stats failures from blocking setup, allow disabling with damaged stats storage, and preserve newer audit outcomes when delivery observations arrive late.
- Remove the `mason-auto` executable. Use `mason setup`, `mason status`, `mason check`, and `mason stats`; hook configuration and execution use `mason auto`.
- Enable local stats during setup, preserving explicit opt-outs, with summaries for hook finding delivery, observed resolution, returned decision IDs, automation timing, and supplied feedback ratings. Keep uncertain outcomes explicit; no prompts or source contents are stored or uploaded.

- Add a controlled agent-behavior benchmark with matched conditions, independent grading, and retained hook evidence. Pilot results establish delivery, not improved outcomes.

## 0.19.2 — 2026-09-29

- Use operating-system trusted certificates in standalone Mason, preserving bundled and extra certificates, so company TLS certificates work for upgrades and other requests. Report GitHub release lookup failures with their underlying error code and certificate or network guidance.

- Capture supported lessons immediately as proposals, keeping unimplemented remedies tentative and acceptance subject to explicit review.
- Give assistants new or worsened audit findings during the task and show remaining findings at response completion. Keep the existing backlog quiet; explicit checks still report it in full.
- Preserve notification history across restarts, ignore report-only changes, and retain overflow for later notices. Notices never force another agent turn.
- Recover notification tracking from unreadable upgrade reports while preserving repair evidence. Deduplicate verification warnings per session.
- Show uncommitted decision records and pending proposals in explicit status, with paths, ages, and oldest proposals first.

## 0.19.1 — 2026-09-25

- Match supported dependency changes to named document passages; retain unmatched manifest recency as information without a review obligation. Preserve specific findings, original baselines and prior assessments, and label historical evidence explicitly.
- Add `audit.include` document patterns and per-check `audit.exclude` patterns in project configuration, shared by audit discovery and automation caches.
- Add one-step dependency-advisory dismissals with structured reasons. No-dependency-claims dismissals survive manifest changes and reopen when document content changes; unrelated-change dismissals also track scoped manifests. Existing prepared assessments and decision approval remain separate.
- Skip standalone upgrade downloads when the requested or latest version is already installed, while retaining explicit version pinning and unpinned upgrade behavior.

## 0.19.0 — 2026-09-17

- Add automatic updates for new public standalone installations, with existing installations opting in through `mason updates enable`. Check at most daily for stable releases at least 24 hours old; leave npm, pinned versions, company mirrors, and CI under explicit control.
- Verify automatic downloads against Sigstore-signed release metadata from the exact tagged publishing workflow, stage and health-check each bundle, and activate at a future MCP launch only after other Mason MCP servers exit. Keep update work and diagnostics out of hook and MCP protocol streams.
- Add `mason updates` status, enable/disable and pin/unpin controls, `MASON_NO_AUTO_UPDATE=1`, persisted company mirror selection, and an offline `mason rollback` that restores and pins the previous installation. Retain `mason upgrade` for explicit immediate updates.
- Track standalone processes before startup and reclaim unused update bundles while preserving current, rollback, staged, and running versions. Retain legacy or uncertain bundles conservatively.
- Let linked Git worktrees inherit host activation from the primary checkout, with local setup and teardown taking precedence; keep audit evidence and observations local to each worktree.
- Limit dependency-change advisories to documents containing dependency guidance, preserve committed evidence through local edits, and distinguish current findings from historical advisories awaiting review.

## 0.18.0 — 2026-09-16

- Fix overlapping snapshot writes restoring old descriptions and deleted flows. Snapshot saves, verdicts, and partial writes share a per-checkout cross-process lock; reads, replacement, and consolidation cleanup stay within the protected operation.
- Bind map verification to entry kind, content, and bounded source evidence through review tokens. Changed or deleted entries return conflicts; older calls without tokens request a fresh review without recording a verdict. Existing snapshot files remain compatible; callers must include the returned entry kind and review token to record a verdict. Restart all Mason MCP processes for a checkout after upgrading; older binaries do not honor the new snapshot lock.
- Recheck saved map verification evidence on retrieval. Changed evidence reports stale verification; unavailable evidence and legacy verdicts without tokens report unknown. Preserve historical verdicts and failure reasons, including when reviewed local edits are reverted to a clean checkout.
- Diagnose incomplete lock owners and interrupted recovery guards, document safe manual cleanup after writers stop, and cover both interruption windows with controlled process-termination tests.
- Cover the reported overwrite with a controlled regression, exercise both call orders through one MCP session and separate processes, and test interrupted writers, contention, partial cleanup, and stale review evidence. Run the snapshot regressions in the existing macOS, Linux, and Windows distribution matrix before publishing.

Run `mason upgrade` for standalone installations, or `npm install -g mason-context@0.18.0` for npm installations. Restart **every Mason MCP process** sharing a checkout after upgrading: older processes do not participate in the new snapshot lock. Existing decisions and snapshot files are preserved. Older snapshot verdicts remain visible but report unknown verification until reviewed again with an evidence token. Existing integrations do not need setup again.

## 0.17.4 — 2026-09-15

- Share Git document/source inventories within each automation inspection, with a separate fresh inventory before publication. Batch module ignore checks by directory level and reuse only identical scoped history queries.
- Let automation's complete input validation replace overlapping repair discovery while retaining standalone repair guards, original evidence, skipped-check retries and per-tool receipts.
- Include automation's Git subprocess counts and timings in opt-in profiles. Extend hook benchmarks with many top-level modules, incomplete checks, selectable Node runtimes and optional delayed Git reads.
- Clarify that each developer runs setup once per checkout; upgrading an existing integration normally requires restarting the assistant.

Synthetic measurements reduced a warm pre/post pair from 0.83 s to 0.60 s with native Git, and from 2.93 s to 1.19 s with deliberately delayed inventories. These are local benchmarks, not workplace latency guarantees; see [method and limitations](docs/hook-performance.md#git-inventory-follow-up-2026-09-15).

Run `mason upgrade` for standalone installations, or `npm install -g mason-context@0.17.4` for npm installations, then restart running assistants. Existing integrations do not need setup again for this release. Decisions and retained repair evidence are preserved.

## 0.17.3 — 2026-09-15

- Reduce repeated hook work by sharing the current audit across repair baselines and reusing complete current audits on unchanged sequential calls. Keep original history, review assessments, skipped-check retries and per-tool evidence receipts independent.
- Rebuild missing or damaged derived audit caches without clearing original repair evidence; retain failures for unsafe paths or damaged baselines.
- Batch document status checks, bound concurrent document-history reads, and reuse changes from shared document commits.
- Add opt-in `--profile` timing output for checks/hooks and larger hook benchmarks covering retained repairs, ignored build output, decision records and final-commit verification. See [hook performance](docs/hook-performance.md) for scope and measurements.

Run `mason upgrade` for standalone installations, or `npm install -g mason-context@0.17.3` for npm installations, then restart running assistants. Existing project integrations do not need setup again for this release. Decisions and retained repair evidence are preserved.

## 0.17.2 — 2026-09-15

- Show progress during standalone installation, upgrades, and project setup, with native download progress and elapsed-time spinners in interactive terminals. Keep redirected progress on stderr and JSON, MCP, and hook output unchanged.
- Offer Codex and Claude Code setup instructions without assuming an assistant. Show the previous and installed version after an update and remind users to restart running assistants.

Run `mason upgrade` for standalone installations, or `npm install -g mason-context@0.17.2` for npm installations, then restart running assistants. Existing project integrations do not need setup again for this release. The first upgrade from an older version still uses its bundled downloader; the new download display appears on subsequent upgrades and fresh installations.

## 0.17.1 — 2026-09-15

- Keep MCP available in fresh clones, with actionable setup instructions and inactive automatic hooks until local setup. Preserve corrupt-setup diagnostics and checkout-specific activation.
- Resolve hook setup and evidence from the host payload's checkout before using a launch/project fallback. Keep ambiguous roots and outside-repository events with multiple worktrees explicitly unverified.
- Avoid aborting audits on references below regular files. Report `.git/` references as skipped metadata and share the same path observations with automation caches.
- Ignore unexpected `.mason/` contents by default while allowing shared knowledge. Emit Claude's explicit stdio transport, recognize compatible older hook commands in status, and retain clone teardown support.
- Exercise fresh-clone MCP, worktree setup, directory changes, original pre-edit evidence, and repeated setup in focused adoption regressions.

Run `mason upgrade` for standalone installations, or `npm install -g mason-context@0.17.1` for npm installations, then restart running assistants. Existing PATH-based integrations receive the audit, MCP and hook fixes on their next launch. Rerun `mason setup --host codex` or `--host claude` to refresh the shared Git ignore rules and Claude's explicit stdio entry; review and commit those configuration changes. Fresh clones and linked worktrees still need their own local setup to activate automatic hooks. Decisions and retained repair evidence are preserved.

## 0.17.0 — 2026-09-11

Mason can now retain an authorized advisory assessment through later sessions and commits, then reopen it when relevant evidence changes. Documentation audits cover nested instructions and README files with more precise reference and command scope.

- Record authorized advisory assessments through `review_advisory` and `mason audit review`. Preserve history, reuse decision reviews, retain closure through unrelated and metadata commits, and reopen when relevant evidence changes. Deferred or unavailable findings remain outstanding.
- Discover nested README and agent instruction files with their actual filename casing. Respect exclusions and preserve scope through local references, package commands, repair baselines, and automation caches.
- Keep never-tracked paths, ambiguous commands, and undocumented modules advisory. Recheckable candidates can resolve when their condition disappears; historical dependency and decision advisories still require review.
- Passive audits ignore directory aliases outside the source inventory while still refusing links used by selected source paths; fixes the audit abort reproduced on ripgrep's `HomebrewFormula` alias.
- Import individual native-validator outcomes through `mason-check-json`, including optional environment metadata. Preserve missing, skipped, failed, stale, and unknown evidence without running imported commands. Automatic compiler discovery and snippet execution remain future integrations.
- Update the pinned Markdown parser to `markdown-it` 14.3.1, covering its published denial-of-service fixes.
- Flush complete audit and repair JSON before exit when output is piped, including through the unified `mason audit` command.
- Clarify when agents should revise an existing lesson using its ID, including accepted records, instead of creating another proposal. Keep supported rationale and sources, distinguish genuinely separate lessons, and preserve review boundaries.
- Add knowledge-maintenance evaluations with a reduced R8 startup reproduction and a local publishing simulator. Fourteen live Codex sessions exercised reviewed revision, fresh-session reuse and controls; both Mason and ordinary notes passed. These development trials do not establish superiority over notes or production integration correctness. See the [results and limitations](bench/harness/knowledge/REVISION_GUIDANCE_RESULTS.md).

Run `mason upgrade` for standalone installations, or `npm install -g mason-context@0.17.0` for npm installations, then restart running assistants. Existing PATH-based integrations use the new binary on their next launch. In each project, rerun `mason setup --host codex` or `--host claude` to refresh the managed decision guidance and Git ignore rules for `.mason/reviews/`; review and commit those project changes. This preserves existing decisions and repair evidence and requires no decision-store migration. Setup does not approve findings or decision records.

## 0.16.3 — 2026-09-09

- Coordinate overlapping hooks without holding the shared state lock during audit analysis. Reuse analysis for identical inputs, let changed inputs proceed independently, and revalidate before publishing results so older work cannot overwrite newer evidence.
- Retain independent execution receipts during parallel calls. Report repeated, durably recorded failures once per session until recovery; keep failures without receipts visible and preserve pre-edit evidence for shell and unknown tools.
- Accept decision bodies up to 2,500 characters, with a warning above the recommended 1,500. Preserve the full body, report precise validation limits, and shorten generated IDs at word boundaries where possible.
- Cover slow checks, overlapping CLI processes, failure recovery, and changing inputs with concurrency regressions. Simplify README badges for consistent rendering.

Run `mason upgrade` for standalone installations, then restart running assistants. Existing PATH-based project integrations do not need setup again for this release.

## 0.16.2 — 2026-09-09

- Guard generated hooks when Mason is absent, and keep a checkout without local host setup quiet. Preserve active failure diagnostics and strict MCP startup; setup/status/teardown recognize the generated guard variants without project wrapper scripts.
- Observe known read-only tools without rescanning audit inputs or advancing verification. Keep before/after capture for shell and unknown tools. Add a reproducible full-CLI hook benchmark and publish its measured scope and limits.
- Document hook inputs, retained data, local versus optional networked features, MCP installation, and company mirrors. Require an explicit version with a custom release mirror to avoid public version discovery.
- Exercise core CLI/MCP and hook paths with denied network operations, raw-input retention markers, inactive/invalid setup, and changed evidence before potentially mutating tools. On macOS, apply OS network denial to the tested process tree too.

## 0.16.1 — 2026-09-08

- Resolve references using literal import paths and declared Kotlin/Java package symbols. Separate explicit path mentions and uncertain name candidates; suppress config/document-name collisions and keep weak candidates out of compact task context with an omission count.
- Include investigations in project-context guidance and route reusable project lessons into sourced proposals, preserving uncertainty and unknown attribution.
- Add a two-session knowledge evaluation with ordinary prompts, independent digest-bound review, fresh-checkout reuse, negative controls, and current-guidance/file-notes comparisons. Mechanism validation and live agent outcomes are reported separately.

## 0.16.0 — 2026-09-08

- Add `mason teardown` to disconnect all project hosts, or one with `--host codex|claude`. Support `--dir`, `--dry-run` and `--json`; retain decisions, configuration, maps, repair evidence and ignore rules. Global uninstall remains separate.
- Record integration ownership before setup writes. Remove only identifiable Mason entries and unchanged instruction blocks, preserve unrelated user content and remaining hosts, and retain ambiguous edits with an incomplete result. Repeated teardown and interrupted-operation recovery preserve original evidence.
- Exercise setup/teardown/reconnection, missing receipts, user edits, branch receipts and the packaged CLI lifecycle.

## 0.15.0 — 2026-09-08

- Simplify project setup to use the installed `mason` command on PATH. Remove generated project launchers, copied runtimes, and per-project version pins. Global upgrades apply on the next launch; restart running assistants.
- Keep setup and hook ownership records in ignored `.mason/local/`, with shared options in `.mason/config.json`. Decisions and optional maps remain shareable; original repair evidence stays local and durable.
- Check command availability before configuration, retain evidence across interrupted writes, and require fresh activation observations after a Mason upgrade. Earlier generated setup layouts have no automatic migration; use a fresh project setup.

## 0.14.2 — 2026-09-07

- Remove the repository-wide automation inventory that blocked setup above 100,000 files and directories. Discover module source through Git and Mason exclusions, and search workspace command manifests only when needed.
- Preserve checks of explicitly documented ignored paths and workspace members. Validate symlinks at the inputs actually read, bound scoped discovery, and identify the operation responsible for a limit failure.
- Cover setup with 100,001 ignored generated files, retained evidence, and detection of a later source module.
- Request a new terminal after installation only when the installation directory is absent from the inherited PATH.

## 0.14.1 — 2026-09-07

- Configure PATH automatically during standalone installation for Bash, Zsh, POSIX sh, and Windows. Supported installations finish with a simple instruction to open a new terminal and run setup.
- Preserve existing shell settings, profile symlinks, Windows PATH entries and registry value types. Track owned additions across repeat installs and upgrades; uninstall removes unchanged additions and retains user edits.
- Avoid a same-name PowerShell script shadowing the Windows command under restricted script policy. Migrate the old owned helper without changing user or machine execution policy.
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
