// Laboratory selector only. No production hook or project configuration imports this.
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function identity(id, decision) {
  return digest({
    id,
    revision: decision.revision,
    approval: decision.approval,
    title: decision.title,
    body: decision.body,
    files: decision.files,
    sources: decision.sources,
    trust: decision.trust,
    pendingProposal: decision.pendingProposal,
  });
}
export function select(bundle, { seen = new Set(), maxDecisions = 3, maxBytes = 6000 } = {}) {
  const heading =
    "Mason laboratory context: accepted engineering guidance matched to this task. Inspect changed or unknown evidence before relying on it. Pending proposals do not replace accepted guidance. Empty or omitted matches do not establish safety.\n";
  let context = "";
  const selected = [],
    omitted = [];
  for (const [id, decision] of Object.entries(bundle.decisions ?? {}).sort(
    (a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]),
  )) {
    const key = identity(id, decision);
    let reason =
      decision.approval !== "accepted"
        ? "not accepted"
        : seen.has(key)
          ? "already emitted equivalent content"
          : selected.length >= maxDecisions
            ? "decision limit"
            : null;
    const block =
      JSON.stringify({
        id,
        revision: decision.revision,
        approval: decision.approval,
        category: decision.category,
        title: decision.title,
        body: decision.body,
        anchors: decision.files,
        owner: decision.owner ?? "unknown",
        sources: decision.sources,
        freshness: decision.trust?.freshness ?? "unknown",
        selectionScore: decision.score,
        ...(decision.pendingProposal ? { pendingProposal: decision.pendingProposal } : {}),
      }) + "\n";
    const next = (context || heading) + block;
    if (!reason && Buffer.byteLength(next) > maxBytes) reason = "byte limit; whole record omitted";
    if (reason) {
      omitted.push({ id, score: decision.score, reason });
      continue;
    }
    context = next;
    selected.push({ id, score: decision.score, revision: decision.revision, identity: key });
    seen.add(key);
  }
  return {
    context: context || null,
    selected,
    omitted,
    bytes: Buffer.byteLength(context),
    diagnostics: bundle.diagnostics ?? [],
  };
}

// Child process entry point for the disposable host probe only.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [bundlePath, expectedRoot, receiptPath, nonce] = process.argv.slice(2);
  const raw = await new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
  });
  const input = JSON.parse(raw);
  if (
    input.hook_event_name !== "UserPromptSubmit" ||
    typeof input.prompt !== "string" ||
    (await fs.realpath(input.cwd)) !== (await fs.realpath(expectedRoot))
  )
    process.exit(0);
  const { assembleContext } = await import(pathToFileURL(bundlePath).href);
  const result = select(await assembleContext(expectedRoot, input.prompt));
  const context = `${result.context ?? "No accepted lesson matched."}\nLaboratory delivery marker: ${nonce}`;
  await fs.appendFile(
    receiptPath,
    JSON.stringify({
      event: input.hook_event_name,
      completedAt: new Date().toISOString(),
      promptDigest: digest(input.prompt),
      ...result,
      marker: nonce,
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
    }),
  );
}
