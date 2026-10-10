# Standard decision delivery candidate — results, 2026-10-10

Implemented the existing decision injector inside standard Claude lifecycle handlers and ran the [four-condition protocol](STANDARD_DELIVERY_EXPERIMENT.md) against saved baseline binaries. The candidate delivered a full accepted lesson once after a supported read, before a later model request selected the startup edit. Ordinary Bash workflows remained uncovered by direct injection. Correctness matched the baseline; improved patch outcomes are not established.

## Implementation

Standard handlers now return file-scoped knowledge after Claude `Read` or emit it before `Edit`/`Write` execution, using the existing injector and session/agent deduplication. Delivery stays within the active checkout, retains accepted versus proposed guidance and freshness/source labels, and preserves audit notices and activation diagnostics. Standalone `mason-hook` retains its PostToolUse contract. Setup's existing handlers need no extra configuration; installed clients need the new build and an assistant restart.

Claude consumes hook context on the next model request, alongside tool results. Returning context in PreToolUse does not block or replan the pending tool call. Post-read delivery can guide a later edit, provided there is a subsequent model request before that edit; it cannot protect edits already selected in the same tool batch. See the [official timing contract](https://code.claude.com/docs/en/hooks#add-context-for-claude). Bash commands and Codex/unsupported payloads have no direct lesson injection. Use MCP for those paths.

## Live comparison

All sixteen sessions completed with matching business inputs, private validation code, host-default settings and observed `claude-opus-5-5` on Claude Code `2.1.284`. Notes and baseline MCP/hooks used the same facts; baseline Mason binaries matched the earlier corrected report. The candidate used a separately fingerprinted build. Rotating condition order and one synthetic repeat are exploratory, not independent production validation.

| Case | Notes | Baseline MCP | Baseline hooks | Candidate hooks |
|---|---|---|---|---|
| Relevant edit | Pass | Pass | Pass | Pass |
| Unrelated greeting | Pass | Pass | Pass | Pass |
| Repeated reads/debug checks | Pass | Pass | Pass | Pass |
| Conflict: resolve before applying | Fails this gate | Pass | Pass | Pass |

The relevant and repeated edits preserved minified startup and configured the modeled job in all conditions. Every Mason substantive session retrieved applicable accepted knowledge through MCP before editing or requesting direction. Notes read their accepted guidance. Relevant hook sessions retained evidence-backed source inspection without human acceptance; no Stop block occurred in candidate sessions.

Only the candidate repeated-read case used supported file tools: two Read calls, then later checks and a Bash edit. One full lesson appeared after the first Read, with approval, scope, sources and changed-evidence markers. The second Read did not repeat it. Transcript message IDs show a later model request selected the edit. MCP had already returned the lesson before those reads, so this proves supported delivery and deduplication, not that the hook changed the outcome. Baseline hooks returned only a post-edit inspection notice. The candidate's other three cases used Bash/MCP and received no direct body injection. No unrelated startup notice or approval interruption was observed.

In the conflict case, notes recognized the policy disagreement but applied a reversible uncommitted patch before seeking confirmation. All Mason conditions prepared validated changes without applying them and requested direction. This reproduces the earlier conservative gate result, not missing conflict recognition or general unsafe behavior. The direct implementation request introduces authority ambiguity. The technical conditional lesson describes safe scheduling; it is not itself permission to override the accepted product policy.

## Cost and limits

| Four sessions per condition | Session seconds | Reported dollars | Accumulated input/cache/output tokens |
|---|---:|---:|---:|
| Notes | 99.762 | $0.3738 | 199,359 |
| Baseline MCP | 141.995 | $0.4825 | 362,703 |
| Baseline hooks | 128.276 | $0.6170 | 531,206 |
| Candidate hooks | 144.177 | $0.6393 | 514,838 |

The completed comparison reported **$2.1126**. Candidate versus baseline hooks used about 3.1% fewer accumulated tokens, 12.4% more session time and $0.0222 more reported cost. The unrelated paired case exceeded the provisional 25% time/token diagnostic even though it delivered no lesson; session variability and extra checks make attribution uncertain. No stable latency or cost improvement follows from one repeat. Claude top-level input, cache-creation input, cache-read input and output categories are summed once; nested details are not added again. Reviewer time is unknown.

PreToolUse Edit/Write emission is covered by deterministic/integration tests, not a live supported-edit session in this matrix. Shell coverage, same-batch model timing, overlapping injections, stale/missing check receipts, check linkage and independent maintainer pilots remain open. MCP and hooks can return the same lesson; this comparison observed that duplication.

## Verification and retained development evidence

- All **943 tests in 65 files** passed with native JDK/R8 inputs, including managed setup, pre-edit emission, read-only audit preservation, deduplication, inactive setup, foreign checkout isolation, proposals, acceptance and retirement. Lint, typecheck and formatting passed.
- Corrected sixteen-cell deterministic validation passed, including runner assertions for one pre-edit full lesson on candidate supported paths and none on unrelated/baseline paths. Native preflight verified debug, the release constructor failure, removal, and two valid keep-rule alternatives.
- Relocating the baseline initially omitted its `mason-runtime.js` companion. The unchanged helper was copied and both builds' helper hashes were included before rerunning validation. The failed deterministic evidence is preserved.
- A replay assertion then found that unrelated work incorrectly simulated a startup-file read. The launch command continued after that failed assertion and began a development batch; it was stopped, preserving one completed session ($0.1024 reported) and one interrupted session with unknown cost. The replay now targets greeting.txt for unrelated work and asserts delivery counts inside the runner. A fresh deterministic validation and fresh live comparison followed; interrupted attempts are not pooled or silently retried.

Raw corrected evidence: `.mason/reports/standard-delivery-live-claude-2026-10-10-v2/` and `.mason/reports/standard-delivery-validation-2026-10-10-v3/`. The reports retain both build identities, seeds/review receipts, native results, all transcripts, hook/MCP byte witnesses, usage and `semantic-review.json`. Interrupted development evidence remains under `.mason/reports/standard-delivery-live-claude-2026-10-10/`. Baseline binaries and their identity receipt are under `.mason/reports/standard-decision-delivery-baseline-2026-10-10/`. Semantic review was unblinded and harness-aware, separate from the evaluated sessions. No original completed-comparison grades were rewritten.

## Next investigation

Supported file delivery is implemented and verified, but this does not complete the repeat-mistake milestone. Ordinary Bash workflows are the largest observed coverage gap. Evaluate task-start context or another reliable target signal before considering shell parsing or adding an interruption gate. Include unrelated-task noise, already-retrieved MCP context, changed evidence and actual subsequent model opportunities. Broaden independent cases before claiming prevention superiority.
