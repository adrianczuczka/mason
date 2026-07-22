import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeImpact } from "../src/impact/impact.js";

const exec = promisify(execFile);

describe("analyzeImpact references", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mason-impact-test-"));
    await exec("git", ["init"], { cwd: tmpDir });
    await fs.mkdir(path.join(tmpDir, "src"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("classifies import-line references above bare mentions", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "auth.ts"),
      "export function auth() {}\n"
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "api.ts"),
      "import { auth } from './auth';\nexport const api = () => auth();\n"
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "docs.ts"),
      "// auth is documented elsewhere, this file never uses it\nexport const docs = 1;\n"
    );

    const result = await analyzeImpact(tmpDir, ["src/auth.ts"]);
    const byFile = Object.fromEntries(result.references.map((r) => [r.file, r.kind]));

    expect(byFile["src/api.ts"]).toBe("import");
    expect(byFile["src/docs.ts"]).toBe("mention");
    // imports sort before mentions regardless of match counts
    expect(result.references[0].file).toBe("src/api.ts");
  });

  it("python-style from-import counts as an import reference", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "billing.py"), "def invoice():\n    pass\n");
    await fs.writeFile(
      path.join(tmpDir, "src", "app.py"),
      "from billing import invoice\ninvoice()\n"
    );

    const result = await analyzeImpact(tmpDir, ["src/billing.py"]);
    const app = result.references.find((r) => r.file === "src/app.py");
    expect(app?.kind).toBe("import");
  });
});
