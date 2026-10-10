import { z } from "zod";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import { workspace } from "./evidence.js";
import { withLock } from "./store.js";

export const stopBlockSchema = z.enum(["off", "drift"]);
const configSchema = z.object({ version: z.literal(1), stopBlock: stopBlockSchema });
const directory = ".mason/reports/automation";
const configPath = directory + "/config.json";

export async function readAutomationConfig(root: string) {
  const raw = await readStoreJson(root, configPath);
  return raw === null
    ? { version: 1 as const, stopBlock: "drift" as const }
    : configSchema.parse(raw);
}

export async function configureStopBlock(dir: string, value: unknown) {
  const stopBlock = stopBlockSchema.parse(value);
  const ws = await workspace(dir);
  return withLock(ws.root, directory, async () => {
    const config = { ...(await readAutomationConfig(ws.root)), stopBlock };
    await writeStoreJson(ws.root, configPath, config);
    return config;
  });
}
