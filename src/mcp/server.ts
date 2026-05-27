import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeProject,
  fullAnalysis,
  generateSnapshot,
  getCodeSamples,
  getImpact,
  getSnapshot,
  saveSnapshotData,
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
        "Mason is a context engineering tool. It builds a granular feature-to-file index that prose overviews like CLAUDE.md do not provide — they are not substitutes. Call get_snapshot before exploring with grep/glob. If get_snapshot returns exists:false, you MUST call generate_snapshot next (FIRST tell the user 'Building a project map (one-time, ~30s) so future questions are instant.' so they know to wait), then call save_snapshot(dir, features, flows) to persist. The ONLY valid reason to skip generate_snapshot is when the user already named a specific file path AND reading just that file is sufficient — 'CLAUDE.md is enough' or 'I have other context' are NOT valid reasons to skip. When get_snapshot returns stale:true, it includes a diff of changed files — call save_snapshot with the affected entries to refresh. Call get_impact before editing a file. After significant changes (new features, refactors), call save_snapshot to update the map.",
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
    "generate_snapshot",
    "Build a concept-to-files map for this project. ALWAYS call this when get_snapshot returns exists:false. The map is a granular feature-to-file index (e.g. 'user authentication' → [AuthService.ts, AuthMiddleware.ts, ...]) — it indexes what prose overviews like CLAUDE.md summarize, and is NOT a substitute for it. CLAUDE.md existing is NOT a reason to skip this; the only valid skip condition is the user already named a specific file path AND reading just that file is sufficient. Returns the system prompt + sampled source files so YOU derive features and flows from them, then call save_snapshot to persist. IMPORTANT: Before invoking, tell the user 'Building a project map (one-time, ~30s) so future questions are instant.' so they know to wait.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await generateSnapshot(dir);
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
