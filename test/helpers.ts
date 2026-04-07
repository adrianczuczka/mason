import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
  return path.join(__dirname, "fixtures", name);
}
