import { z } from "zod";
import { parse } from "smol-toml";
import { hash } from "../automation/evidence.js";
import { readText, type FileEdit } from "./files.js";

export const OWNERSHIP_PATH = ".mason/local/integration.json";
export const BLOCKS = [
  ["<!-- mason:start -->", "<!-- mason:end -->"],
  ["<!-- mason:agents:start -->", "<!-- mason:agents:end -->"],
  ["# mason:mcp:start", "# mason:mcp:end"],
] as const;
const fileSchema = z.object({ created: z.boolean(), initialHash: z.string(),
  blocks: z.record(z.string()), mcpHash: z.string().optional(), hookCommands: z.array(z.string()).optional(), hooks: z.record(z.array(z.string())).optional() });
export const ownershipSchema = z.object({ version: z.literal(1), files: z.record(fileSchema) });
export type Ownership = z.infer<typeof ownershipSchema>;

export function blockSpan(text: string, start: string, end: string) {
  const starts = text.split(start).length - 1, ends = text.split(end).length - 1;
  if (!starts && !ends) return null;
  const from = text.indexOf(start), to = text.indexOf(end) + end.length;
  if (starts !== 1 || ends !== 1 || to <= from) throw new Error("Ambiguous Mason markers; inspect the marked block manually.");
  return { from, to, text: text.slice(from, to) };
}

/** Persist ownership before shared edits so interrupted setup remains removable. */
export async function ownershipEdit(root: string, edits: FileEdit[], hookCommands: Record<string, string> = {}): Promise<FileEdit> {
  const before = await readText(root, OWNERSHIP_PATH);
  const record: Ownership = before === null ? { version: 1, files: {} } : ownershipSchema.parse(JSON.parse(before));
  for (const edit of edits) {
    const previous = record.files[edit.path];
    const entry = { created: edit.before === null || (previous?.created ?? false),
      initialHash: edit.before === null || previous?.initialHash === hash(edit.before) ? hash(edit.after) : previous?.initialHash ?? hash(edit.after),
      blocks: Object.fromEntries(BLOCKS.flatMap(([start, end]) => {
        const block = blockSpan(edit.after, start, end);
        return block ? [[start, hash(block.text)]] : [];
      })),
    };
    const mcp = edit.path === ".codex/config.toml" ? (parse(edit.after).mcp_servers as Record<string, unknown>)?.mason
      : edit.path === ".mcp.json" ? JSON.parse(edit.after).mcpServers?.mason : undefined;
    const hooks = edit.path === ".codex/hooks.json" || edit.path === ".claude/settings.json"
      ? JSON.parse(edit.after).hooks as Record<string, Array<{ hooks: unknown[] }>> | undefined : undefined;
    record.files[edit.path] = { ...entry, ...(mcp === undefined ? {} : { mcpHash: hash(mcp) }),
      ...(hookCommands[edit.path] ? { hookCommands: [...new Set([...(previous?.hookCommands ?? []), hookCommands[edit.path]])] } : {}),
      ...(hooks === undefined ? {} : { hooks: Object.fromEntries(Object.entries(hooks).map(([event, groups]) =>
        [event, groups.flatMap(group => group.hooks.map(hash))])) }),
    };
  }
  return { path: OWNERSHIP_PATH, before, after: JSON.stringify(record, null, 2) + "\n" };
}

/** Forget earlier commands only after their replacement and installation record were saved. */
export async function completedHookOwnership(root: string, file: string, command: string): Promise<FileEdit> {
  const before = await readText(root, OWNERSHIP_PATH);
  const record = ownershipSchema.parse(JSON.parse(before ?? "null"));
  record.files[file].hookCommands = [command];
  return { path: OWNERSHIP_PATH, before, after: JSON.stringify(record, null, 2) + "\n" };
}
