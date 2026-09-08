import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function withMason(binary, root, action, args = [binary]) {
  const client = new Client({ name: 'mason-knowledge-evaluation', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: root, stderr: 'pipe' });
  try { await client.connect(transport); return await action(client); }
  finally { await client.close(); }
}

export function payload(result) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
  try { return JSON.parse(text); } catch { return text; }
}

export const call = async (client, root, name, args = {}) => payload(await client.callTool({ name, arguments: { ...args, dir: root } }));
