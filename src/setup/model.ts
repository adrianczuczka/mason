import { z } from "zod";
import { readStoreJson } from "../utils/storage.js";

export const runtimeSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  hashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  bundle: z.object({ target: z.string(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type Runtime = z.infer<typeof runtimeSchema>;
export const setupHostSchema = z.object({
  runtime: runtimeSchema, revision: z.string().uuid(), fingerprint: z.string(), mcpFingerprint: z.string(),
  instructions: z.array(z.string()),
});
export const setupSchema = z.object({ version: z.literal(1), hosts: z.object({
  codex: setupHostSchema.optional(), claude: setupHostSchema.optional(),
}) });
export type SetupConfig = z.infer<typeof setupSchema>;
export async function loadSetup(root: string): Promise<SetupConfig | null> {
  const raw = await readStoreJson(root, ".mason/setup.json");
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
