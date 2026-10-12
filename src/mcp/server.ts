import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { inactiveSetupMessage } from "../setup/launcher.js";
import { attributionSchema } from "../decisions/provenance.js";
import {
  decisionTitleSchema,
  decisionBodySchema,
  BODY_RECOMMENDED_CHARS,
  BODY_MAX_CHARS,
  TITLE_MAX_CHARS,
} from "../decisions/decisions.js";
import {
  checkDrift,
  getContext,
  getImpact,
  getSnapshot,
  saveDecision,
  reviewDecision,
  saveVerification,
  verifySnapshot,
  masonCompleteInit,
  masonInit,
  masonAutomation,
  saveSnapshotData,
} from "./tools.js";

declare const PKG_VERSION: string;

export function createMcpServer(): McpServer {
  const setupNotice = inactiveSetupMessage();
  const server = new McpServer(
    {
      name: "mason",
      version: PKG_VERSION,
    },
    {
      instructions:
        (setupNotice ? setupNotice + "\n\n" : "") +
        "Mason retrieves recorded decisions, file impact, and optional feature/flow maps. Use get_context with the task and known files, and get_impact before editing. Save learned rationale and constraints with save_decision as soon as evidence supports them, without waiting for implementation or merge; review and commit the local records through the project workflow. These tools work without initialization or a concept map. Consult trust and diagnostics: changed or unknown freshness needs source inspection, stale or unknown map verification needs a fresh review, recorded failed verdicts need correction, and proposals are suggestions and legacy records are unreviewed. Accepted decisions are recorded team constraints, still subject to freshness checks. Use review_decision to prepare and inspect code evidence without claiming human approval; acceptance, reaffirmation, or retirement require an authorized review. Never invent a reviewer or treat these recorded identities as authenticated approval. mason_init returns documentation audit and committed-diff review findings with a quickstart guide. A missing map is not a setup failure; use decisions and source evidence. get_snapshot provides architecture navigation when a map is available. The mason-audit and mason-review CLIs also work without setup.",
    },
  );

  server.tool(
    "mason_init",
    "Inspect this project now: returns documentation audit findings, committed-diff review findings, decision/map status, and a quickstart playbook. Quickstart is read-only and deterministic. Explicit mode: setup validates shared configuration and activates locally without editing shared files; mode: init explicitly prepares MCP, instructions and lifecycle hooks for review and commit. Neither runs audits or prepares repairs; use only when requested. Optional host selects codex or claude. Optional base selects the review comparison; evidence imports CI manifests with check outcomes, commit freshness, and links to changed files and accepted decisions. Repeat calls refresh findings even after setup.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      mode: z
        .enum(["quickstart", "init", "setup"])
        .optional()
        .default("quickstart")
        .describe(
          "Quickstart inspects without edits; init prepares shared configuration; setup activates compatible configuration locally.",
        ),
      host: z
        .enum(["codex", "claude"])
        .optional()
        .describe("Assistant to configure in init/setup mode; inferred only when unambiguous."),
      dryRun: z
        .boolean()
        .optional()
        .describe("Init only: preview shared configuration changes without writing files."),
      base: z
        .string()
        .optional()
        .describe(
          "Quickstart only: Git ref for committed-diff review. Defaults to the first available main branch ref.",
        ),
      evidence: z
        .array(z.string())
        .max(10)
        .optional()
        .describe(
          "Quickstart only: repository-local CI evidence manifests to include in the review. Imports Vitest JSON, SARIF, and native-validator mason-check-json results without executing check commands.",
        ),
    },
    async ({ dir, mode, host, dryRun, base, evidence }) => {
      const result = await masonInit(dir, { mode, host, dryRun, base, evidence });
      return { content: [{ type: "text", text: result }] };
    },
  );

  server.tool(
    "mason_automation",
    "Inspect installed automation, observed host events, pending decision records and the notification baseline, or check all retained documentation findings across sessions. status is read-only; check saves local baselines and verification reports without editing source, approving advisories or consuming pending completion notices. Returns concise results with a full report path. Works without a map.",
    {
      dir: z.string().describe("Absolute path to the project directory"),
      action: z
        .enum(["status", "check"])
        .describe(
          "Inspect configuration and receipts, or capture/resume and verify original audit evidence.",
        ),
    },
    async ({ dir, action }) => ({
      content: [{ type: "text", text: await masonAutomation(dir, action) }],
    }),
  );

  server.tool(
    "mason_complete_init",
    "Record assistant instruction setup locally in ignored .mason/local/project.json, with feature settings in shared .mason/config.json. Other tools work without this marker. Repeated calls preserve the original setup time and existing settings.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await masonCompleteInit(dir);
      return { content: [{ type: "text", text: result }] };
    },
  );

  server.tool(
    "get_snapshot",
    "Return the optional feature-to-file architecture map with drift and trust evidence. Map verification is rechecked against sampled source contents; stale or unknown verification requires a fresh review, and recordedVerdict preserves the historical verdict. If no map exists, returns exists:false and points to decision context. Decision capture, get_context, and get_impact still work. No initialization required.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await getSnapshot(dir);
      return {
        content: [{ type: "text", text: result }],
      };
    },
  );

  server.tool(
    "get_context",
    "Assemble task context: matching decisions with rationale, approval, owner, sources, last review, and freshness, plus related tests, file impact, and any available map entries. Map verification is rechecked against sampled source contents; stale or unknown verification requires a fresh review, and recordedVerdict preserves the historical verdict. Proposals are suggestions; legacy records are unreviewed; accepted decisions are constraints subject to freshness. No initialization or map required. Pass task and optional files. map.status and diagnostics preserve missing or invalid knowledge. Impact covers up to three unique files, expanding directory anchors.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      task: z
        .string()
        .describe(
          "The task, bug, or change request in natural language — e.g. 'add rate limiting to the API client' or a ticket description",
        ),
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Optional file paths already known to be involved (e.g. from a diff or stack trace). Entries containing them are boosted above pure text matches.",
        ),
    },
    async ({ dir, task, files }) => {
      const result = await getContext(dir, task, files);
      const { observeActivation } = await import("../setup/observations.js");
      const warning = await observeActivation(dir, "context");
      if (warning)
        return {
          content: [
            { type: "text", text: result },
            { type: "text", text: warning },
          ],
        };
      return {
        content: [{ type: "text", text: result }],
      };
    },
  );

  server.tool(
    "save_snapshot",
    "Save a concept-to-files map as a persistent project snapshot. Maps feature names and data flows to the files that implement them. Retained for direct maintenance of legacy maps; the managed map-build workflow has been removed. Persists across conversations — future sessions can call get_snapshot to instantly find relevant files. No API key needed — you are the LLM generating the map.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
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
                'Classification: "capability" for user-facing functionality, "infrastructure" for internal plumbing with no end user (DI/service wiring, config, logging, adapters). Defaults to "capability".',
              ),
          }),
        )
        .describe("Map of feature names to their implementing files"),
      flows: z
        .record(
          z.object({
            description: z.string().describe("One-line description of the flow"),
            chain: z
              .array(z.string())
              .describe("Ordered list of file paths showing data/call flow"),
          }),
        )
        .describe("Map of flow names to ordered file chains"),
      removeFeatures: z
        .array(z.string())
        .optional()
        .describe(
          "Feature names to delete from the existing map — for features that were renamed or no longer exist. Applied before merging; only meaningful on incremental saves.",
        ),
      removeFlows: z
        .array(z.string())
        .optional()
        .describe(
          "Flow names to delete from the existing map. Applied before merging; only meaningful on incremental saves.",
        ),
    },
    async ({ dir, features, flows, removeFeatures, removeFlows }) => {
      const result = await saveSnapshotData(
        dir,
        features,
        flows,
        removeFeatures ?? [],
        removeFlows ?? [],
      );
      return {
        content: [{ type: "text", text: result }],
      };
    },
  );

  server.tool(
    "save_decision",
    "Capture or revise a decision proposal as soon as the lesson is supported by evidence, without waiting for implementation or merge. Keep unimplemented remedies tentative. Include rationale, anchors, optional owner, sources, and a known actor. Compare matching get_context records and pending proposals before saving. When new evidence changes the same lesson's assumptions, scope, or recommended action, pass its existing id, including for accepted records. Preserve supported rationale and sources and replace obsolete instructions. Create a new record for a genuinely distinct lesson; skip unchanged restatements. No setup or map required. Writes a local record and preserves content history. Changes create a pending proposal while the last accepted revision remains operative; unchanged content does not re-verify or refresh it. Use review_decision for authorized acceptance or reaffirmation. A proposal cannot supersede a record with an operative accepted revision; review its replacement and retire the original separately.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      title: decisionTitleSchema.describe(
        `Short, specific headline (max ${TITLE_MAX_CHARS} characters). Generates a stable id on creation; revising the title keeps the existing id.`,
      ),
      body: decisionBodySchema.describe(
        `The knowledge itself: what was tried/decided, why, and what to avoid. Must contain information NOT derivable by reading the code. Aim for ${BODY_RECOMMENDED_CHARS} characters or fewer; up to ${BODY_MAX_CHARS} is accepted with a warning above the target. Matching context and hooks include the full body. Preserve exceptions; use sources for supporting references.`,
      ),
      category: z.enum(["decision", "gotcha", "deprecation", "convention"]),
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Repo-relative files or directory prefixes this applies to. Matching is shared by retrieval, hooks, review, and drift checking; changes flag the decision for re-verification.",
        ),
      id: z
        .string()
        .optional()
        .describe(
          "Pass the matching record's existing id when evidence changes that lesson's assumptions, scope, or recommended action, including for accepted records. Changed content becomes a proposal while the accepted version remains operative; unchanged content leaves review and freshness untouched.",
        ),
      supersedes: z
        .string()
        .optional()
        .describe(
          "Id of an unreviewed record or proposal with no accepted revision to replace. Operative accepted decisions require separate review and retirement.",
        ),
      owner: attributionSchema.shape.owner.describe(
        "Responsible person or team, when known. Null clears it. Required for acceptance.",
      ),
      sources: attributionSchema.shape.sources.describe(
        "Known PR, issue, incident, discussion, or document references. Omit to preserve; [] clears. At least one is required for acceptance.",
      ),
      actor: attributionSchema.shape.actor.describe(
        "Known person or agent recording this revision. Omit if unknown; do not infer from Git identity.",
      ),
      force: z.boolean().optional().describe("Save even when a near-duplicate was detected"),
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
    },
  );

  server.tool(
    "review_decision",
    "Prepare a decision review: returns the full record and history, any operative accepted revision, provenance, changes and previews for both sets of anchors, and a reviewToken. For accepted-guidance inspection use inspectionScope operative on both prepare and inspect; pending proposals remain unassessed. Default all scope covers both revisions. After source inspection, record inspect with inspector, note and token to report no contradiction found without human acceptance. For human review, prepare with all scope, then record accept, reaffirm, or retire with its token, the authorized reviewer, and a reason. Acceptance replaces the operative revision; retirement withdraws the entire record including its proposal. Acceptance requires owner, source, readable Git HEAD, and committed anchor changes. Changed records or code invalidate the token. Identities and approvals are recorded assertions for normal PR review, not authenticated proof.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      id: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Decision id from get_context or save_decision"),
      action: z
        .enum(["prepare", "inspect", "accept", "reaffirm", "retire"])
        .optional()
        .default("prepare")
        .describe(
          "Prepare is read-only. Inspect records an agent assessment without approval; accept, reaffirm and retire require an authorized review.",
        ),
      inspectionScope: z
        .enum(["all", "operative"])
        .optional()
        .default("all")
        .describe(
          "For prepare/inspect only: all covers the full record and both anchor sets (default); operative covers only an active accepted revision, leaving a pending draft unassessed. Use the same scope when submitting its token.",
        ),
      inspector: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Actual agent or person performing inspection; required for inspect. Does not claim human approval.",
        ),
      reviewer: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Identity of the actual reviewer; required for a verdict. Never invent one."),
      note: z
        .string()
        .trim()
        .min(1)
        .max(1500)
        .optional()
        .describe("Review rationale; required for a verdict. Cite evidence for the decision."),
      reviewToken: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe("Token from the prepared review; rejects stale record or code revisions"),
    },
    async ({ dir, ...input }) => {
      const result = await reviewDecision(dir, input);
      return { content: [{ type: "text", text: result }] };
    },
  );

  server.tool(
    "mason_check_drift",
    "Check how far the concept map has drifted from HEAD. Deterministic (git + filesystem, no LLM). Returns which features/flows are stale and the changed files behind them, new source files not yet mapped, ghost files (mapped but deleted), renames, and a `recommendation`: `up-to-date` (nothing to do), `incremental` (update just the stale entries via save_snapshot), or `full-rebuild` (broad source review required). Call this before trusting the map in a long session, or when maintaining an existing map.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await checkDrift(dir);
      return {
        content: [{ type: "text", text: result }],
      };
    },
  );

  server.tool(
    "verify_snapshot",
    "Spot-check the concept map's CORRECTNESS (drift checks freshness; this checks entries were right to begin with). Returns a sample of entries — always the never-verified and least-recently-verified first — with skeletons of their claimed files, for you to judge whether the files actually implement what the entry claims. Report verdicts back via save_verification with each entry’s kind and reviewToken. Tokens bind the entry and bounded source evidence; changed evidence requires a fresh review. Run periodically, or after an automated refresh wrote entries no human reviewed.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      sample: z.number().int().optional().describe("Entries to sample (default 5)"),
    },
    async ({ dir, sample }) => {
      const result = await verifySnapshot(dir, sample);
      return { content: [{ type: "text", text: result }] };
    },
  );

  server.tool(
    "save_verification",
    "Record verify_snapshot verdicts using each entry’s kind and reviewToken. Missing tokens request a fresh review; changed or deleted entries return conflicts without being stamped. Entries judged ok are stamped verifiedAt; failures are flagged verificationFailed with your note and surface in get_context, get_snapshot, and mason_check_drift until corrected. Verdict notes are required for failures.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      verdicts: z
        .record(
          z.object({
            kind: z
              .enum(["feature", "flow"])
              .optional()
              .describe("Entry kind returned by verify_snapshot; required to record a verdict"),
            reviewToken: z
              .string()
              .optional()
              .describe(
                "Copy the reviewToken from verify_snapshot after inspecting its evidence; required to record a verdict",
              ),
            ok: z.boolean(),
            note: z
              .string()
              .optional()
              .describe("One line on what's wrong — required when ok is false"),
          }),
        )
        .describe("Entry name → verdict, exactly as returned by verify_snapshot"),
    },
    async ({ dir, verdicts }) => {
      const result = await saveVerification(dir, verdicts);
      return { content: [{ type: "text", text: result }] };
    },
  );

  server.tool(
    "get_impact",
    "Trace historical co-change partners, related tests, and references with evidence: resolved imports, explicit paths, or uncertain name candidates. Candidates are not proven dependencies. Deterministic and read-only; no initialization or concept map required.",
    {
      dir: z.string().describe("Absolute path to the project root directory"),
      files: z
        .array(z.string())
        .describe(
          "File paths or names to analyze (e.g., ['WeatherRepository.kt'] or ['src/services/auth.ts'])",
        ),
    },
    async ({ dir, files }) => {
      const result = await getImpact(dir, files);
      return {
        content: [{ type: "text", text: result }],
      };
    },
  );

  return server;
}

export async function startMcpServer(onClose?: () => void): Promise<void> {
  const server = createMcpServer();
  if (onClose) server.server.onclose = onClose;
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
