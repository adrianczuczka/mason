# Conditional knowledge across changing requirements

This development case extends the [capture/reuse benchmark](README.md) through a changed assumption, a reviewed revision, and another fresh session. It reconstructs a sequence found in Jacket history: remove an unused background scheduler after a release-only startup crash; reintroduce it for a feature; repair the same crash when it returns. Names, ownership and incident evidence in the fixture are synthetic. No private source files or original logs are copied.

The lasting lesson is conditional: removing an unused integration avoids its initialization; it does not resolve a shrinker hazard when the integration becomes necessary again. Neither a permanent scheduler ban nor an unqualified claim that an upstream upgrade fixed it is supported.

The [first development smoke results](LIFECYCLE_RESULTS.md) include both arms, the missed Mason revision, grading corrections, and the limits of the comparison.

## What runs

| Stage | Ordinary request | Required outcome |
|---|---|---|
| Capture | Investigate the release startup crash and remove the unused integration | Working release startup and one useful, sourced proposal |
| Independent review | Inspect the actual proposal, source and patch | Accept or reject; no grader-written replacement |
| Reconsider | Implement newly required background forecast refresh | Working scheduler under release shrinking; revise the lesson while preserving accepted history |
| Independent review | Inspect the actual revision and changed requirements | Accept or reject the updated guidance |
| Follow-up | Add another background job in a fresh session | Preserve release startup and use the accepted revision |
| Control | Change a greeting in an unrelated fresh fixture | Correct edit without creating knowledge |

Both independent reviews are committed through the final metadata commit. Fresh checkouts have no incident file, parent checkout remote, resumed conversation, or native private memory. Git history remains available to both arms. Mason uses current project guidance and actual MCP tools. The comparison arm uses explicit `PROJECT_NOTES.md` guidance and a review receipt retaining previously accepted text. Hooks are disabled to isolate instructions, records and tools.

The small application is a **reduced JVM model**, not an Android app. It compiles Java, runs actual [R8](https://r8.googlesource.com/r8/+/refs/heads/main/README.md) in release/classfile mode, and invokes a generated constructor through reflection. `app.json` configures the integration and modeled jobs; `keep.pro` supplies bounded keep declarations. The private grader executes its own checker rather than trusting an edited public checker. Unsupported R8 directives, disabling shrinking, changed checker files and invented application flags fail validation.

Preflight must demonstrate that debug starts, the unprotected release fails specifically at constructor lookup, dependency removal starts, and two different constructor-preserving rules start with background work enabled. This validates the failure mechanism and a valid alternative. It does **not** establish correct Android initialization, Room compatibility, real job scheduling, or behavior on a device.

## Run it

Supply an existing R8 artifact and a compatible JDK home. An Android SDK build-tools `lib/d8.jar` may contain `com.android.tools.r8.R8`. The harness performs no automatic downloads and records the artifact digest and reported versions. Missing or incompatible tools abort before model calls.

```sh
npm run build
export MASON_EVAL_R8_JAR=/absolute/path/to/r8-or-d8.jar
export MASON_EVAL_JAVA_HOME=/absolute/path/to/jdk/home
npm run bench:knowledge:lifecycle -- --validate
npm run bench:knowledge:lifecycle -- --live --hosts codex --arms candidate,notes
```

Alternatively pass `--r8-jar` and `--java-home`. Supported hosts are `codex` and `claude`, using the existing isolated host runner and authentication. Defaults are one repeat, 180 seconds per session, and up to four sessions per arm. `--repeats`, `--timeout-ms`, `--budget-usd`, `--model` and `--output` are available. Claude's dollar limit applies per session; Codex usage is recorded without a dollar cap. Omitting `--model` preserves the host default.

Exit 2 means independent review is pending. Read the run's `review-requests.json`, proposal, source, native result and session transcript. A person or a separate reviewing agent supplies a JSON file:

```json
{
  "codex-r8-1-candidate/capture": {
    "reviewDigest": "exact digest from review-requests.json",
    "verdict": "accept",
    "reviewer": "actual reviewer identity",
    "reason": "Specific assessment of the proposed lesson against the supplied evidence."
  }
}
```

Use `reject` when the proposal is inaccurate or unhelpful. Do not repair its wording to make the trial pass. Automated eligibility is only a structural prerequisite. The digest binds the proposal, application patch, requirements, incident, native result and commit being reviewed. Fixture acceptance authorizes no real-project decision.

```sh
npm run bench:knowledge:lifecycle -- --resume /absolute/run/directory --reviews /absolute/reviews.json
```

After reconsideration, review the new `.../reconsider` packet and resume again. A reviewer familiar with implementation should disclose that; such review is not blind. Changed harness/server/toolchain identity requires a new run. Failed captures, failed sessions and interrupted reviews remain failures or incomplete; no automatic retries or seeded records. Exit 0 requires the whole selected matrix to pass; exit 1 reports completed failures.

A discovered grading defect can be reassessed with `--regrade RUN --reason TEXT` once sessions have completed, before the final review boundary. This archives the original report, records the reason and old grader identity, and regrades all artifacts awaiting review without agent calls or proposal edits. Applied reviews remain unchanged. Changes to execution code, the server or toolchain require a new run. Report such development reassessments; they are not blind evaluations.

## Reading results

`report.json` retains per-stage results, independent verdicts, proposals, commit/file snapshots, native execution, session identities, elapsed time, usage and unknown costs. Adjacent transcripts and MCP receipts permit review. The MCP observer records application-file digests when context is returned to establish retrieval before edits. That observation alone does not establish that context caused success.

This is one known development case. A tie with notes is a tie; a missing revision is a maintenance failure even if the patch works. Report false captures on the control separately. Repeated runs, more real incidents and independent repository validation are still needed before claiming lower error rates or an acceptable false-positive rate. The existing ElevenLabs checkout remains a later independent validation target.

Focused regression checks:

```sh
npx vitest run test/knowledge-lifecycle.test.ts test/knowledge-benchmark.test.ts
```

The native regression cases run when both toolchain environment variables are supplied; otherwise Vitest explicitly skips them. The benchmark itself always requires native preflight and cannot report a pass without it.
