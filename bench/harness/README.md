# Mason agentic benchmark harness

For actual code changes, use the [patch benchmark](patches/README.md): ten
controlled tasks, private behavioral checks, independent checkouts, configurable
coding-agent adapters, and reviewable false-positive judgments. Validate it
offline with `npm run bench:validate` from the repository root.

The remainder of this document describes the original **read-only Q&A** harness.
Its scores do not establish better patches or fewer regressions.

Measures Mason against a **fair baseline** by driving real headless Claude Code
sessions, not simulated contexts. This supersedes the hand-fed A/B comparison in
`bench/tests/test_mason.py`, which picks the file sets itself — here the agent
decides what to read, which is the thing Mason actually claims to improve.

## Design

Two arms per question, identical prompts, identical permissions:

| Arm | Context |
|---|---|
| `baseline` | Claude Code with a populated CLAUDE.md (generated via `/init` if the repo has none). No MCP servers. |
| `mason` | Same, plus the Mason MCP server (local `dist/` build) with a pre-built snapshot at the pinned commit. |

The mason arm gets no prompt nudge to use Mason — tool availability only. If the
agent doesn't reach for the tools, that's adoption friction and the numbers will
show it (`mason calls` column). Don't fix that by editing the prompt; fix it in
Mason's tool descriptions.

## Metrics

Per question × arm, from the session's stream-json:

- **quality** — 0–10, LLM judge (haiku) against a per-question rubric
- **cost / turns / tool calls / tokens** — from the session result event
- **first-action precision@K** — of the first K distinct files the agent Read,
  the fraction that are in the hand-authored ground-truth set. `n/a (0 reads)`
  means the agent answered without opening any file — for the mason arm that's
  the success mode, report it as such
- **recall@K** — fraction of ground-truth files found within the first K reads
- **mason calls** — which Mason tools were actually invoked

Setup costs are recorded, not hidden: snapshot build cost (a real headless
session running the Map-Reduce playbook) and CLAUDE.md generation cost land in
the results JSON as cost-of-ownership numbers.

## Run

Requires the `claude` CLI authenticated locally, and a fresh `npm run build` at
the repo root (the mason arm serves `dist/mason-mcp.js`).

```bash
cd bench/harness
node run.mjs --repo mason-self                      # all questions, both arms
node run.mjs --repo mason-self --arms baseline      # one arm
node run.mjs --repo mason-self --questions drift_location
node run.mjs --repo mason-self --checkout <commit>  # stale-map scenario (below)
```

Flags: `--model` (default `sonnet`), `--judge-model` (default `haiku`),
`--k` (default 5). Results land in `results/<timestamp>-<repo>.json`; a summary
table prints at the end.

## Adding a repo

Create `repos/<name>.json`:

```json
{
  "name": "hono",
  "git": "https://github.com/honojs/hono",
  "commit": "<pinned sha>",
  "questions": [
    {
      "id": "routing",
      "category": "location | architecture | task | impact",
      "question": "…",
      "criteria": "judge rubric — what a 10/10 answer must contain",
      "groundTruth": ["src/router.ts"]
    }
  ]
}
```

Ground truth must be authored by someone who actually knows the repo — explore
it first, don't guess. Aim for 4–8 questions covering all four categories.
Clones are pinned to `commit` and cached in `.clones/` (gitignored).

**Current suite** (all pinned, exploration-verified ground truth):

| config | repo | walked files | snapshot build (sonnet, 2026-07) |
|---|---|---|---|
| `mason-self` | this repo | ~40 | $0.80 / 142s — smoke only, never publish |
| `hono` | honojs/hono | 186 | $3.22 / 380s |
| `vue-core` | vuejs/core | 483 | $5.63 / 766s |
| `nest` | nestjs/nest | 1676 (incl. sample/integration noise) | $19.52 / 1668s |
| `caddy` | caddyserver/caddy (Go) | 322 | $0.56 / 70s |

Build cost scales roughly linearly (~$1.2 per 100 files) on the TS repos;
caddy came in far under that — Go sources batched much more efficiently.

**Findings so far** (sonnet, 2026-07; publish losses too):
- Code-derivable Q&A is saturated: quality is parity on all four repos
  (hono 8.8/8.7, vue-core 8.7/8.8, nest 8.8/8.5, caddy 8.8/8.8
  baseline/mason — nest is a mason *loss*, partly a rubric-overspecificity
  artifact on the template choice). Mason wins first-action precision/recall
  on vue-core and caddy, loses both slightly on nest, and tends to answer
  the hardest questions in fewer turns (caddy config_reload: 15 vs 26).
- The separation is on non-code-derivable knowledge: decision-backed tasks
  went 9.0 (mason) vs 7.0 (baseline) — the baseline missed the recorded
  constraint entirely in 1 of 2 questions and needed 3× the turns when it
  found it.
- Stale-map scenario: the mason arm consulted a deliberately stale map,
  received the drift flag + changed-file previews, verified against source,
  and answered current-code truth — the poisoning failure mode did not occur.
- Adoption requires the CLAUDE.md section (salience hierarchy: project
  instructions > tool descriptions > tool availability). The setup playbook
  now installs the section itself, including in fully autonomous headless
  inits.

## Stale-map scenario

Mason's differentiator: what happens when the map rots. Build the snapshot at
the pinned commit, then `--checkout <later-commit>` moves the working tree
forward while the snapshot stays behind. Run questions that target code changed
in between and compare arms — the question is whether drift detection stops the
mason arm from confidently jumping to files that no longer do what the map
says, and whether the baseline (which never trusted a map) comes out ahead or
behind.

## Honest-reporting rules

- Publish losses alongside wins. A table where Mason wins every row reads as
  rigged, because it would be.
- The baseline always gets a CLAUDE.md. Beating a context-free agent is not a
  result.
- Judge scores on identical rubrics for both arms; never re-run the judge until
  it agrees with you.
- Every published number comes from a results JSON in `results/` with its
  pinned commit — re-runnable by anyone.
