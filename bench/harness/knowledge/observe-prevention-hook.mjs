// Observe the existing lifecycle hook without changing its output.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [binary, receipt, ...args] = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
const request = JSON.parse(input);
const witness = () => Object.fromEntries(['app.json', 'keep.pro', 'greeting.txt'].map(file => {
  const target = path.join(process.cwd(), file);
  const stat = fs.lstatSync(target);
  return [file, stat.isFile() && !stat.isSymbolicLink() ? createHash('sha256').update(fs.readFileSync(target)).digest('hex') : null];
}));
const before = witness(), startedAt = new Date().toISOString();
const result = spawnSync(process.execPath, [binary, 'auto', ...args], { input, encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024 });
let output = null;
try { output = JSON.parse(result.stdout); } catch { /* quiet hook */ }
fs.appendFileSync(receipt, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), event: request.hook_event_name,
  tool: request.tool_name, toolId: request.tool_use_id, toolInput: request.tool_input, before, after: witness(),
  code: result.status, error: result.error?.message ?? null, output }) + '\n');
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
