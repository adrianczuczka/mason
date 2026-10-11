import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { git, write, records, digest } from "./fixture.mjs";
import { withMason, call } from "./mcp.mjs";
import { auto, quote } from "../automation/fixture.mjs";
import { knowledgePreserved } from "./prevention-fixture.mjs";
export const cases = ["pending", "accepted", "retired", "unrelated"];
export const arms = ["mason", "notes"];
export const acceptedBody =
  "A queue operation that registers an abort listener must release its subscription after normal completion and work failure, as well as cancellation. Once-only registration removes a listener only when abort fires; successful repeated operations on a long-lived signal otherwise accumulate listeners. Preserve results, original work errors and AbortError cancellation. This applies to the custom operation path, not an instruction to override a verified helper that owns disposal. Source: Node correction aa1eb1fd597f68c6cb67c2a4d631a8d66f2cb94e; this project is a constructed transfer.";
export const pendingBody =
  "Proposed simplification: once-only abort listeners are sufficient, so normal-completion cleanup can be removed. This proposal is unreviewed and has not replaced the accepted cleanup requirement.";
export const migratedBody =
  "Current queue ownership uses managedRace from managed.mjs for each operation. That helper owns cancellation listener disposal on settlement; the caller delegates instead of adding its own subscription. Preserve original results/errors and AbortError cancellation. The former caller-specific manual-cleanup instruction is historical. Disposal remains necessary inside the helper. Evidence: pinned Node correction and the constructed helper validation, not an upstream endorsement of this project.";
export const prompts = {
  pending:
    "Implement cancellation support for runOperation as required by requirements.md. Preserve work results and errors. Leave changes uncommitted.",
  accepted:
    "Implement runOperation under the current queue ownership requirements in requirements.md. Preserve work results and errors. Leave changes uncommitted.",
  retired:
    "Implement runOperation under the current queue ownership requirements in requirements.md. Preserve work results and errors. Leave changes uncommitted.",
  unrelated:
    "Change the greeting from hello to welcome. Keep everything else as it is and leave changes uncommitted.",
};
// Static fixture source: serializing a transformed test function leaks runner-specific imports.
const engineSource = `function makeOperation(mode) {
  return (signal, work) => {
    if (signal?.aborted) return Promise.reject(aborted());
    let onAbort, subscription;
    const pending = new Promise((resolve, reject) => {
      onAbort = () => reject(aborted());
      if (signal) {
        if (mode === 'managed-dispose') subscription = addAbortListener(signal, onAbort);
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve().then(work).then(resolve, reject);
    });
    if (mode === 'once-only') return pending;
    return pending.finally(() => {
      if (subscription) subscription[Symbol.dispose]();
      else signal?.removeEventListener('abort', onAbort);
    });
  };
}\n`;
const prefix =
  "import { addAbortListener } from 'node:events';\nconst aborted = () => Object.assign(new Error('Operation aborted'), { name: 'AbortError' });\n";
const functionSource =
  prefix +
  engineSource +
  "const operation = makeOperation('managed-dispose');\nexport let calls = 0;\nexport function managedRace(signal, work) { calls++; return operation(signal, work); }\n";
export const referenceSource = (mode) =>
  prefix + engineSource + `export const runOperation = makeOperation(${JSON.stringify(mode)});\n`;
export const delegatedSource =
  "import { managedRace } from './managed.mjs';\nexport const runOperation = (signal, work) => managedRace(signal, work);\n";
