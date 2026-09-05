import fs from "node:fs/promises";
import path from "node:path";

/** External adapters translate this harness's JSON protocol to any coding agent. */
export async function loadAdapter(file) {
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  for (const key of ["name", "version", "command"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`Adapter requires ${key}`);
  }
  if (!Array.isArray(config.args) || config.args.some(a => typeof a !== "string")) throw new Error("Adapter args must be an array of strings");
  if (config.enforcesBudget !== true) throw new Error("Adapter must enforce the supplied per-session budget and declare enforcesBudget: true");
  const command = config.command.includes(path.sep) ? path.resolve(path.dirname(file), config.command) : config.command;
  return { name: config.name, version: config.version, command, args: config.args, enforcesBudget: true };
}

export function validAdapterResult(result) {
  if (!result || typeof result.ok !== "boolean" || typeof result.resultText !== "string") return false;
  if (result.ok && (typeof result.model !== "string" || !result.model)) return false;
  if (result.costUsd !== null && (typeof result.costUsd !== "number" || !Number.isFinite(result.costUsd) || result.costUsd < 0)) return false;
  if (result.numTurns !== undefined && result.numTurns !== null && (!Number.isInteger(result.numTurns) || result.numTurns < 0)) return false;
  if (!Array.isArray(result.toolCalls) || result.toolCalls.some(t => !t || typeof t.name !== "string" || !t.name)) return false;
  if (result.readFiles !== undefined && (!Array.isArray(result.readFiles) || result.readFiles.some(f => typeof f !== "string"))) return false;
  return true;
}
