import { runReviewCli } from "../src/review/cli.js";

runReviewCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`mason-review error: ${err}\n`);
    process.exit(2);
  }
);
