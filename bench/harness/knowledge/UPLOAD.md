# Interrupted-upload maintenance probe

This second development case tests whether an ordinary recovery task updates an existing lesson when its assumptions change. It compares current Mason guidance with explicit project notes, using the same isolated host runner as the [R8 lifecycle evaluation](LIFECYCLE.md).

The starting lesson comes from a reconstructed interrupted-upload incident: the acknowledgement was lost, but inspecting the retained edit showed the intended bundle already present. Version and SHA-256 verification avoided a repeated upload or build-number change. Transport causation remained unknown, and a successful smaller chunk size was an incident-specific fallback.

The maintenance task introduces a **constructed retention change**: the old edit has expired. Its former contents are unavailable, so recovery needs a new edit and the unchanged artifact/version. This branch tests the limits of “reuse the original edit.” It is not a claim about a particular production API's expiration policy.

## Stages and grading

| Stage | Starting evidence | Ordinary task | Required outcome |
|---|---|---|---|
| Maintenance | Reviewed reference lesson, changed retention document, reconstructed incident | Investigate and finish the interrupted release | Inspect the original edit; recover with the same artifact/version; propose a revision of the existing lesson |
| Independent review | Actual proposal, prior accepted content, source and publishing journal | Accept or reject the revision | Preserve supported rationale, unavailable evidence and approval boundaries |
| Fresh reuse | Reviewed revision and a different release; incident file absent | Finish another interrupted release | Retrieve/use the revised guidance, handle expiration, retain artifact identity and avoid another knowledge change |
| First-upload control | The same reviewed starting lesson; no interruption | Perform the first upload and finish the existing edit | Upload once without creating or revising knowledge |

**The initial lesson is deliberately seeded and reviewed as fixture setup.** This probe measures maintenance and reuse, not spontaneous capture of the original incident. Missing revisions are never seeded or repaired by the grader. Both arms get equivalent starting knowledge. Mason uses real decision tools and history; the notes receipt retains accepted text and review history.

The publishing MCP server holds an in-process local protocol model. It can inspect/create edits, upload the fixed synthetic artifact, attach its mapping and finish an edit. It makes no network calls, reads no credentials and changes no real release. Its journal lives outside the agent's disposable repository. The grader replays observed operations, checks that inspection preceded side effects, detects extra edits/uploads, verifies identity and completion, and rejects repository-input or review-receipt edits. It cannot establish what the model internally understood from a checksum response.

Deterministic controls also cover an active empty edit, an already matching bundle that needs no upload, a mismatched artifact, forged completion receipts, missing inspection and duplicate side effects. These are protocol-model checks, not production integration tests or measurements of upload latency. The live case and acceptance criteria are frozen before the first live run.

## Running

No Java or R8 is required for this case.

```sh
npm run build
npm run bench:knowledge:upload -- --validate
npm run bench:knowledge:upload -- --live --hosts codex --arms candidate,notes
```

The runner accepts `--hosts codex,claude`, `--arms candidate,notes`, `--model`, `--timeout-ms`, `--budget-usd` and `--output`. Defaults are 180 seconds and at most three fresh sessions per arm. Claude's dollar cap applies per session; Codex costs are recorded when available and are not capped. Hooks and native private memory are disabled. There are no automatic retries.

Exit 2 means a proposal awaits independent review. Inspect `review-requests.json`, the actual record/notes, source, transcript and publishing journal. Supply a separate file:

```json
{
  "codex-upload-candidate": {
    "reviewDigest": "exact digest from review-requests.json",
    "verdict": "accept",
    "reviewer": "actual reviewer identity",
    "reason": "Specific assessment against the provided evidence."
  }
}
```

Use `reject` for unsupported or unhelpful revisions; do not rewrite the agent's proposal to pass the benchmark. Review support for owner/source claims semantically, rather than requiring one spelling. Capture eligibility is not approval, and a review applies only to the synthetic fixture.

```sh
npm run bench:knowledge:upload -- --resume /absolute/run/directory --reviews /absolute/reviews.json
```

The harness records real acceptance through MCP, commits the final metadata and starts a fresh checkout/session. A changed server or harness requires a new run. Interrupted review remains incomplete. Exit 0 requires both reviewed maintenance and follow-up/control success for every selected arm; exit 1 records completed failures. Reports preserve individual stages, transcripts, journals, configuration fingerprints, reviewers, usage and unknown costs.

Focused regressions: `npx vitest run test/knowledge-upload.test.ts`. Results from this probe and the unchanged R8 rerun are recorded in [revision-guidance results](REVISION_GUIDANCE_RESULTS.md). These small development trials do not establish a general advantage over notes, a false-positive rate or production upload reliability.
