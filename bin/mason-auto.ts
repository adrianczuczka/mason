import { runAutomationCli, isHookCommand } from "../src/automation/cli.js";

const argv = process.argv.slice(2);
let input = "";
if (isHookCommand(argv) && !process.stdin.isTTY) {
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 1024 * 1024) break;
  }
}
process.exitCode = await runAutomationCli(argv, input);
