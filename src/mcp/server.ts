import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeProject,
  fullAnalysis,
  getCodeSamples,
  getImpact,
  getSnapshot,
  saveSnapshotData,
} from "./tools.js";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "mason",
      version: "0.1.0",
    },
    {
      instructions:
        "Mason is a context engineering tool. Always call get_snapshot before using Explore agents, Glob, or Grep to understand the codebase. The snapshot is a concept map that maps features and flows to their implementing files — it eliminates the need to search. This applies to ANY question about architecture, features, flows, how things work, cross-feature interactions, or bug investigation. Workflow: 1) Call get_snapshot first. 2) If no snapshot, call full_analysis and then save_snapshot to create one. 3) If the snapshot is stale, tell the user and offer to update it. 4) Use your native file reading tool to read files the snapshot points to. 5) Before modifying a file, call get_impact to check what else might be affected. 6) After making significant changes (new features, refactors, architecture changes), call save_snapshot to update the concept map.",
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
    "Get the project's concept map — a lookup table from features and flows to the files that implement them. Use this to jump straight to relevant files instead of exploring. Example: 'home screen' → [HomeScreen.kt, HomeViewModel.kt, HomeModule.kt]. If stale, run 'mason snapshot-update' to refresh.",
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
