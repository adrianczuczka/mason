import fs from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initialState, transition, operations } from './publish-model.mjs';

const [seedPath, receipt] = process.argv.slice(2);
const { release, scenario } = JSON.parse(await fs.readFile(seedPath, 'utf8'));
const state = initialState(scenario, release);
const descriptions = {
  inspect_edit: 'Read the status and uploaded bundle identity of a publishing edit.',
  create_edit: 'Create an empty publishing edit for the configured application.',
  upload_bundle: 'Upload the fixed release artifact to an active empty edit. Returns version and SHA-256. No build or version changes.',
  attach_mapping: 'Attach the fixed release mapping to the uploaded bundle in an active edit.',
  finish_edit: 'Finish an active edit with its uploaded bundle and mapping. This is a local simulation, not a real release.',
};
const server = new Server({ name: 'publishing-simulator', version: '1' }, { capabilities: { tools: {} }, instructions: 'Local publishing protocol simulator for this disposable fixture. No real account, network, or release is involved.' });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: operations.map(name => ({ name, description: descriptions[name],
  inputSchema: { type: 'object', properties: name === 'create_edit' ? {} : { editId: { type: 'string' } }, required: name === 'create_edit' ? [] : ['editId'], additionalProperties: false },
})) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name, args = request.params.arguments ?? {};
  const response = transition(state, name, args, release);
  await fs.appendFile(receipt, JSON.stringify({ at: new Date().toISOString(), event: 'publish-result', name, args, response }) + '\n');
  return { content: [{ type: 'text', text: JSON.stringify(response) }], ...(response.error ? { isError: true } : {}) };
});
await server.connect(new StdioServerTransport());
