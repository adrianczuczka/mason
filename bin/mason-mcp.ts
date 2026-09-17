import { startMcpServer } from "../src/mcp/server.js";
import { startMcpWithUpdates } from "../src/distribution/updates.js";

startMcpWithUpdates(startMcpServer).catch((err) => {
  process.stderr.write(`Mason MCP server error: ${err}\n`);
  process.exit(1);
});
