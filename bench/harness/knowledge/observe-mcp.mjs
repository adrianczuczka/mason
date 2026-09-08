// Transparent protocol observer; only synthetic fixture calls are retained.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { withMason } from './mcp.mjs';

const [binary, root, receipt] = process.argv.slice(2);
await withMason(binary, root, async client => {
  const server = new Server(client.getServerVersion() ?? { name: 'mason', version: 'unknown' },
    { capabilities: { tools: {} }, instructions: client.getInstructions() });
  const record = event => fs.appendFile(receipt, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await client.listTools();
    await record({ event: 'tools-listed', names: result.tools.map(t => t.name) });
    return result;
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    if (await fs.realpath(path.resolve(args.dir ?? '')) !== await fs.realpath(root)) throw new Error('Evaluation tools are confined to their fixture.');
    await record({ event: 'call', name, arguments: args });
    const result = await client.callTool(request.params);
    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
    await record({ event: 'result', name, result, worktrees });
    return result;
  });
  await server.connect(new StdioServerTransport());
  await new Promise(resolve => process.stdin.once('end', resolve));
  await server.close();
});
