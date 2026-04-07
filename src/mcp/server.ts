import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeProject,
  fullAnalysis,
  getCodeSamples,
  getFileContent,
  getProjectStructure,
  getTestMap,
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
        "Mason is a context engineering tool that helps you understand codebases efficiently. It handles aggregation and file selection so you can focus on interpretation. Recommended workflow: 1) Call full_analysis to get everything in one shot — git stats, project structure, code samples, and test map. 2) Call get_file_content for any files you want to read in full. 3) Use your intelligence to identify conventions, patterns, and architecture. 4) Call write_claude_md to save the result. Individual tools (analyze_project, get_code_samples, get_project_structure, get_test_map) are also available if you need to drill into a specific area.",
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
