import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { attributionSchema } from "../decisions/provenance.js";
import {
  analyzeProject,
  checkDrift,
  exportToConfluenceTool,
  fullAnalysis,
  generateSnapshotBatch,
  getCodeSamples,
  getContext,
  getImpact,
  getSnapshot,
  saveDecision,
  reviewDecision,
  saveVerification,
  verifySnapshot,
  masonCompleteInit,
  masonInit,
  masonRepair,
  masonAutomation,
  masonSetConfluence,
  reduceSnapshot,
  saveSnapshotData,
  saveSnapshotPartial,
} from "./tools.js";

declare const PKG_VERSION: string;

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "mason",
      version: PKG_VERSION,
    },
    {
      instructions:
        "Mason retrieves recorded decisions, file impact, and optional feature/flow maps. Use get_context with the task and known files, and get_impact before editing. Save learned rationale and constraints with save_decision; review and commit the local records through the project workflow. These tools work without initialization or a concept map. Consult trust and diagnostics: changed or unknown freshness needs source inspection, failed verification needs correction, and proposals are suggestions and legacy records are unreviewed. Accepted decisions are recorded team constraints, still subject to freshness checks. Use review_decision to prepare code evidence and record only authorized acceptance, reaffirmation, or retirement. Never invent a reviewer or treat these recorded identities as authenticated approval. mason_init returns documentation audit and committed-diff review findings with a quickstart guide. Use mode: \"map\" only when a full architecture map is requested. A missing map is not a setup failure; use decisions and source evidence. get_snapshot provides architecture navigation when a map is available. The mason-audit and mason-review CLIs also work without setup.",
    }
  );

  server.tool(
    "mason_init",
    "Inspect this project now: returns documentation audit findings, committed-diff review findings, decision/map status, and a quickstart playbook. Read-only, deterministic, and usable without a map. Optional base selects the review comparison; evidence imports CI manifests with check outcomes, commit freshness, and links to changed files and accepted decisions. mode: map returns the full Map-Reduce build workflow. Repeat calls refresh findings even after setup.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      mode: z.enum(["quickstart", "map"]).optional().default("quickstart")
        .describe("Quickstart returns checks and a short setup guide; map requests a full architecture build."),
      base: z.string().optional().describe("Git ref for committed-diff review. Defaults to the first available main branch ref."),
      evidence: z.array(z.string()).max(10).optional().describe("Repository-local CI evidence manifests to include in the review. Imports Vitest JSON and SARIF without executing check commands."),
    },
    async ({ dir, mode, base, evidence }) => {
      const result = await masonInit(dir, { mode, base, evidence });
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "mason_automation",
    "Inspect installed automation and observed host events, or resume/check retained documentation repair evidence across sessions. status is read-only; check saves local baselines and verification reports without editing source or approving advisories. Returns concise results with a full report path. Works without a map.",
    {
      dir: z.string().describe("Absolute path to the project directory"),
      action: z.enum(["status", "check"]).describe("Inspect configuration and receipts, or capture/resume and verify original audit evidence."),
    },
    async ({ dir, action }) => ({ content: [{ type: "text", text: await masonAutomation(dir, action) }] })
  );

  server.tool(
    "mason_repair",
    "Track documentation repairs against original audit evidence. prepare saves a local baseline and returns a scoped work order; verify reads that baseline and reports resolved, unresolved, review-required, unverified, and new findings. Suppressed advisories remain unresolved. Does not edit documentation or approve decisions. No map required.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      action: z.enum(["prepare", "verify"]),
      baselinePath: z.string().optional().describe("Original baseline path returned by prepare; required for verify."),
      checks: z.array(z.enum(["deleted-reference", "new-module", "stale-count", "dead-command", "deps-changed", "decision-anchor-drift"]))
        .min(1).optional().describe("Optional audit check subset for prepare. Verification always uses the original checks."),
    },
    async ({ dir, action, baselinePath, checks }) => {
      const result = await masonRepair(dir, { action, baselinePath, checks });
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "mason_complete_init",
    "Record completion of assistant instruction setup in .mason/project.json. Other tools work without this marker. Repeated calls preserve the original setup time and existing settings; pass confluenceConfigured only to change that setting.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      confluenceConfigured: z
        .boolean()
        .optional()
        .describe("Set the Confluence setup status; omit to preserve the existing value"),
    },
    async ({ dir, confluenceConfigured }) => {
      const result = await masonCompleteInit(dir, { confluenceConfigured });
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "mason_set_confluence",
    "Configure Confluence credentials. Two-step flow: (1) call without `spaceKey` to validate the credentials and receive a list of available spaces — relay them to the user. (2) call again with the same `baseUrl`/`email`/`apiToken` plus the chosen `spaceKey` to persist. Credentials are stored in `~/.mason/config.json`. Warn the user that the API token will be visible in chat history before they paste it.",
    {
      baseUrl: z
        .string()
        .describe("Confluence base URL. Accepts `acme`, `acme.atlassian.net`, or `https://acme.atlassian.net` (normalized automatically)."),
      email: z.string().describe("User's Atlassian account email"),
      apiToken: z
        .string()
        .describe("API token from id.atlassian.com/manage-profile/security/api-tokens"),
      spaceKey: z
        .string()
        .optional()
        .describe("Confluence space key. Omit on the first call to list available spaces."),
      parentPageId: z
        .string()
        .optional()
        .describe("Optional parent page ID under which Mason's index page is created"),
    },
    async ({ baseUrl, email, apiToken, spaceKey, parentPageId }) => {
      const result = await masonSetConfluence({
        baseUrl,
        email,
        apiToken,
        spaceKey,
        parentPageId,
      });
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "full_analysis",
    "One-shot orientation for a project WITHOUT a concept map (get_snapshot returned exists:false). Returns git history stats, project structure with file counts, curated code sample previews (~60 lines each), and test-to-source mapping. On a mapped project, prefer get_snapshot — it is cheaper and answers feature/architecture questions directly.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await fullAnalysis(dir);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "analyze_project",
    "Run git history analysis on a codebase. Returns commit convention patterns, stale directories, and frequently changed files. These are aggregate stats across hundreds of commits that would be expensive to compute manually.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await analyzeProject(dir);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "get_code_samples",
    "Get previews (first ~60 lines) of representative source files from the codebase. Includes entry points, config files, hot files (frequently changed), test examples, and one file per directory for breadth. Read files natively for full content.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      count: z
        .number()
        .optional()
        .default(15)
        .describe("Maximum number of files to sample (default: 15)"),
    },
    async ({ dir, count }) => {
      const result = await getCodeSamples(dir, count);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "get_snapshot",
    "Return the optional feature-to-file architecture map with drift and trust evidence. If no map exists, returns exists:false plus project structure, Git signals, and test pairs. Decision capture, get_context, and get_impact still work. No initialization required.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await getSnapshot(dir);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "get_context",
    "Assemble task context: matching decisions with rationale, approval, owner, sources, last review, and freshness, plus related tests, file impact, and any available map entries. Proposals are suggestions; legacy records are unreviewed; accepted decisions are constraints subject to freshness. No initialization or map required. Pass task and optional files. map.status and diagnostics preserve missing or invalid knowledge. Impact covers up to three unique files, expanding directory anchors.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      task: z
        .string()
        .describe("The task, bug, or change request in natural language — e.g. 'add rate limiting to the API client' or a ticket description"),
      files: z
        .array(z.string())
        .optional()
        .describe("Optional file paths already known to be involved (e.g. from a diff or stack trace). Entries containing them are boosted above pure text matches."),
    },
    async ({ dir, task, files }) => {
      const result = await getContext(dir, task, files);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "generate_snapshot_batch",
    "Map step of the concept-map build. Returns one batch of source files (skeletons of every file in the batch plus a few deeper-read bodies for grounding), along with a system prompt instructing you to derive features and flows for ONLY this batch. Call repeatedly with the returned `nextOffset` until it is null, calling `save_partial_snapshot` between each call. Use product-natural feature names so partials merge cleanly in the reduce step.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      offset: z
        .number()
        .int()
        .optional()
        .describe("0-indexed file offset to start the batch at. Omit on the first call; pass the `nextOffset` from the previous response for subsequent calls."),
      batchSize: z
        .number()
        .int()
        .optional()
        .describe("Files per batch. Defaults to 50."),
      files: z
        .array(z.string())
        .optional()
        .describe("Scope the batch walk to this explicit file list — e.g. the drift set from mason_check_drift (changedFiles + unmappedFiles). Pass the SAME list on every batch call of one refresh run. Triggers refresh mode: reduce_snapshot will merge the partials into the existing map instead of rebuilding it."),
    },
    async ({ dir, offset, batchSize, files }) => {
      const result = await generateSnapshotBatch(dir, offset, batchSize, files);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "save_partial_snapshot",
    "Persist the partial concept map you derived for one batch. Call this once per batch, with the `batchId` from the `generate_snapshot_batch` response. Partials accumulate in `.mason/partial-snapshots/` and are merged in the reduce step.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      batchId: z
        .string()
        .describe("The `batchId` returned by `generate_snapshot_batch`."),
      offset: z
        .number()
        .int()
        .describe("The `offset` returned by `generate_snapshot_batch`. Used to order partials in the reduce step."),
      features: z
        .record(
          z.object({
            description: z.string(),
            files: z.array(z.string()),
            tests: z.array(z.string()).optional(),
            type: z
              .enum(["capability", "infrastructure"])
              .optional()
              .describe(
                '"capability" (user-facing functionality) or "infrastructure" (internal plumbing with no end user — DI/service wiring, config, logging, adapters). Defaults to "capability".'
              ),
          })
        )
        .describe("Partial features for this batch only — files outside the batch will be added by other partials."),
      flows: z
        .record(
          z.object({
            description: z.string(),
            chain: z.array(z.string()),
          })
        )
        .describe("Partial flows whose entire chain is in this batch. Cross-batch flows are reconstructed in reduce."),
    },
    async ({ dir, batchId, offset, features, flows }) => {
      const result = await saveSnapshotPartial(dir, batchId, offset, features, flows);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "reduce_snapshot",
    "Reduce step of the concept-map build. Returns every partial snapshot plus a system prompt asking you to merge them into one coherent project-wide map. Resolve platform variants into single product features, dedupe near-duplicates, and ensure no file is dropped. After producing the unified map, call `save_snapshot` to persist it (this also clears the partials).",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await reduceSnapshot(dir);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "save_snapshot",
    "Save a concept-to-files map as a persistent project snapshot. Maps feature names and data flows to the files that implement them. Persists across conversations — future sessions can call get_snapshot to instantly find relevant files. No API key needed — you are the LLM generating the map.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      features: z
        .record(
          z.object({
            description: z.string().describe("One-line description of the feature"),
            files: z.array(z.string()).describe("File paths that implement this feature"),
            tests: z.array(z.string()).optional().describe("Test file paths for this feature"),
            type: z
              .enum(["capability", "infrastructure"])
              .optional()
              .describe(
                'Classification: "capability" for user-facing functionality, "infrastructure" for internal plumbing with no end user (DI/service wiring, config, logging, adapters). Capabilities are published to Confluence; infrastructure stays in the AI concept map only. Defaults to "capability".'
              ),
          })
        )
        .describe("Map of feature names to their implementing files"),
      flows: z
        .record(
          z.object({
            description: z.string().describe("One-line description of the flow"),
            chain: z.array(z.string()).describe("Ordered list of file paths showing data/call flow"),
          })
        )
        .describe("Map of flow names to ordered file chains"),
      removeFeatures: z
        .array(z.string())
        .optional()
        .describe("Feature names to delete from the existing map — for features that were renamed or no longer exist. Applied before merging; only meaningful on incremental saves."),
      removeFlows: z
        .array(z.string())
        .optional()
        .describe("Flow names to delete from the existing map. Applied before merging; only meaningful on incremental saves."),
    },
    async ({ dir, features, flows, removeFeatures, removeFlows }) => {
      const result = await saveSnapshotData(
        dir,
        features,
        flows,
        removeFeatures ?? [],
        removeFlows ?? []
      );
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "save_decision",
    "Capture or revise a decision proposal with rationale, anchors, optional owner, sources, and a known actor. No setup or map required. Writes a local record and preserves content history. Changes create a pending proposal while the last accepted revision remains operative; unchanged content does not re-verify or refresh it. Use review_decision for authorized acceptance or reaffirmation. A proposal cannot supersede a record with an operative accepted revision; review its replacement and retire the original separately.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      title: z
        .string()
        .max(80)
        .describe("Short, specific headline — becomes the stable record id"),
      body: z
        .string()
        .max(1500)
        .describe("The knowledge itself: what was tried/decided, why, and what to avoid. Must contain information NOT derivable by reading the code."),
      category: z.enum(["decision", "gotcha", "deprecation", "convention"]),
      files: z
        .array(z.string())
        .optional()
        .describe("Repo-relative files or directory prefixes this applies to. Matching is shared by retrieval, hooks, review, and drift checking; changes flag the decision for re-verification."),
      id: z
        .string()
        .optional()
        .describe("Existing id to revise. Changed content becomes a proposal; unchanged content leaves the review and freshness untouched."),
      supersedes: z
        .string()
        .optional()
        .describe("Id of an unreviewed record or proposal with no accepted revision to replace. Operative accepted decisions require separate review and retirement."),
      owner: attributionSchema.shape.owner.describe("Responsible person or team, when known. Null clears it. Required for acceptance."),
      sources: attributionSchema.shape.sources.describe("Known PR, issue, incident, discussion, or document references. Omit to preserve; [] clears. At least one is required for acceptance."),
      actor: attributionSchema.shape.actor.describe("Known person or agent recording this revision. Omit if unknown; do not infer from Git identity."),
      force: z
        .boolean()
        .optional()
        .describe("Save even when a near-duplicate was detected"),
    },
    async ({ dir, title, body, category, files, id, supersedes, force, owner, sources, actor }) => {
      const result = await saveDecision(dir, {
        title,
        body,
        category,
        files,
        id,
        supersedes,
        force,
        owner,
        sources,
        actor,
      });
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "review_decision",
    "Prepare a decision review: returns the full record and history, any operative accepted revision, provenance, changes and previews for both sets of anchors, and a reviewToken. Then record accept, reaffirm, or retire with that token, the authorized reviewer, and a reason. Acceptance replaces the operative revision; retirement withdraws the entire record including its proposal. Acceptance requires owner, source, readable Git HEAD, and committed anchor changes. Changed records or code invalidate the token. Identities and approvals are recorded assertions for normal PR review, not authenticated proof.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      id: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Decision id from get_context or save_decision"),
      action: z.enum(["prepare", "accept", "reaffirm", "retire"]).optional().default("prepare")
        .describe("Prepare is read-only. Other actions record an explicitly authorized review."),
      reviewer: z.string().trim().min(1).max(200).optional().describe("Identity of the actual reviewer; required for a verdict. Never invent one."),
      note: z.string().trim().min(1).max(1500).optional().describe("Review rationale; required for a verdict. Cite evidence for the decision."),
      reviewToken: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Token from the prepared review; rejects stale record or code revisions"),
    },
    async ({ dir, ...input }) => {
      const result = await reviewDecision(dir, input);
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "mason_check_drift",
    "Check how far the concept map has drifted from HEAD. Deterministic (git + filesystem, no LLM). Returns which features/flows are stale and the changed files behind them, new source files not yet mapped, ghost files (mapped but deleted), renames, and a `recommendation`: `up-to-date` (nothing to do), `incremental` (update just the stale entries via save_snapshot), or `full-rebuild` (re-run the Map-Reduce build). Call this before trusting the map in a long session, or periodically to keep the map and any synced wikis fresh.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await checkDrift(dir);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "verify_snapshot",
    "Spot-check the concept map's CORRECTNESS (drift checks freshness; this checks entries were right to begin with). Returns a sample of entries — always the never-verified and least-recently-verified first — with skeletons of their claimed files, for you to judge whether the files actually implement what the entry claims. Report verdicts back via save_verification. Run periodically, or after an automated refresh wrote entries no human reviewed.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      sample: z
        .number()
        .int()
        .optional()
        .describe("Entries to sample (default 5)"),
    },
    async ({ dir, sample }) => {
      const result = await verifySnapshot(dir, sample);
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "save_verification",
    "Record verify_snapshot verdicts. Entries judged ok are stamped verifiedAt; failures are flagged verificationFailed with your note and surface in get_context, get_snapshot, and mason_check_drift until corrected. Verdict notes are required for failures.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      verdicts: z
        .record(
          z.object({
            ok: z.boolean(),
            note: z
              .string()
              .optional()
              .describe("One line on what's wrong — required when ok is false"),
          })
        )
        .describe("Entry name → verdict, exactly as returned by verify_snapshot"),
    },
    async ({ dir, verdicts }) => {
      const result = await saveVerification(dir, verdicts);
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "get_impact",
    "Trace the impact of changing files: historical co-change partners, references, and related tests. Deterministic, read-only, and usable without initialization, saved decisions, or a concept map.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      files: z
        .array(z.string())
        .describe("File paths or names to analyze (e.g., ['WeatherRepository.kt'] or ['src/services/auth.ts'])"),
    },
    async ({ dir, files }) => {
      const result = await getImpact(dir, files);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "export_to_confluence",
    "Sync the project's concept map to Confluence as product-readable wiki pages: an index page, one page per feature (PM-language descriptions, no file paths), and a changelog page. Mason replaces managed page bodies; manual edits to those bodies are overwritten. Requires `mason_set_confluence` to have been called first.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      spaceKey: z
        .string()
        .optional()
        .describe("Override the configured space key"),
      parentPageId: z
        .string()
        .optional()
        .describe("Override the configured parent page ID"),
      indexPageTitle: z
        .string()
        .optional()
        .describe("Title of the index page (default: 'Mason — System Map')"),
      changelogPageTitle: z
        .string()
        .optional()
        .describe("Title of the changelog page (default: 'Mason — Changelog')"),
      featurePagePrefix: z
        .string()
        .optional()
        .describe("Prefix for each feature page title (default: 'Feature: ')"),
    },
    async ({ dir, spaceKey, parentPageId, indexPageTitle, changelogPageTitle, featurePagePrefix }) => {
      const result = await exportToConfluenceTool(dir, {
        spaceKey,
        parentPageId,
        indexPageTitle,
        changelogPageTitle,
        featurePagePrefix,
      });
      return { content: [{ type: "text", text: result }] };
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
