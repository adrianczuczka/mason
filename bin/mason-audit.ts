import { runAuditCli } from "../src/audit/cli.js";

runAuditCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`mason-audit error: ${err}\n`);
    process.exitCode = 2;
  }
);
