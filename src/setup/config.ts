import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { CLAUDE_MD_SECTION } from "../mcp/init.js";
import { DOC_CANDIDATES } from "../audit/docs.js";
import { hookConfig } from "../automation/adapters.js";
import { configPath, automationConfigSchema, AUTOMATION_PATH } from "../automation/install.js";
import type { Host } from "../automation/store.js";
import { readText, managedBlock, type FileEdit } from "./files.js";
import { hookCommand, mcpCommand } from "./launcher.js";

const object = z.record(z.unknown());
export const mcpPath = (host: Host) => host === "codex" ? ".codex/config.toml" : ".mcp.json";
const TOML_START = "# mason:mcp:start", TOML_END = "# mason:mcp:end";
const POINTER_START = "<!-- mason:agents:start -->", POINTER_END = "<!-- mason:agents:end -->";
export async function instructionEdits(root: string, host?: Host) {
  const found = await Promise.all(DOC_CANDIDATES.map(async file => ({ path: file, text: await readText(root, file) })));
  const existing = found.find(f => f.text !== null);
  const primary = host === "codex" && found[0].text === null ? { path: "AGENTS.md", text: null }
    : existing ?? { path: "AGENTS.md", text: null };
  const originalGuidance = primary.text === null && existing ? "Follow the existing project conventions in " + existing.path + ".\n" : "";
  const edits: FileEdit[] = [{ path: primary.path, before: primary.text,
    after: managedBlock(primary.text ?? originalGuidance, "<!-- mason:start -->", "<!-- mason:end -->", CLAUDE_MD_SECTION.split("\n").slice(1, -1).join("\n")) }];
  if (primary.path === "AGENTS.md") {
    const secondary = found.filter(f => f.path !== "AGENTS.md" && f.text !== null);
    if (host === "claude" && !secondary.length) secondary.push({ path: "CLAUDE.md", text: null });
    for (const file of secondary) {
      const text = file.text ?? "";
      const legacy = text.includes("<!-- mason:start -->") || text.includes("<!-- mason:end -->");
      const imported = "@" + (file.path.startsWith(".claude/") ? "../AGENTS.md" : "AGENTS.md");
      if (text.trim() === imported) continue;
      // Claude expands native imports at session start; a prose mention does not load the guidance.
      const pointer = "Mason project knowledge and shared project instructions:\n" + imported;
      edits.push({ path: file.path, before: file.text,
        after: managedBlock(text, legacy ? "<!-- mason:start -->" : POINTER_START, legacy ? "<!-- mason:end -->" : POINTER_END, pointer) });
    }
  }
  return edits;
}

/** Retain host options and environment; replace only transport/launch details. */
function managedMcp(previous: unknown, host: Host) {
  const options = previous === undefined ? {} : object.parse(previous);
  for (const key of ["command", "args", "url", "type", "headers", "http_headers", "env_http_headers", "bearer_token_env_var"]) delete options[key];
  return { ...options, ...mcpCommand(host) };
}

