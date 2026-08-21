import { runAuditCli } from "../src/audit/cli.js";

runAuditCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`mason-audit error: ${err}\n`);
    process.exit(2);
  }
);
