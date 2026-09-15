// Benchmark-only preload. Records command families and durations, never arguments or output.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { syncBuiltinESMExports } = require('node:module');
const original = cp.execFile;
const known = new Set(['ls-files', 'check-ignore', 'log', 'rev-parse', 'status', 'diff', 'symbolic-ref', 'for-each-ref', 'merge-base', 'ls-tree', 'show']);
if (process.env.MASON_BENCH_GIT_LOG) {
  cp.execFile = function(file, args, options, callback) {
    if (file !== 'git') return original.apply(this, arguments);
    if (typeof options === 'function') { callback = options; options = {}; }
    const started = performance.now();
    const command = args.find(arg => !arg.startsWith('-'));
    const inventory = command === 'ls-files' && args.includes('--cached') && args.includes('--others');
    const delay = (process.env.MASON_BENCH_GIT_DELAY_COMMAND === 'inventory' && !inventory) ? 0
      : Number(process.env.MASON_BENCH_GIT_DELAY_MS || 0);
    // The worker preserves asynchronous subprocess waiting. It adds Node startup
    // overhead too, so delayed samples are a stress scenario, not native latency.
    const child = delay ? original(process.execPath, [path.join(__dirname, 'bench-git-worker.cjs'), ...args], options, callback)
      : original(file, args, options, callback);
    child.once('close', code => {
      fs.appendFileSync(process.env.MASON_BENCH_GIT_LOG, JSON.stringify({
        command: known.has(command) ? command : 'other', inventory, ms: performance.now() - started, code,
      }) + '\n');
    });
    return child;
  };
  cp.execFile[promisify.custom] = (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = cp.execFile(...args, (error, stdout, stderr) => {
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve({ stdout, stderr });
      });
    });
    promise.child = child;
    return promise;
  };
  syncBuiltinESMExports();
}
