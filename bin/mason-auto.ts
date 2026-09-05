import { runAutomationCli } from "../src/automation/cli.js";

const argv = process.argv.slice(2);
let input = "";
if (argv.includes("hook") && !argv.some(a => a === "--help" || a === "-h") && !process.stdin.isTTY) {
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 1024 * 1024) break;
  }
}
process.exitCode = await runAutomationCli(argv, input);
