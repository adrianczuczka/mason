import { z } from "zod";
import { readStoreJson } from "../utils/storage.js";

export const setupHostSchema = z.object({
  configuredVersion: z.string(), revision: z.string().uuid(), fingerprint: z.string(), mcpFingerprint: z.string(),
  instructions: z.array(z.string()),
});
export const setupSchema = z.object({ version: z.literal(2), hosts: z.object({
  codex: setupHostSchema.optional(), claude: setupHostSchema.optional(),
}) });
export const SETUP_PATH = ".mason/local/setup.json";
export type SetupConfig = z.infer<typeof setupSchema>;
export async function loadSetup(root: string): Promise<SetupConfig | null> {
  const raw = await readStoreJson(root, SETUP_PATH);
  if (raw === null) return null;
  return setupSchema.parse(raw);
}

const receiptSchema = z.object({ version: z.literal(1), host: z.enum(["codex", "claude"]),
  status: z.enum(["installing", "configured"]), initialReportPath: z.string(), initialBaselinePaths: z.array(z.string()),
  root: z.string(), revision: z.string().uuid(), configuredAt: z.string().optional() });
export async function loadSetupReceipt(root: string, directory: string, host: "codex" | "claude") {
  const raw = await readStoreJson(root, directory + "/setup-" + host + ".json");
  if (raw === null) return null;
  const receipt = receiptSchema.parse(raw);
  if (receipt.root !== root || receipt.host !== host) throw new Error("Setup receipt belongs to another installation.");
  return receipt;
}