export async function template(root, scenario, mcp) {
  if (!cases.includes(scenario)) throw new Error("Unknown scenario");
  await fs.mkdir(root, { recursive: false });
  await write(root, ".gitignore", ".mason/local/\n.mason/reports/\n");
  await write(
    root,
    "operation.mjs",
    "export const runOperation = (_signal, work) => Promise.resolve().then(work);\n",
  );
  await write(root, "managed.mjs", functionSource);
  await write(root, "greeting.txt", "hello\n");
  await write(
    root,
    "incident.md",
    "# Source evidence\nNode #35990 reports listeners retained after successful operations even with once-only registration. Correction aa1eb1fd597f68c6cb67c2a4d631a8d66f2cb94e removes listeners when awaitable timers settle, and checks normal completion for both timer variants. Parent: 1a6d4dce6db09cb58cb77714cdcb28d84a7c7073.\nhttps://github.com/nodejs/node/commit/aa1eb1fd597f68c6cb67c2a4d631a8d66f2cb94e\nThis queue is a constructed transfer, not historical Node code. Fixture team ownership and reviews are synthetic.\n",
  );
  await write(
    root,
    "ownership.md",
    "The custom operation path originally owned its own cancellation subscription. The provided managed helper owns disposal internally; this is a constructed, validated fixture alternative. Deployment evidence is local Node v25.9.0, not a runtime matrix.\n",
  );
  await write(
    root,
    "requirements.md",
    "The queue calls runOperation(signal, work), where work is a function producing a value or promise. Cancellation must reject with AbortError while pending. A previously aborted signal must prevent work from starting. Without a signal, ordinary work succeeds. Preserve original work errors and result values. Cancellation stops waiting, not arbitrary work side effects.\n",
  );
  await write(
    root,
    "check.mjs",
    "import assert from 'node:assert/strict';\nimport { runOperation } from './operation.mjs';\nassert.equal(await runOperation(undefined, () => 42), 42);\nconst error = new Error('work');\nawait assert.rejects(runOperation(undefined, () => { throw error; }), e => e === error);\nconsole.log('basic results and errors passed; this smoke check is not full verification');\n",
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "queue transfer fixture");
  await withMason(mcp, root, async (client) => {
    const save = async (body, id) => {
      const result = await call(client, root, "save_decision", {
        ...(id ? { id } : {}),
        title: "Queue cancellation subscription ownership",
        category: "gotcha",
        body,
        files: ["operation.mjs", "managed.mjs"],
        owner: "Constructed queue fixture team",
        sources: [
          { kind: "document", reference: "incident.md" },
          { kind: "document", reference: "ownership.md" },
        ],
      });
      if (!["created", "updated"].includes(result.status))
        throw new Error("Save failed: " + JSON.stringify(result));
      return result.id;
    };
    const review = async (id, action) => {
      const prepared = await call(client, root, "review_decision", { id, action: "prepare" });
      const result = await call(client, root, "review_decision", {
        id,
        action,
        reviewToken: prepared.reviewToken,
        reviewer: "Codex coordinating implementation reviewer (synthetic fixture only)",
        note:
          action === "retire"
            ? "Custom-path instruction withdrawn after managed ownership migration; cleanup remains a helper obligation. Not maintainer approval."
            : "Reviewed against pinned Node correction and constructed helper witnesses. Unblinded evaluator also authored fixture; not maintainer approval.",
      });
      if (result.status !== (action === "retire" ? "retired" : "accepted"))
        throw new Error("Review failed: " + JSON.stringify(result));
    };
    const id = await save(acceptedBody);
    await review(id, "accept");
    git(root, "add", ".");
    git(root, "commit", "-qm", "review cleanup guidance");
    if (scenario === "pending") {
      await save(pendingBody, id);
      git(root, "add", ".");
      git(root, "commit", "-qm", "unaccepted simplification proposal");
    }
    if (["accepted", "retired"].includes(scenario)) {
      await write(
        root,
        "requirements.md",
        (await fs.readFile(path.join(root, "requirements.md"), "utf8")) +
          "Current ownership: runOperation delegates each invocation to managedRace from managed.mjs. The caller must not install an additional cancellation subscription. The helper implements disposal; no user confirmation is required for this authorized migration.\n",
      );
      git(root, "add", ".");
      git(root, "commit", "-qm", "managed ownership requirement");
      if (scenario === "accepted") {
        await save(migratedBody, id);
        await review(id, "accept");
      } else await review(id, "retire");
      git(root, "add", ".");
      git(root, "commit", "-qm", "review current ownership guidance");
    }
  });
  return { root, scenario, knowledge: await records(root, "candidate") };
}
function notesProjection(record) {
  const lastAccepted = record.history
    .filter((h) => ["accepted", "reaffirmed"].includes(h.kind))
    .at(-1);
  const pending = record.approval === "proposed";
  const body = pending ? lastAccepted.content.body : record.body;
  return `# Reviewed project guidance\n\nRecord: ${record.id}. Status: ${record.status}. ${record.status === "active" ? "Operative accepted guidance" : "Historical accepted guidance, withdrawn and not an active constraint"}: revision ${pending ? lastAccepted.revision : record.revision}.\n\n${body}\n\n${pending ? "## Pending proposal, not accepted\n" + record.body + "\n" : ""}\nOwner: ${record.owner}. Sources: incident.md, ownership.md. Referenced code: operation.mjs, managed.mjs. Verify changed code before relying on this guidance. Exact content and complete review history are in PROJECT_NOTES_REVIEW.json. Source inspection is not approval.\n`;
}
export async function forkFixture(seed, root, arm, { binary, observer, hookLog }) {
  execFileSync("git", ["clone", "-q", "--no-local", seed.root, root], {
    timeout: 10000,
    stdio: "pipe",
  });
  const common =
    "# Queue transfer task\nRead requirements.md and applicable reviewed guidance before relevant edits. Distinguish accepted guidance, pending proposals, retired records and historical content. Inspect changed source evidence before relying on advice; empty retrieval does not establish safety. This task authorizes its requested code edit. No additional approval is needed to implement it. Never invent decision approval or edit acceptance/retirement history. Source inspection does not approve a proposal. No new lesson is required when existing guidance still applies.\nFor queue tasks edit only operation.mjs; for greeting tasks edit only greeting.txt. Do not modify the helper, requirements, source evidence, instructions, checkers, review receipts or hook configuration. Leave Git commits to the evaluator. Run node check.mjs for a basic smoke check; it is not full verification.\n";
  const retrieval =
    arm === "mason"
      ? "Use Mason get_context for the task and relevant files, then inspect any applicable source. Keep records unchanged except source inspections through review_decision when needed.\n"
      : "Read PROJECT_NOTES.md and PROJECT_NOTES_REVIEW.json for applicable accepted guidance and full proposal/revision/retirement history, then inspect any applicable source. Keep both knowledge files unchanged.\n";
  for (const name of ["AGENTS.md", "CLAUDE.md"]) await write(root, name, common + retrieval);
  if (arm === "notes") {
    await write(root, "PROJECT_NOTES.md", notesProjection(seed.knowledge[0]));
    await write(
      root,
      "PROJECT_NOTES_REVIEW.json",
      JSON.stringify(seed.knowledge[0], null, 2) + "\n",
    );
    await fs.rm(path.join(root, ".mason/decisions"), { recursive: true });
  }
  const command = [process.execPath, observer, arm, binary, hookLog].map(quote).join(" ");
  if (arm === "mason") auto(binary, root, ["install", "--host", "claude", "--command", command]);
  else
    await write(
      root,
      ".claude/settings.json",
      JSON.stringify(
        {
          hooks: Object.fromEntries(
            ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map(
              (event) => [event, [{ hooks: [{ type: "command", command, timeout: 40 }] }]],
            ),
          ),
        },
        null,
        2,
      ),
    );
  git(root, "add", ".");
  git(root, "commit", "-qm", "arm guidance and hook observation");
  const files = git(root, "ls-files", "-z").split("\0").filter(Boolean);
  return {
    arm,
    scenario: seed.scenario,
    head: git(root, "rev-parse", "HEAD"),
    files: Object.fromEntries(
      await Promise.all(files.map(async (f) => [f, await fs.readFile(path.join(root, f), "utf8")])),
    ),
    knowledge: arm === "mason" ? await records(root, "candidate") : [],
    localConfig: await fs
      .readFile(path.join(root, ".mason/local/automation.json"), "utf8")
      .catch(() => null),
  };
}
export function privateCheck(root) {
  const token = randomUUID() + ":";
  try {
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./cancellation-submission.mjs", import.meta.url)), root, token],
      { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    const line = output.split("\n").find((l) => l.startsWith(token));
    if (!line) throw new Error("Checker result missing");
    return JSON.parse(line.slice(token.length));
  } catch (e) {
    return { pass: false, failures: ["Private checker unavailable: " + e.message] };
  }
}
export async function grade(root, initial, session, mcpEvents = []) {
  const failures = [];
  if (!session.ok) failures.push("session incomplete");
  if (git(root, "rev-parse", "HEAD") !== initial.head) failures.push("HEAD changed");
  if (
    (await fs
      .readFile(path.join(root, ".mason/local/automation.json"), "utf8")
      .catch(() => null)) !== initial.localConfig
  )
    failures.push("local hook configuration changed");
  const edited = initial.scenario === "unrelated" ? "greeting.txt" : "operation.mjs";
  const files = new Set([
    ...Object.keys(initial.files),
    ...git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean),
  ]);
  for (const file of files) {
    const stat = await fs.lstat(path.join(root, file)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      failures.push("missing or unsafe file: " + file);
      continue;
    }
    if (
      file === edited ||
      (initial.arm === "mason" && /^\.mason\/decisions\/[a-z0-9_-]+\.json$/.test(file))
    )
      continue;
    if ((await fs.readFile(path.join(root, file), "utf8")) !== initial.files[file])
      failures.push("protected or unexpected change: " + file);
  }
  if (
    initial.arm === "mason" &&
    !knowledgePreserved(initial.knowledge, await records(root, "candidate"), mcpEvents)
  )
    failures.push("knowledge/review history changed without witnessed inspection");
  let behavior = null;
  if (initial.scenario === "unrelated") {
    if ((await fs.readFile(path.join(root, "greeting.txt"), "utf8")) !== "welcome\n")
      failures.push("incorrect greeting");
  } else {
    behavior = privateCheck(root);
    if (!behavior.pass) failures.push(...behavior.failures);
    if (["accepted", "retired"].includes(initial.scenario) && behavior.managedCalls !== 16)
      failures.push("current managed ownership not used for every operation");
  }
  return {
    pass: !failures.length,
    failures,
    behavior,
    semanticReview: "pending: interpretation, retrieval timing, noise and review effort",
  };
}
export async function replay(root, scenario) {
  if (scenario === "unrelated") await write(root, "greeting.txt", "welcome\n");
  else
    await write(
      root,
      "operation.mjs",
      ["accepted", "retired"].includes(scenario)
        ? delegatedSource
        : referenceSource("finally-cleanup"),
    );
}
