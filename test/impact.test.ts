import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeImpact } from "../src/impact/impact.js";
import { getContext } from "../src/mcp/tools.js";

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

  it("keeps unresolved Python module names as candidates rather than claiming resolution", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "billing.py"), "def invoice():\n    pass\n");
    await fs.writeFile(
      path.join(tmpDir, "src", "app.py"),
      "from billing import invoice\ninvoice()\n"
    );

    const result = await analyzeImpact(tmpDir, ["src/billing.py"]);
    const app = result.references.find((r) => r.file === "src/app.py");
    expect(app).toMatchObject({ kind: "mention", evidence: "name-candidate" });
  });

  const write = async (root: string, file: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  };

  it("drops Kotlin name collisions for assistant config and dotfiles while retaining explicit paths", async () => {
    for (const file of [".claude/settings.json", ".claude/CLAUDE.md", ".gitignore"]) await write(tmpDir, file, "{}\n");
    await write(tmpDir, "src/Preferences.kt", "import com.example.settings.Preferences\nimport com.example.models.CLAUDE\n");
    await write(tmpDir, "src/inspect.ts", "// Read .claude/CLAUDE.md and .gitignore for project instructions\n");
    const result = await analyzeImpact(tmpDir, [".claude/settings.json", ".claude/CLAUDE.md", ".gitignore"]);
    expect(result.references).toEqual([{ file: "src/inspect.ts", matches: [".claude/CLAUDE.md", ".gitignore"], kind: "mention", evidence: "explicit-path" }]);
  });

  it("resolves real JSON imports and full paths without matching suffix collisions", async () => {
    await write(tmpDir, ".claude/settings.json", "{}\n");
    await write(tmpDir, "src/config.ts", "import settings from '../.claude/settings.json';\n");
    await write(tmpDir, "src/notes.ts", "// archive/.claude/settings.json.bak is different\n");
    expect((await analyzeImpact(tmpDir, [".claude/settings.json"])).references).toEqual([
      { file: "src/config.ts", matches: [".claude/settings.json"], kind: "import", evidence: "resolved-import" },
    ]);
  });

  it("resolves the full import path when two modules share a basename", async () => {
    await write(tmpDir, "src/one/auth.ts", "export const auth = 1;\n");
    await write(tmpDir, "src/two/auth.ts", "export const auth = 2;\n");
    await write(tmpDir, "src/consumer.ts", "import { auth } from './two/auth.js';\n");
    expect((await analyzeImpact(tmpDir, ["src/one/auth.ts"])).references).toEqual([]);
    expect((await analyzeImpact(tmpDir, ["src/two/auth.ts"])).references[0]).toMatchObject({ file: "src/consumer.ts", kind: "import" });
  });

  it("does not resolve ambiguous extensionless imports", async () => {
    await write(tmpDir, "src/auth.ts", "export const auth = 1;\n");
    await write(tmpDir, "src/auth.js", "export const auth = 2;\n");
    await write(tmpDir, "src/consumer.ts", "import { auth } from './auth';\n");
    expect((await analyzeImpact(tmpDir, ["src/auth.ts"])).references).toEqual([]);
  });

  it("supports multiline re-exports, literal require, and directory modules", async () => {
    await write(tmpDir, "src/auth/index.ts", "export const auth = 1;\n");
    await write(tmpDir, "src/export.ts", "export {\n auth\n} from './auth';\n");
    await write(tmpDir, "src/load.cjs", "const auth = require('./auth');\n");
    expect((await analyzeImpact(tmpDir, ["src/auth/index.ts"])).references.map(r => r.kind)).toEqual(["import", "import"]);
  });

  it("never upgrades comments, strings, package aliases, or dynamic expressions to resolved imports", async () => {
    await write(tmpDir, "src/auth.ts", "export const auth = 1;\n");
    await write(tmpDir, "src/comment.ts", "/* import auth from './auth'; */\n// require('./auth')\n");
    await write(tmpDir, "src/string.ts", 'const text = "import auth from \'./auth\'";\n');
    await write(tmpDir, "src/alias.ts", "import { auth } from '@other/auth';\n");
    await write(tmpDir, "src/dynamic.ts", "const moduleName = './auth';\nconst auth = import(moduleName);\n");
    const result = await analyzeImpact(tmpDir, ["src/auth.ts"]);
    expect(result.references).toHaveLength(4);
    expect(result.references.every(r => r.kind === "mention" && r.evidence === "name-candidate")).toBe(true);
    const context = JSON.parse(await getContext(tmpDir, "Investigate auth", ["src/auth.ts"]));
    expect(context.impact.references).toEqual([]);
  });

  it("does not promote a second target's candidate merely because the file imports the first", async () => {
    await write(tmpDir, "src/auth.ts", "export const auth = 1;\n");
    await write(tmpDir, "src/billing.ts", "export const invoice = 1;\n");
    await write(tmpDir, "src/consumer.ts", "import { auth } from './auth';\n// billing may be discussed later\n");
    const result = await analyzeImpact(tmpDir, ["src/auth.ts", "src/billing.ts"]);
    expect(result.references).toEqual([
      { file: 'src/consumer.ts', matches: ['src/auth.ts'], kind: 'import', evidence: 'resolved-import' },
      { file: 'src/consumer.ts', matches: ['billing'], kind: 'mention', evidence: 'name-candidate' },
    ]);
    const context = JSON.parse(await getContext(tmpDir, "Change both", ['src/auth.ts', 'src/billing.ts']));
    expect(context.impact.references).toHaveLength(1);
    expect(context.impact.references[0].matches).toEqual(['src/auth.ts']);
  });

  it("matches Kotlin/Java declared package symbols instead of unrelated same-name imports", async () => {
    await write(tmpDir, 'src/account/Settings.kt', 'package com.example.account\nclass Settings\n');
    await write(tmpDir, 'src/ui/Settings.kt', 'package com.example.ui\nclass Settings\n');
    await write(tmpDir, 'src/Correct.kt', 'import com.example.account.Settings as AccountSettings\n');
    await write(tmpDir, 'src/Other.java', 'import com.example.ui.Settings;\n');
    const result = await analyzeImpact(tmpDir, ['src/account/Settings.kt']);
    expect(result.references).toEqual([{ file: 'src/Correct.kt', matches: ['src/account/Settings.kt'], kind: 'import', evidence: 'resolved-import' }]);
  });

  it("keeps nested template text from becoming a resolved dependency", async () => {
    await write(tmpDir, 'src/auth.ts', 'export const auth = 1;\n');
    await write(tmpDir, 'src/template.ts', "const sample = `outer ${`import auth from './auth'`}`;\n");
    expect((await analyzeImpact(tmpDir, ['src/auth.ts'])).references[0]).toMatchObject({ kind: 'mention', evidence: 'name-candidate' });
    await write(tmpDir, 'src/template.ts', "const sample = `outer ${`import fake from './fake'`}`;\nconst auth = require('./auth');\n");
    expect((await analyzeImpact(tmpDir, ['src/auth.ts'])).references[0]).toMatchObject({ kind: 'import', evidence: 'resolved-import' });
  });
});
