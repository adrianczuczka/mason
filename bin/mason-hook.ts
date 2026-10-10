import { runHookCli } from "../src/hook/cli.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (typeof value === "string" || value instanceof Uint8Array) chunks.push(Buffer.from(value));
    else throw new Error("Unsupported stdin chunk.");
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const argv = process.argv.slice(2);
const informational = argv.some((arg) => ["--help", "-h", "--print-config"].includes(arg));

(informational ? Promise.resolve("") : readStdin())
  .then((stdinText) => runHookCli(argv, stdinText))
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
