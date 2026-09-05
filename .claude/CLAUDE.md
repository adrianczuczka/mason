# CLAUDE.md

## Project Overview

Mason is an MCP server for recorded engineering decisions, task context, change impact, and documentation audit/review. These work without initialization or a concept map. An optional feature-to-file map (`.mason/snapshot.json`) adds architecture navigation, with drift detection and verification. Confluence export is configured separately.

**Tech stack:** TypeScript, Node 20+, ESM modules
**Build:** tsup (bundler), vitest (testing)
**Package:** `mason-context` on npm

For product direction, prioritization, and growth or scalability tradeoffs, consult [ROADMAP.md](../ROADMAP.md) and its linked Mason memory. It preserves the definitive context engineer goal, the original five priorities, shipped progress, and proposed next work; keep those distinctions intact.

## Architecture

Mason exposes an MCP server and standalone deterministic CLIs. Entry points:
- **MCP Server** (`bin/mason-mcp.ts` → `src/mcp/server.ts`) — tool server for AI assistants; all functionality lives here
- **mason-drift** (`bin/mason-drift.ts` → `src/drift/cli.ts`) — headless CI staleness check for the concept map (exit 0 fresh / 1 stale / 2 error); read-only and LLM-free
- **mason-audit** (`bin/mason-audit.ts` → `src/audit/cli.ts`) — deterministic context-file audit, read-only by default (exit 0 no issues / 1 issues / 2 error). Explicit `--prepare-repair` saves original evidence; `--verify-repair` reads it and returns 2 for incomplete verification or outstanding advisory review. Works without Mason setup.
- **mason-auto** (`bin/mason-auto.ts` → `src/automation/cli.ts`) — shared documentation automation with Claude Code and Codex lifecycle adapters. Retains baselines per worktree/branch, resumes repairs, caches checks by dependencies, and reports configured hooks separately from observed events. `status` is read-only; `check` writes local evidence and exits 0 verified / 1 issues / 2 incomplete.
- **mason-hook** (`bin/mason-hook.ts` → `src/hook/cli.ts`) — Claude Code PostToolUse hook: injects decision records anchored to the file a session just read or edited; deterministic, per-session deduped, silent on no match (this repo dogfoods it via `.claude/settings.json`)
- **mason-review** (`bin/mason-review.ts` → `src/review/cli.ts`) — diff review vs a base ref: flags absent historical co-change partners and touched decisions. Optional CI evidence imports preserve outcomes and provenance. Exit 0 no missing partners / 1 missing partners / 2 error; `--require-evidence` additionally gates on current, complete passing checks.
- **mason** (`bin/mason.ts`) — deprecation shim that prints a migration message

### Core Modules

```
src/
├── analyzers/          # Pluggable analyzers (git-history)
│   ├── index.ts        # Runner — executes all analyzers
│   └── git-history.ts  # Commit conventions, hot files, stale dirs
├── audit/              # mason-audit: context-file audit engine
│   ├── audit.ts        # computeAudit orchestrator
│   ├── claims.ts       # Markdown claim extraction (paths, counts, commands)
│   ├── tree.ts         # ASCII directory-tree reconstruction
│   ├── docs.ts         # Context-file discovery + git metadata
│   ├── cli.ts          # mason-audit CLI (summary, --json, --fix-prompt)
│   ├── repair.ts       # Original audit baselines and per-finding verification
│   └── checks/         # One check per file + registry (issues vs advisories)
├── automation/         # Shared repair runtime, cache, durable state, host adapters, installation/CLI
├── confluence/         # Confluence wiki sync (client, renderer, diff, sync)
├── context/            # Task retrieval + shared freshness/verification trust states
├── decisions/          # Decision capture, provenance, review, and drift
│   ├── decisions.ts    # Legacy/v2 store, proposal revisions, serialized writes
│   ├── provenance.ts   # Validated history, approval, sources, owner, shared guidance
│   ├── review.ts       # Prepared evidence and authorized verdicts with conflict checks
│   └── drift.ts        # Committed and local anchor freshness
├── drift/
│   ├── drift.ts        # computeDrift — per-entry staleness vs git HEAD
│   └── cli.ts          # mason-drift CLI (arg parsing, summary, exit codes)
├── hook/
│   ├── hook.ts         # Decision injection on file touch (PostToolUse)
│   └── cli.ts          # mason-hook CLI (stdin JSON → hook output JSON)
├── impact/
│   └── impact.ts       # Change impact: co-change, references, related tests
├── llm/
│   ├── config.ts       # Provider config (~/.mason/config.json)
│   └── providers.ts    # Multi-provider LLM calls (used by Confluence rewrite)
├── mcp/
│   ├── server.ts       # MCP tool definitions (Zod schemas)
│   ├── tools.ts        # Tool implementations — the core logic
│   ├── init.ts         # Quickstart + optional map playbooks
│   ├── onboarding.ts   # Read-only audit/review summaries and store status
│   └── sampler.ts      # Smart file selection by architectural role
├── review/
│   ├── review.ts       # computeReview: diff vs base, touched decisions
│   ├── cochange.ts     # Single-pass co-change matrix from git history
│   ├── evidence.ts     # Read-only CI imports, freshness, file/decision associations
│   ├── evidence/       # Vitest JSON and SARIF parsers, report path normalization
│   └── cli.ts          # mason-review CLI (summary, --json, exit codes)
├── snapshot/
│   ├── snapshot.ts     # Snapshot load/save, batch preparation
│   ├── partials.ts     # Map-Reduce partials + scoped-refresh scope marker
│   └── prompt.ts       # Batch / reduce / refresh-reduce system prompts
├── test-map.ts         # Test-to-source pairing by naming convention
├── types.ts            # Shared interfaces
└── utils/
    ├── git.ts          # Git repo detection
    ├── files.ts        # Shared Git-aware file selection and bounded reads
    ├── paths.ts        # Path normalization, containment, and anchor matching
    └── storage.ts      # Validated metadata paths and atomic JSON replacement
```

