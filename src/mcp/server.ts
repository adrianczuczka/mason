import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeProject,
  fullAnalysis,
  getCodeSamples,
  getFileContent,
  getProjectStructure,
  getSnapshot,
  getTestMap,
  saveSnapshotData,
  writeClaudeMd,
} from "./tools.js";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "mason",
      version: "0.1.0",
    },
    {
      instructions:
        "Mason is a context engineering tool that helps you understand codebases efficiently. Recommended workflow: 1) Call get_snapshot first — if a snapshot exists, you already have file summaries and can skip re-reading most files. 2) If no snapshot, call full_analysis for git stats, project structure, code samples, and test map. 3) Call get_file_content to read specific files in full. 4) Call save_snapshot to persist your understanding for future sessions (saves thousands of tokens next time). 5) Call write_claude_md to save the final output. Individual tools (analyze_project, get_code_samples, get_project_structure, get_test_map) are also available for targeted queries.",
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
    "Get the persistent project snapshot — LLM-generated summaries of key files including their purpose, role, and dependencies. The snapshot saves thousands of tokens by letting you understand the codebase without reading every file. If the snapshot is stale (files changed since last update), it tells you which files need re-reading — use get_file_content on those, then call save_snapshot to update.",
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
    "Save file summaries as a persistent project snapshot. Call this after reading code samples from get_code_samples or full_analysis — summarize each file's purpose, role, and dependencies, then save them here. The snapshot persists across conversations, so future sessions can call get_snapshot to understand the codebase without re-reading files. No API key needed — you are the LLM generating the summaries.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      files: z
        .array(
          z.object({
            path: z.string().describe("Relative file path"),
            summary: z
              .string()
              .describe(
                "One-line summary: what the file does, key patterns, libraries used"
              ),
            role: z
              .string()
              .describe(
                "Architectural role: viewmodel, repository, service, config, test, etc."
              ),
            dependencies: z
              .array(z.string())
              .optional()
              .describe("File names this file depends on"),
          })
        )
        .describe("Array of file summaries to save"),
    },
    async ({ dir, files }) => {
      const result = await saveSnapshotData(dir, files);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  server.tool(
    "write_claude_md",
    "Write a CLAUDE.md file to a project directory. Use this after analyzing the project and generating rules.",
    {
      dir: z
        .string()
        .describe("Absolute path to the project root directory"),
      content: z
        .string()
        .describe("The full markdown content to write to CLAUDE.md"),
    },
    async ({ dir, content }) => {
      const result = await writeClaudeMd(dir, content);
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
