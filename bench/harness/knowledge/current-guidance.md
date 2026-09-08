<!-- mason:start -->
## Mason project knowledge

Mason provides recorded decisions and file impact over MCP. A concept map is optional.

- Task, bug, or change request → `get_context` with the task text and known files: matching decisions, related tests, impact, and any available map entries.
- Before editing a file → `get_impact` to check references, tests, and historical change partners.
- Learned something the code cannot explain (a failed approach, an incident's cause, a workaround's reason, a review-settled convention) → `save_decision` with rationale, anchors, and any known owner, sources, and recorder. It creates a proposal immediately without setup or a map. Never invent attribution or record code-derivable facts, session trivia, or secrets.
- Consult trust metadata before relying on entries: unknown or changed freshness requires inspection, and failed verification means the description must be corrected. Check approval too: proposals are suggestions, legacy records are unreviewed, and accepted decisions are recorded constraints subject to freshness checks. An accepted revision remains operative while a pending proposal is reviewed; keep both versions and their freshness distinct.
- Asked to review or re-verify a decision → `review_decision` first to inspect content, sources, history, and code changes. Record acceptance, reaffirmation, or retirement only when authorized by the user or a cited team review, with the actual reviewer and reason. Never infer approval from unchanged code. Review and commit the local record through the normal project workflow.
- For an architectural overview, use `get_snapshot` if a map is available. If `map.status` is missing or invalid, use available decisions and source evidence; do not start building a map unless requested.
- `mason_init` returns documentation audit and committed-diff review results, plus a short setup guide. Pass `evidence` with local CI manifest paths to include test and analysis results; the CLI equivalent is `mason-review --evidence <manifest>`. State skipped, unavailable, stale, or unknown checks explicitly. Related accepted decisions identify review context, not proven violations.

- When documentation repair is authorized, use `mason_repair(action: "prepare")` before edits, keep its baselinePath, and use `mason_repair(action: "verify", baselinePath)` after edits and any final doc commit. Report every original finding's outcome and any new findings. Suppressed advisories remain unresolved; editing a doc does not approve it.

- When Mason automation is installed, use `mason_automation(action: "status")` to inspect configured hooks and observed events, and `mason_automation(action: "check")` to resume its retained repair evidence. CLI fallback: `mason-auto status` / `mason-auto check`. Preserve existing baselines across sessions. Automatic checks do not authorize unrelated repairs or approve advisories.

Inspect source for what the retrieved context does not answer.
<!-- mason:end -->
