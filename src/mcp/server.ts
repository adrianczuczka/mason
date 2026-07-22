import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
  masonCompleteInit,
  masonInit,
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
        "Mason maintains a persistent feature-to-file concept map of this codebase so you can skip manual exploration. RULE: when given a task, bug, or change request, call `get_context` with the task text first — one call returns the relevant features, files, tests, blast radius, and freshness. Before answering ANY question about features, architecture, data flows, or where something lives — and before any grep/glob/file-read exploration for such a question — call `get_snapshot` first. One call returns the whole map and replaces 5-10 search round-trips; if it has drifted it says so and self-corrects. Likewise call `get_impact` BEFORE editing or refactoring a file (git co-change history + references + related tests — signals you cannot get from reading the file itself), and `mason_check_drift` to verify the map is fresh in long sessions. When you learn something the code alone can't tell you — a failed approach, a deprecation, a workaround's reason, a review-settled convention — record it with `save_decision` so the whole team's assistants inherit it; `get_context` returns matching decisions as constraints. If `get_snapshot` reports no snapshot exists, offer to set Mason up: `mason_init` returns a setup playbook (a Map-Reduce loop of `generate_snapshot_batch` + `save_partial_snapshot`, then `reduce_snapshot` + `save_snapshot`, optionally `mason_set_confluence`, then `mason_complete_init`). `full_analysis`, `analyze_project`, and `get_code_samples` are read-only diagnostics for unmapped projects and never need init. Mason has no CLI; everything happens through these tools.",
    }
  );

  server.tool(
    "mason_init",
    "Start here. Checks if Mason is set up for this project. If not, returns a `playbook` of questions the assistant must walk the user through (concept map + optional Confluence sync). Once the walkthrough is done, call `mason_complete_init`. Idempotent: re-running on an already-initialized project just returns the current state.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await masonInit(dir);
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "mason_complete_init",
    "Mark the project as initialized. Call this after walking the user through the playbook returned by `mason_init`. Writes `.mason/project.json` so future tool calls don't re-run the wizard. Pass `confluenceConfigured: true` if Phase 3 of the playbook ended with Confluence credentials saved.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      confluenceConfigured: z
        .boolean()
        .optional()
        .default(false)
        .describe("True if Confluence was successfully configured during init"),
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
    "CALL THIS FIRST — before grep, glob, or reading files — for any question about what this codebase does, its features, architecture, data flows, or where something is implemented ('where is X handled?', 'how does Y work?', 'what implements Z?'). Returns the persistent feature-to-file concept map in one cheap, instant, LLM-free call, replacing 5-10 exploration round-trips. Example: 'home screen' → [HomeScreen.kt, HomeViewModel.kt, HomeModule.kt]. Then read only the mapped files. If the map has drifted it says so (with a diff) — trust the freshness signal. If exists:false, the project isn't set up; offer mason_init.",
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
    "CALL THIS FIRST when given a task to implement, a bug to fix, a ticket, or a change request ('add X', 'fix Y', 'refactor Z'). One call returns everything needed to start: the matching features/flows with their files, related tests, blast radius for the key files (git co-change + references), and per-entry freshness — replacing a get_snapshot + get_impact + test-hunting sequence. Cheap, instant, LLM-free. Pass the task in natural language; optionally pass `files` (e.g. from a diff) to anchor the match. For open-ended architecture questions with no task, use get_snapshot instead.",
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
    "CALL THIS when you learn something about this codebase that the code alone can't tell you: a failed approach ('we tried X, it broke Y'), a deprecation ('don't extend Z'), a workaround and its reason, or a convention settled in review. Best moments: the end of a debugging session, right after a design choice. Records are git-committed to .mason/decisions/ and PR-reviewed like code; get_context surfaces them on matching tasks. Do NOT record anything derivable by reading the code, session trivia, or secrets. Also handles updates (pass id), re-verification (same id + content re-pins to HEAD), and supersession (pass supersedes).",
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
        .describe("Repo-relative files this applies to. Anchors drift-checking: if these change, the decision is flagged for re-verification."),
      id: z
        .string()
        .optional()
        .describe("Existing decision id to update. Passing id with unchanged content re-verifies it (re-pins refreshedHash to HEAD)."),
      supersedes: z
        .string()
        .optional()
        .describe("Id of a decision this one replaces — the old record is kept but marked superseded"),
      force: z
        .boolean()
        .optional()
        .describe("Save even when a near-duplicate was detected"),
    },
    async ({ dir, title, body, category, files, id, supersedes, force }) => {
      const result = await saveDecision(dir, {
        title,
        body,
        category,
        files,
        id,
        supersedes,
        force,
      });
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
    "get_impact",
    "CALL THIS BEFORE editing, refactoring, or assessing the blast radius of any file. Returns three signals you cannot get by reading the file itself: git co-change history (files that historically change in the same commits), references (files that mention the target by name), and related tests. One call replaces a manual sweep of grep + git log. Also the right tool for 'what would break if I changed X?' questions.",
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
    "Sync the project's concept map to Confluence as product-readable wiki pages: an index page, one page per feature (PM-language descriptions, no file paths), and a changelog page. Hand-edits outside `<!-- mason:start/end:* -->` markers are preserved across syncs. Requires `mason_set_confluence` to have been called first.",
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
