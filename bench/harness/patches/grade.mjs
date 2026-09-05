import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkIntegrity, readCheckout, writeFiles } from "./fixture.mjs";

const exec = promisify(execFile);

async function runNode(args, cwd, timeout) {
  try {
    const result = await exec(process.execPath, args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message), timedOut: !!error.killed };
  }
}

/** Held-out assertions are installed only after the session ends, in a fresh copy. */
export async function gradePatch(task, fixture, { timeoutMs = 10000 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mason-patch-grade-"));
  try {
    let integrity;
    try { integrity = await checkIntegrity(fixture); }
    catch (error) { return { passed: false, integrity: [error.message], checks: [], publicTests: null }; }
    const repo = path.join(directory, "patch");
    await fs.mkdir(repo);
    const files = await readCheckout(fixture.repo);
    await writeFiles(repo, files);
    const runner = `import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const mod = file => import(pathToFileURL(path.join(process.argv[2],file)).href);
const results=[];
${task.checks.map(c => `try { await (async()=>{${c.code}})(); results.push({id:${JSON.stringify(c.id)},kind:${JSON.stringify(c.kind)},passed:true}); } catch(error) { results.push({id:${JSON.stringify(c.id)},kind:${JSON.stringify(c.kind)},passed:false,error:String(error.message).slice(0,1500)}); }`).join("\n")}
console.log('MASON_GRADE='+JSON.stringify(results));
`;
    const gradeFile = path.join(directory, "grade.mjs");
    await fs.writeFile(gradeFile, runner);
    const publicPaths = Object.keys(files).filter(f => f.startsWith("test/") && /\.test\.m?js$/.test(f));
    const publicResult = await runNode(["--test", ...publicPaths], repo, timeoutMs);
    const result = await runNode([gradeFile, repo], repo, timeoutMs);
    let checks;
    try {
      const line = result.stdout.split("\n").findLast(l => l.startsWith("MASON_GRADE="));
      checks = JSON.parse(line.slice("MASON_GRADE=".length));
      if (!result.ok || checks.length !== task.checks.length || checks.some((c, i) => c.id !== task.checks[i].id || typeof c.passed !== "boolean")) throw new Error("Incomplete grade");
    } catch {
      checks = task.checks.map(c => ({ id: c.id, kind: c.kind, passed: false, error: result.timedOut ? "Grader timed out" : "Patch could not complete held-out checks" }));
    }
    return { passed: integrity.length === 0 && publicResult.ok && checks.every(c => c.passed), integrity, checks,
      publicTests: { passed: publicResult.ok, output: (publicResult.stdout + publicResult.stderr).slice(-8000) },
      execution: { timedOut: result.timedOut ?? false, stderr: result.stderr.slice(-2000) } };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
