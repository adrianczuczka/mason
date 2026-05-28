import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeProject,
  fullAnalysis,
  generateSnapshotBatch,
  getCodeSamples,
  getImpact,
  getSnapshot,
  masonCompleteInit,
  masonInit,
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
        "Mason is a context engineering tool. Start every project with `mason_init` for the project directory. If it returns `initialized: false`, follow the included `playbook` to walk the user through one-time setup. Setup is a Map-Reduce loop: repeatedly call `generate_snapshot_batch` + `save_partial_snapshot` until every batch is processed, then `reduce_snapshot` to produce the unified map, then `save_snapshot`, then `mason_complete_init`. Once initialized, `get_snapshot` returns the feature-to-file map and `get_impact` shows what other files an edit affects. `full_analysis`, `analyze_project`, and `get_code_samples` are read-only diagnostics and never need init. Mason has no CLI; everything happens through these tools.",
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
    "Mark the project as initialized. Call this after walking the user through the playbook returned by `mason_init`. Writes `.mason/project.json` so future tool calls don't re-run the wizard.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await masonCompleteInit(dir);
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "full_analysis",
    "Run a complete project analysis in one call. Returns git history stats, project structure with file counts, curated code sample previews (~60 lines each), and test-to-source file mapping. This is the recommended starting point — call this first, then read specific files natively for full content.",
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
    "Get the project's concept map — a lookup table from features and flows to the files that implement them. Use this to jump straight to relevant files instead of exploring. Example: 'home screen' → [HomeScreen.kt, HomeViewModel.kt, HomeModule.kt]. If exists:false, call generate_snapshot to build one. When stale, returns the existing map plus a `diff` of changed files + previews so an incremental save_snapshot call covers the update.",
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
    },
    async ({ dir, offset, batchSize }) => {
      const result = await generateSnapshotBatch(dir, offset, batchSize);
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
    },
    async ({ dir, features, flows }) => {
      const result = await saveSnapshotData(dir, features, flows);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "get_impact",
    "Analyze the impact of changing specific files. Returns three signals: git co-change (files that historically change together), references (files that mention the target by name), and related tests. Use this before editing a file to understand what else might need updating.",
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

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
