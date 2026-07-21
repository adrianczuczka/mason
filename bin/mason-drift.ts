import { runDriftCli } from "../src/drift/cli.js";

runDriftCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`mason-drift error: ${err}\n`);
    process.exit(2);
  }
);
