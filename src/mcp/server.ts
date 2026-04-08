import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeProject,
  configureProject,
  fullAnalysis,
  getCodeSamples,
  getFileContent,
  getProjectStructure,
  getSnapshot,
  getTestMap,
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
        "Mason is a context engineering tool that helps you understand codebases efficiently. Recommended workflow: 1) Call get_snapshot first — if a concept map exists, use it to jump straight to relevant files (e.g., 'home screen' maps to HomeScreen.kt, HomeViewModel.kt). 2) If no snapshot, call full_analysis for git stats, project structure, code samples, and test map. 3) Call get_file_content to read specific files in full. 4) Call save_snapshot with features (concept-to-files) and flows (data chains) to persist your understanding for future sessions. 5) Call write_claude_md to save the final output.",
    }
  );

  server.tool(
    "full_analysis",
    "Run a complete project analysis in one call. Returns git history stats, project structure with file counts, curated code sample previews (~60 lines each), and test-to-source file mapping. This is the recommended starting point — call this first, then use get_file_content to read specific files in full.",
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
    "Get previews (first ~60 lines) of representative source files from the codebase. Includes entry points, config files, hot files (frequently changed), test examples, and one file per directory for breadth. Use get_file_content to read the full content of any file that looks interesting.",
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
    "get_file_content",
    "Read the full content of a specific file. Use this after get_code_samples to drill into files you want to understand fully.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      file_path: z
        .string()
        .describe("Relative path to the file within the project (e.g., 'src/main.ts')"),
    },
    async ({ dir, file_path }) => {
      const result = await getFileContent(dir, file_path);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "get_project_structure",
    "Get the directory structure of a project with file counts and extension breakdown per directory. Shows top-level files and annotated directory listing up to 2 levels deep. Useful for understanding project layout before diving into code.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await getProjectStructure(dir);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "get_test_map",
    "Map test files to their corresponding source files by name matching. Shows which source files have tests and which don't. Useful for understanding test coverage patterns and test organization conventions.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
    },
    async ({ dir }) => {
      const result = await getTestMap(dir);
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
    "configure_project",
    "Configure Mason for this project. Add custom file patterns to sample, files to always include, or paths to ignore. Saved to .mason/config.json. Use this when the default architectural patterns miss important files in the project.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      patterns: z
        .array(z.string())
        .optional()
        .describe("Custom glob patterns for architecturally important files (e.g., '**/*Gateway.*', '**/*Bloc.*')"),
      alwaysInclude: z
        .array(z.string())
        .optional()
        .describe("Specific file paths to always include in samples (e.g., 'src/core/config.ts')"),
      ignore: z
        .array(z.string())
        .optional()
        .describe("Additional glob patterns to ignore (e.g., '**/fixtures/**')"),
    },
    async ({ dir, patterns, alwaysInclude, ignore }) => {
      const result = await configureProject(dir, {
        patterns,
        alwaysInclude,
        ignore,
      });
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
