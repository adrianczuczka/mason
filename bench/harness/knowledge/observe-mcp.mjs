// Transparent protocol observer; only synthetic fixture calls are retained.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { withMason } from './mcp.mjs';

const [binary, root, receipt, witnessJson = '[]'] = process.argv.slice(2);
const witnessFiles = JSON.parse(witnessJson);
if (!Array.isArray(witnessFiles) || witnessFiles.some(f => typeof f !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(f) || f === '..')) throw new Error('Invalid witness paths');
async function witness() {
  if (!witnessFiles.length) return {};
  const entries = await Promise.all(witnessFiles.map(async file => {
    const target = path.join(root, file), stat = await fs.lstat(target).catch(() => null);
    return [file, stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 65536
      ? createHash('sha256').update(await fs.readFile(target)).digest('hex') : null];
  }));
  return { witness: Object.fromEntries(entries) };
}
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
    await record({ event: 'result', name, result, worktrees, ...await witness() });
    return result;
  });
  await server.connect(new StdioServerTransport());
  await new Promise(resolve => process.stdin.once('end', resolve));
  await server.close();
});
