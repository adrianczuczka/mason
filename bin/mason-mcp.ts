import { startMcpServer } from "../src/mcp/server.js";

startMcpServer().catch((err) => {
  process.stderr.write(`Mason MCP server error: ${err}\n`);
  process.exit(1);
});