## Development Commands

```bash
npm run build          # Build with tsup
npm run dev            # Build in watch mode
npm test               # Run tests (vitest run)
npm run test:evidence  # Run tests and record artifacts for mason-review
npm run typecheck      # Check TypeScript without emitting files
npm run test:watch     # Run tests in watch mode
```

## Code Conventions

- **Conventional commits** required: `type(scope): description` (e.g., `feat(auth): add login endpoint`).
- **ESM modules** — all imports use `.js` extensions (`import { foo } from "./bar.js"`)
- **Zod** for runtime validation (MCP tool schemas)
- **No classes** in most modules — functional style with exported async functions. Exception: analyzers use classes implementing an `Analyzer` interface.

## Testing

- Tests live in `test/` directory with `.test.ts` extension
- Test fixtures in `test/fixtures/` — multi-language sample projects (Go, Python, Kotlin, React, Rust, Swift) used to test Mason's analysis capabilities
- Test files map directly to source: `test/drift.test.ts` → `src/drift/drift.ts`
- Tests use temp directories for git operations (create repos, make commits, verify analysis)
- Benchmarks live in `bench/` — `bench/harness/` drives real headless claude sessions in baseline-vs-mason arms (superseded older deepeval harness sits in `bench/tests/`)
- `bench/harness/run-patches.mjs` evaluates actual patches using the built-in Claude driver or a custom JSON agent adapter. `bench/harness/patches/` owns controlled tasks, fixtures, held-out grading, and reports. `npm run bench:validate` is offline; live runs use model calls. Never describe reference-patch validation as agent-performance evidence.
- `bench/harness/run-automation.mjs` evaluates ordinary rename and control requests across Claude Code and Codex; `bench/harness/automation/` owns fixtures, real host sessions, and grading. `npm run bench:automation -- --validate` replays lifecycle events offline; `--live` uses actual hosts, preserving transcripts and configuration/activation evidence. The original patch harness still disables hooks for its controlled comparison.
- Repository scripts live in `scripts/`; `scripts/pack-mcpb.mjs` builds the MCP bundle. `scripts/test-evidence.mjs` runs Vitest and records its actual exit status, original commit, and checkout cleanliness before/after execution for CI review. Reports under `.mason/reports/` are ignored.
- CI evidence uses a version 1 manifest with named expected checks and Vitest JSON or SARIF artifacts. Imports never execute commands or fetch URLs. Missing/invalid reports stay unavailable; stale or dirty/unknown runs never satisfy the optional gate. Imported provenance is an assertion, not authenticated execution. File matches and test pairs associate accepted decisions without asserting a violation. Review JSON stays version 1 with optional additive `evidence`; default exit codes stay unchanged.

## Concept-Map Lifecycle (key patterns)

- **Map-Reduce build**: `generate_snapshot_batch` walks source files in batches; the assistant writes partials via `save_partial_snapshot`; `reduce_snapshot` returns everything for the assistant to merge; `save_snapshot` persists (replace mode when partials exist, merge mode otherwise).
- **Decision provenance**: new records are version 2 proposals; version 1 stays unreviewed until explicitly revised/reviewed. `review_decision` prepares record and code evidence before acceptance/reaffirmation/retirement. Verdicts require a named reviewer, reason, and matching token; acceptance also needs owner/source and committed anchors. Content changes create pending proposals while the prior accepted revision remains operative. Readers derive both from history, track their anchors separately, and replace the operative revision only on acceptance or retirement. Unchanged saves never re-verify. These are recorded assertions, not authenticated approvals.
- **Trust**: `src/context/trust.ts` separates freshness (`current`, `changed`, `unknown`) from verification (`unverified`, `passed`, `failed`). Primary readers and hooks must preserve uncertainty and failed verdicts. Unchanged anchors do not prove correctness.
- **Drift detection**: `mason_check_drift` / `src/drift/drift.ts` compare the map against HEAD deterministically (git `--name-status -M` diff per distinct verification hash). Each feature/flow may carry a `refreshedHash` — the commit it was last verified against — so partially refreshed maps still report stale entries. Commit distance alone does not indicate drift; map-only and unrelated commits stay clean. Working-tree edits are reported separately from committed drift.
- **Scoped refresh**: `generate_snapshot_batch` with a `files` list walks only the drift set and writes a scope marker (`.mason/partial-snapshots/scope.json`); `reduce_snapshot` then merges partials into the existing map instead of rebuilding.
- **Incremental save**: `save_snapshot` merge mode accepts `removeFeatures`/`removeFlows` for renamed/deleted features and stamps refreshed entries with HEAD while backfilling untouched entries with the previous hash.
- **Sampler**: `src/mcp/sampler.ts` selects representative files by role (config, entry point, viewmodel, repository, service, handler, middleware, test). Configurable via project-level `.mason/config.json` with custom sampling patterns.
- **Tool metadata lives in three places** — keep them in sync when adding/changing tools: `src/mcp/server.ts` (Zod schemas), `manifest.json` (MCPB manifest), README tools table.

## LLM Provider Support

LLM calls happen only in the Confluence sync rewrite (`src/confluence/rewrite.ts` via `src/llm/providers.ts`); the concept map itself is written by the connected assistant, not by Mason. Providers: claude (API or CLI), openai (API), ollama (CLI), gemini (CLI). Config stored at `~/.mason/config.json`.

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
