# Changelog

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

Imported commands are never executed. Check provenance applies to its recorded commit and clean checkout, not local edits or complete test coverage. File associations identify relevant knowledge without claiming that a decision was violated. See [CI evidence usage](README.md#combine-ci-evidence-with-project-knowledge) for manifests and supported formats.