export async function mcpEdit(root: string, host: Host): Promise<FileEdit> {
  const file = mcpPath(host), before = await readText(root, file);
  if (host === "claude") {
    const config = before === null ? {} : object.parse(JSON.parse(before));
    const servers = object.parse(config.mcpServers ?? {});
    // Mason owns only its named server; other servers and settings retain their values.
    return { path: file, before, after: JSON.stringify({ ...config, mcpServers: { ...servers, mason: managedMcp(servers.mason, host) } }, null, 2) + "\n" };
  }
  const config = parse(before ?? "");
  const managed = (before ?? "").includes(TOML_START);
  const servers = config.mcp_servers as Record<string, unknown> | undefined;
  const desired = managedMcp(servers?.mason, host);
  let base = before ?? "";
  if (servers?.mason && !managed) {
    // Migrate ordinary explicit tables without reserializing the rest of TOML.
    // Validate the whole semantic result afterwards, including multiline strings.
    const headers = [...base.matchAll(/^\s*\[\[?.+?\]\]?[^\S\r\n]*(?:#.*)?$/gm)];
    const spans = headers.flatMap((header, index) => /^\s*\[mcp_servers\.mason(?:\.[A-Za-z0-9_-]+)*\]/.test(header[0])
      ? [{ start: header.index!, end: headers[index + 1]?.index ?? base.length }] : []);
    if (!spans.length) throw new Error("Cannot safely migrate the existing Mason MCP TOML entry. Use an explicit [mcp_servers.mason] table and rerun setup; the file was retained.");
    for (const span of spans.reverse()) base = base.slice(0, span.start) + base.slice(span.end);
  }
  const after = managedBlock(base, TOML_START, TOML_END, stringify({ mcp_servers: { mason: desired } }).trimEnd());
  const parsed = parse(after);
  const expected = { ...config, mcp_servers: { ...(servers ?? {}), mason: desired } };
  if (!isDeepStrictEqual(parsed, expected)) throw new Error("Could not safely configure the Mason MCP entry without changing other settings.");
  return { path: file, before, after };
}

export async function hookEdits(root: string, host: Host): Promise<FileEdit[]> {
  const file = configPath(host), before = await readText(root, file);
  const { planAutomationInstall } = await import("../automation/install.js");
  const plan = await planAutomationInstall(root, host, hookCommand(host));
  return [{ path: file, before, after: JSON.stringify(plan.config, null, 2) + "\n" },
    { path: AUTOMATION_PATH, before: await readText(root, AUTOMATION_PATH), after: JSON.stringify(plan.record, null, 2) + "\n" }];
}

export async function ancillaryEdits(root: string) {
  const ignore = await readText(root, ".gitignore");
  const { git } = await import("../automation/evidence.js");
  const { isGitRepo } = await import("../utils/git.js");
  let parentIgnored = false;
  try { if (await isGitRepo(root)) parentIgnored = !!(await git(root, "check-ignore", "--no-index", ".mason")).trim(); }
  catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
  const retainParentRule = parentIgnored || !!ignore?.replace(/\r\n/g, "\n").includes("# mason:ignore:start\n!/.mason/\n/.mason/*");
  const rules = [...(retainParentRule ? ["!/.mason/", "/.mason/*"] : []),
    "!/.mason/decisions/", "!/.mason/decisions/**", "!/.mason/reviews/", "!/.mason/reviews/**", "!/.mason/config.json", "!/.mason/snapshot.json",
    "/.mason/local/", "/.mason/reports/"].join("\n");
  return [{ path: ".gitignore", before: ignore, after: managedBlock(ignore ?? "", "# mason:ignore:start", "# mason:ignore:end", rules) }];
}

export async function inspectHostConfig(root: string, host: Host, plannedMcp?: string) {
  const text = plannedMcp ?? await readText(root, mcpPath(host));
  const config = host === "codex" ? parse(text ?? "") : object.parse(JSON.parse(text ?? "{}"));
  const servers = (host === "codex" ? config.mcp_servers : config.mcpServers) as Record<string, unknown> | undefined;
  const hooks = automationConfigSchema.parse(JSON.parse(await readText(root, configPath(host)) ?? "{}"));
  const expected = hookConfig(host, hookCommand(host));
  const mcp = servers?.mason === undefined ? null : object.parse(servers.mason);
  return { mcp, mcpDisabled: mcp?.enabled === false, hooks: Object.fromEntries(Object.keys(expected.hooks).map(event => [event,
    (hooks.hooks?.[event] ?? []).flatMap(group => group.hooks.filter(handler => handler.command === expected.hooks.SessionStart[0].hooks[0].command).map(handler => ({ ...group, hooks: [handler] })) ?? [])])),
    disabled: hooks.disableAllHooks === true || (config.features as Record<string, unknown> | undefined)?.hooks === false ||
      (config.features as Record<string, unknown> | undefined)?.codex_hooks === false };
}
