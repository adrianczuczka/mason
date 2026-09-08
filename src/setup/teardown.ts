import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import fg from "fast-glob";
import { z } from "zod";
import { hash, workspace } from "../automation/evidence.js";
import { withLock, type Host } from "../automation/store.js";
import { AUTOMATION_PATH, automationConfigSchema, configPath, recordSchema } from "../automation/install.js";
import { hookConfig } from "../automation/adapters.js";
import { DOC_CANDIDATES } from "../audit/docs.js";
import { CLAUDE_MD_SECTION } from "../mcp/init.js";
import { applyEdit, managedBlock, readText, type FileEdit, type RemovalEdit } from "./files.js";
import { mcpPath } from "./config.js";
import { hookCommand, mcpCommand } from "./launcher.js";
import { loadSetupReceipt, SETUP_PATH, setupSchema } from "./model.js";
import { BLOCKS, blockSpan, OWNERSHIP_PATH, ownershipSchema, type Ownership } from "./ownership.js";

type Edit = FileEdit | RemovalEdit;
const hosts = ["codex", "claude"] as const;
const object = z.record(z.unknown());
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

async function planTeardown(root: string, selected: readonly Host[]) {
  const edits: Edit[] = [], diagnostics: Array<{ path: string; message: string }> = [];
  const inputs = new Map<string, string | null>();
  const read = async (file: string) => {
    if (!inputs.has(file)) inputs.set(file, await readText(root, file));
    return inputs.get(file)!;
  };
  const attempt = async (file: string, action: () => Promise<void>) => {
    try { await action(); }
    catch (error) { diagnostics.push({ path: file, message: error instanceof Error ? error.message : String(error) }); }
  };
  // Invalid local ownership is not a license to guess. Fail before any edits.
  const ownershipBefore = await read(OWNERSHIP_PATH);
  const ownership: Ownership = ownershipBefore === null ? { version: 1, files: {} } : ownershipSchema.parse(JSON.parse(ownershipBefore));
  const setupBefore = await read(SETUP_PATH);
  const setup = setupBefore === null ? null : setupSchema.parse(JSON.parse(setupBefore));
  const automationBefore = await read(AUTOMATION_PATH);
  const automation = automationBefore === null ? null : recordSchema.parse(JSON.parse(automationBefore));
  const commands = (host: Host) => new Set([
    automation?.hosts[host]?.command,
    ...(ownership.files[configPath(host)]?.hookCommands ?? []),
    hookConfig(host, hookCommand(host)).hooks.SessionStart[0].hooks[0].command,
    hookConfig(host).hooks.SessionStart[0].hooks[0].command,
  ].filter((command): command is string => !!command));
  const possibleHook = (command: string, host: Host) => commands(host).has(command) || /\bmason(?:-auto|-hook)?\b/.test(command);
  const add = (file: string, before: string, after: string, empty: boolean) => {
    edits.push({ path: file, before, after: ownership.files[file]?.created &&
      (empty || ownership.files[file].initialHash === hash(before)) ? null : after });
  };

  let remainingHost = hosts.some(host => !selected.includes(host) && (setup?.hosts[host] || automation?.hosts[host] ||
    ownership.files[mcpPath(host)] || ownership.files[configPath(host)]));
  // A clone or manually configured second host can still need the shared guidance.
  for (const host of hosts.filter(host => !selected.includes(host))) {
    await attempt(mcpPath(host), async () => {
      const text = await read(mcpPath(host));
      const config = host === "codex" ? parse(text ?? "") : object.parse(JSON.parse(text ?? "{}"));
      const servers = object.parse((host === "codex" ? config.mcp_servers : config.mcpServers) ?? {});
      remainingHost ||= servers.mason !== undefined;
    });
    await attempt(configPath(host), async () => {
      const config = automationConfigSchema.parse(JSON.parse(await read(configPath(host)) ?? "{}"));
      remainingHost ||= Object.values(config.hooks ?? {}).some(groups => groups.some(group =>
        group.hooks.some(handler => handler.command && possibleHook(handler.command, host))));
    });
  }

  for (const host of selected) {
    const mcpFile = mcpPath(host);
    await attempt(mcpFile, async () => {
      const before = await read(mcpFile);
      if (before === null) return;
      const config = host === "codex" ? parse(before) : object.parse(JSON.parse(before));
      const key = host === "codex" ? "mcp_servers" : "mcpServers";
      const servers = object.parse(config[key] ?? {});
      if (servers.mason === undefined) {
        if (host === "codex" && BLOCKS[2].some(marker => before.includes(marker))) throw new Error("The marked Mason MCP entry was removed or renamed; inspect the retained block manually.");
        return;
      }
      const expected = ownership.files[mcpFile]?.mcpHash ?? hash(mcpCommand(host));
      if (hash(servers.mason) !== expected) throw new Error("The Mason MCP entry was edited or its ownership is uncertain; retained for manual cleanup.");
      delete servers.mason;
      const desired = { ...config, [key]: servers };
      if (!Object.keys(servers).length) delete desired[key];
      if (host === "claude") { add(mcpFile, before, json(desired), !Object.keys(desired).length); return; }
      const [start, end] = BLOCKS[2], block = blockSpan(before, start, end);
      if (!block) throw new Error("Mason MCP markers are missing; retained for manual cleanup.");
      const expectedBlock = ownership.files[mcpFile]?.blocks[start];
      const canonicalBlock = managedBlock("", start, end, stringify({ mcp_servers: { mason: mcpCommand(host) } }).trimEnd()).trimEnd();
      if (expectedBlock ? hash(block.text) !== expectedBlock : block.text.replace(/\r\n/g, "\n") !== canonicalBlock) {
        throw new Error("The Mason MCP block was edited; retained for manual cleanup.");
      }
      const after = before.slice(0, block.from) + before.slice(block.to).replace(/^\r?\n/, "");
      const parsed = parse(after);
      // An existing empty parent table is meaningful user text; retain it.
      if (!Object.keys(servers).length && parsed[key] !== undefined) desired[key] = {};
      if (!isDeepStrictEqual(parsed, desired)) throw new Error("Removing the marked block would change other TOML settings; retained for manual cleanup.");
      add(mcpFile, before, after, !after.trim());
    });
    const hookFile = configPath(host);
    await attempt(hookFile, async () => {
      const before = await read(hookFile);
      if (before === null) return;
      const config = automationConfigSchema.parse(JSON.parse(before));
      let changed = false;
      for (const [event, groups] of Object.entries(config.hooks ?? {})) {
        const known = ownership.files[hookFile]?.hooks?.[event];
        const handlers = groups.flatMap(group => group.hooks);
        if (known && !handlers.some(handler => handler.type === "command" && handler.command && commands(host).has(handler.command)) &&
          handlers.some(handler => !known.includes(hash(handler)))) {
          diagnostics.push({ path: hookFile, message: "A recorded Mason hook is missing beside a new or edited handler (" + event + "); inspect ownership manually." });
        }
        const kept = groups.flatMap(group => {
          const handlers = group.hooks.filter(handler => {
            if (handler.type === "command" && handler.command && commands(host).has(handler.command)) { changed = true; return false; }
            if (handler.command && possibleHook(handler.command, host)) diagnostics.push({ path: hookFile,
              message: "An unrecognized Mason hook was retained for manual cleanup (" + event + ")." });
            return true;
          });
          return handlers.length === group.hooks.length ? [group] : handlers.length ? [{ ...group, hooks: handlers }] : [];
        });
        if (kept.length || !groups.length) config.hooks![event] = kept;
        else delete config.hooks![event];
      }
      if (!changed) return;
      if (!Object.keys(config.hooks ?? {}).length) delete config.hooks;
      add(hookFile, before, json(config), !Object.keys(config).length);
    });
  }

  // Keep instructions and ownership until all selected integration removals are unambiguous.
  const instructionEditStart = edits.length;
  if (!remainingHost && !diagnostics.length) for (const file of DOC_CANDIDATES) await attempt(file, async () => {
    const before = await read(file);
    if (before === null) return;
    let after = before;
    for (const [start, end] of BLOCKS.slice(0, 2)) {
      const block = blockSpan(after, start, end);
      if (!block) continue;
      const pointer = "Mason project knowledge and shared project instructions:\n@" + (file.startsWith(".claude/") ? "../AGENTS.md" : "AGENTS.md");
      const canonical = [CLAUDE_MD_SECTION, managedBlock("", start, end, pointer).trimEnd()];
      const expected = ownership.files[file]?.blocks[start];
      if (expected ? hash(block.text) !== expected : !canonical.includes(block.text.replace(/\r\n/g, "\n"))) {
        throw new Error("The Mason instruction block was edited or is unrecognized; retained for manual cleanup.");
      }
      after = after.slice(0, block.from) + after.slice(block.to).replace(/^\r?\n/, "");
    }
    if (after !== before) add(file, before, after, !after.trim());
  });
  // Do not leave a retained native import pointing at a document we just removed.
  if (diagnostics.length) edits.splice(instructionEditStart);

  if (!diagnostics.length) {
    const cleanup: Edit[] = [];
    const receiptFiles = await fg(selected.map(host => ".mason/reports/automation/*/setup-" + host + ".json"),
      { cwd: root, dot: true, onlyFiles: false, followSymbolicLinks: false });
    if (receiptFiles.length > 1000) throw new Error("Too many setup receipts; inspect local setup history before teardown.");
    for (const file of receiptFiles.sort()) await attempt(file, async () => {
      const host = file.endsWith("setup-codex.json") ? "codex" : "claude";
      await loadSetupReceipt(root, file.slice(0, file.lastIndexOf("/")), host);
      cleanup.push({ path: file, before: await read(file), after: null });
    });
    if (!remainingHost) await attempt(".mason/local/project.json", async () => {
      const before = await read(".mason/local/project.json");
      if (before === null) return;
      z.object({ version: z.literal(1), initializedAt: z.string() }).strict().parse(JSON.parse(before));
      cleanup.push({ path: ".mason/local/project.json", before, after: null });
    });
    // Final bookkeeping is last. On interruption, original ownership can safely resume removals.
    if (!diagnostics.length) {
      for (const host of selected) {
        if (setup) delete setup.hosts[host];
        if (automation) delete automation.hosts[host];
        delete ownership.files[mcpPath(host)];
        delete ownership.files[configPath(host)];
      }
      if (!remainingHost) for (const file of DOC_CANDIDATES) delete ownership.files[file];
      if (setupBefore !== null) cleanup.push({ path: SETUP_PATH, before: setupBefore, after: Object.keys(setup!.hosts).length ? json(setup) : null });
      if (automationBefore !== null) cleanup.push({ path: AUTOMATION_PATH, before: automationBefore, after: Object.keys(automation!.hosts).length ? json(automation) : null });
      if (ownershipBefore !== null) cleanup.push({ path: OWNERSHIP_PATH, before: ownershipBefore, after: Object.keys(ownership.files).length ? json(ownership) : null });
      edits.push(...cleanup);
    }
  }
  return { edits: edits.filter(edit => edit.before !== edit.after), diagnostics, remainingHost, inputs };
}

