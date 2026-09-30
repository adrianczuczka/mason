import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [binary, receipt, ...args] = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
const startedAt = new Date().toISOString();
const result = spawnSync(process.execPath, [binary, "auto", ...args], { input, encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024 });
let request = {}, output = null;
try { request = JSON.parse(input); } catch { /* record failed input without changing adapter behavior */ }
try { output = JSON.parse(result.stdout); } catch { /* empty output is normal */ }
const changes = spawnSync('git', ['diff', 'HEAD', '--', '.', ':!.mason'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 });
fs.appendFileSync(receipt, JSON.stringify({ startedAt, completedAt: new Date().toISOString(),
  event: request.hook_event_name, tool: request.tool_name, toolId: request.tool_use_id,
  worktreeDiff: changes.stdout ?? null, diffError: changes.error?.message ?? null,
  code: result.status, error: result.error?.message ?? null, output }) + '\n');
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
