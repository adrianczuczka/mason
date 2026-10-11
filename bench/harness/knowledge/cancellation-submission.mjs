// Private child-process checker. Reference implementations are not copied into fixtures.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { checkOperation } from "./cancellation-check.mjs";
const [root, token] = process.argv.slice(2);
try {
  const helper = await import(pathToFileURL(path.join(root, "managed.mjs")).href);
  const { runOperation } = await import(pathToFileURL(path.join(root, "operation.mjs")).href);
  const result = await checkOperation(runOperation);
  process.stdout.write(token + JSON.stringify({ ...result, managedCalls: helper.calls }) + "\n");
} catch (error) {
  process.stdout.write(
    token + JSON.stringify({ pass: false, failures: [String(error.message)] }) + "\n",
  );
}