export async function teardownProject(dir: string, options: { host?: Host; dryRun?: boolean } = {}) {
  const { root } = await workspace(dir);
  const selected = options.host ? [options.host] : [...hosts];
  const run = async (apply: boolean) => {
    const plan = await planTeardown(root, selected);
    if (apply) {
      // Include the other host and shared instructions in the concurrency check.
      for (const [file, before] of plan.inputs) if (await readText(root, file) !== before) throw new Error("Input changed during teardown: " + file + ". Rerun teardown.");
      for (const edit of plan.edits) await applyEdit(root, edit);
    }
    return { version: 1, action: "teardown", status: plan.diagnostics.length ? "incomplete" : "complete", root,
      hosts: selected, dryRun: !!options.dryRun,
      changes: plan.edits.map(edit => ({ path: edit.path, action: edit.after === null ? "delete" : "update" })),
      diagnostics: plan.diagnostics, sharedInstructionsRetained: plan.remainingHost || !!plan.diagnostics.length,
      next: plan.diagnostics.length ? "Inspect the retained entries, remove or correct them, then rerun teardown."
        : "Restart running assistants to unload the project integration. Run mason setup --host codex or --host claude to reconnect.",
    };
  };
  // A preview (including an untouched project) must not create local state or locks.
  const preview = await run(false);
  if (options.dryRun || !preview.changes.length) return preview;
  return withLock(root, ".mason/reports/setup-lock", () => run(true));
}

export function summarizeTeardown(result: Awaited<ReturnType<typeof teardownProject>>) {
  return [`Mason teardown${result.dryRun ? " preview" : ""}: ${result.status}.`,
    ...result.changes.map(change => `  ${result.dryRun ? "Would " : ""}${change.action}: ${change.path}`),
    ...result.diagnostics.map(item => `  Retained ${item.path}: ${item.message}`),
    ...(!result.changes.length ? ["No changes."] : []),
    "Shared knowledge, repair evidence, ignore rules and the installed Mason command are retained.",
    ...(result.sharedInstructionsRetained ? ["Shared instruction cleanup is deferred while another host or incomplete removal needs inspection."] : []),
    ...(result.dryRun ? ["Preview only; no files were changed."] : [result.next]),
  ].join("\n");
}
