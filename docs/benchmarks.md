# Benchmarks and limitations

[← Mason](../README.md)

## What the numbers say

Measured with real headless agent sessions in A/B arms (baseline always has a populated CLAUDE.md — beating a context-free agent is not a result). Full harness, pinned commits, and losses included: [bench/harness/](../bench/harness/).

The scores below concern read-only answers. The [patch benchmark](../bench/harness/patches/README.md) grades actual code changes, companion updates, and constraint preservation. The initial reported ten-task patch comparison tied at **10/10 for both arms**, as recorded in the [roadmap](../ROADMAP.md). Improved patch outcomes and an acceptable false-positive rate remain to be established; offline validation and hook replay establish mechanism behavior.

- **Where Mason wins — knowledge that isn't in the code.** On tasks whose correct answer hinges on a recorded engineering decision (seeded fairly: the baseline had the same facts in a discoverable doc), Mason averaged **9.0/10 vs 7.0/10**. The baseline missed the constraint entirely half the time, and needed ~3× the turns when it found it; Mason surfaced it in one `get_context` call, every time.
- **Stale-map safety.** Against a deliberately stale map, the drift flag + changed-file previews led the agent to verify and answer current-code truth — the "confidently wrong from a stale cache" failure did not occur.
- **Where it's a wash — and we say so.** On questions agents can answer by reading code, quality is parity across hono (186 files), vuejs/core (483), and nestjs/nest (1676): 8.7–8.8 both arms, with Mason slightly *behind* on nest (8.5 vs 8.8). If your only questions are "how does X work", modern agents don't need a map.
- **Cost of ownership, measured.** Map builds scale linearly at ~$1.20 per 100 files (Sonnet): $3.22 for hono, $5.63 for vue-core, $19.52 for nest. Incremental refreshes after drift are cents.
