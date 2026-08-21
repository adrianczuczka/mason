import { runHookCli } from "../src/hook/cli.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

readStdin()
  .then((stdinText) => runHookCli(process.argv.slice(2), stdinText))
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
