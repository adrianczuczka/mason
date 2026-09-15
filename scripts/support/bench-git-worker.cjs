const { spawn } = require('node:child_process');
setTimeout(() => {
  const child = spawn(process.env.MASON_BENCH_REAL_GIT, process.argv.slice(2), { stdio: 'inherit', windowsHide: true });
  child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}, Number(process.env.MASON_BENCH_GIT_DELAY_MS || 0));
