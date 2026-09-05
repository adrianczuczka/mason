import { z } from "zod";
import { evidencePath } from "./paths.js";
import { messagePreview, type ParsedEvidence, type RawFinding, type EvidenceLocation } from "./types.js";

const index = z.number().int().nonnegative();
const artifact = z.object({ uri: z.string().optional(), uriBaseId: z.string().optional(), index: index.optional() });
const message = z.object({ text: z.string().optional(), markdown: z.string().optional(), id: z.string().optional(), arguments: z.array(z.string()).optional() });
const level = z.enum(["error", "warning", "note", "none"]);
const location = z.object({ physicalLocation: z.object({ artifactLocation: artifact.optional(), region: z.object({ startLine: index.optional(), startColumn: index.optional() }).optional() }).optional() });
const schema = z.object({
  version: z.literal("2.1.0"), runs: z.array(z.object({
    tool: z.object({ driver: z.object({ name: z.string().min(1), rules: z.array(z.object({ id: z.string(), defaultConfiguration: z.object({ level: level.optional() }).optional(), messageStrings: z.record(message).optional() })).optional(), globalMessageStrings: z.record(message).optional() }) }),
    invocations: z.array(z.object({ executionSuccessful: z.boolean(), commandLine: z.string().optional(), toolExecutionNotifications: z.array(z.object({ level: level.optional(), message })).optional() })).optional(),
    versionControlProvenance: z.array(z.object({ revisionId: z.string().optional() })).optional(),
    originalUriBaseIds: z.record(artifact).optional(), artifacts: z.array(z.object({ location: artifact.optional() })).optional(),
    results: z.array(z.object({
      ruleId: z.string().optional(), ruleIndex: index.optional(), message, level: level.optional(),
      kind: z.enum(["fail", "pass", "open", "informational", "notApplicable", "review"]).optional(),
      baselineState: z.enum(["new", "unchanged", "updated", "absent"]).optional(),
      suppressions: z.array(z.object({ kind: z.enum(["inSource", "external"]), status: z.enum(["accepted", "underReview", "rejected"]).optional() })).nullable().optional(),
      locations: z.array(location).optional(), relatedLocations: z.array(location).optional(),
    })).optional(),
  })),
});

export function parseSarif(raw: unknown, sourceRoot: string): ParsedEvidence {
  const report = schema.parse(raw), findings: RawFinding[] = [], diagnostics: string[] = [];
  let active = 0, suppressed = 0, absent = 0, unresolved = 0;
  let executed = report.runs.length > 0, executionFailed = false;
  const reportedCommits: string[] = [], reportedCommands: string[] = [], reportedTools: string[] = [];
  for (const [runIndex, run] of report.runs.entries()) {
    reportedTools.push(run.tool.driver.name);
    reportedCommits.push(...(run.versionControlProvenance ?? []).flatMap(v => v.revisionId ? [v.revisionId] : []));
    if (!run.invocations?.length) executed = false;
    for (const invocation of run.invocations ?? []) {
      if (invocation.commandLine) reportedCommands.push(invocation.commandLine);
      if (!invocation.executionSuccessful) executionFailed = true;
      for (const notification of invocation.toolExecutionNotifications ?? []) {
        diagnostics.push(notification.message.text ?? notification.message.markdown ?? "SARIF tool execution notification");
        if (notification.level === "error") executionFailed = true;
      }
    }
    if (!run.results) { diagnostics.push(`Run ${runIndex} omits results; analysis output is unavailable.`); executed = false; }
    const resolve = (ref: z.infer<typeof artifact>, seen = new Set<string>()): string | null => {
      if (!ref.uri && ref.index !== undefined) {
        const key = `artifact:${ref.index}`;
        if (seen.has(key)) return null;
        const entry = run.artifacts?.[ref.index]?.location;
        return entry ? resolve(entry, new Set([...seen, key])) : null;
      }
      if (!ref.uri) return null;
      if (!ref.uriBaseId) return ref.uri;
      if (seen.has(ref.uriBaseId)) return null;
      const base = run.originalUriBaseIds?.[ref.uriBaseId];
      if (!base) return null;
      const prefix = resolve(base, new Set([...seen, ref.uriBaseId]));
      if (!prefix) return null;
      // Base URIs use concatenation, preserving traversal for the path validator.
      return /^[a-z][a-z0-9+.-]*:/i.test(ref.uri) ? ref.uri : prefix + ref.uri;
    };
    for (const [resultIndex, result] of (run.results ?? []).entries()) {
      const kind = result.kind ?? "fail";
      const isSuppressed = result.suppressions?.some(s => s.status === "accepted");
      if (result.suppressions?.some(s => !s.status || s.status === "underReview")) {
        diagnostics.push(`Suppression state unresolved for result ${runIndex}:${resultIndex}.`); unresolved++;
      }
      const state = result.baselineState === "absent" ? "absent" : isSuppressed ? "suppressed" : kind === "fail" ? "active" : "informational";
      if (state === "active") active++;
      if (state === "absent") absent++;
      if (state === "suppressed") suppressed++;
      if (["open", "review"].includes(kind) && state === "informational") { unresolved++; diagnostics.push(`Result ${runIndex}:${resultIndex} needs further analysis or review.`); }
      if (kind === "pass" || kind === "notApplicable") continue;
      const rule = result.ruleIndex !== undefined ? run.tool.driver.rules?.[result.ruleIndex] : run.tool.driver.rules?.find(rule => rule.id === result.ruleId);
      const template = result.message.id ? rule?.messageStrings?.[result.message.id] ?? run.tool.driver.globalMessageStrings?.[result.message.id] : undefined;
      const rawMessage = result.message.text ?? result.message.markdown ?? template?.text ?? template?.markdown;
      if (!rawMessage) diagnostics.push(`Message cannot be resolved for result ${runIndex}:${resultIndex}.`);
      const rendered = (rawMessage ?? `Unresolved SARIF message ${result.message.id ?? ""}`).replace(/\{(\d+)\}/g, (match, n) => result.message.arguments?.[Number(n)] ?? match);
      const locations: EvidenceLocation[] = [];
      for (const entry of [...(result.locations ?? []), ...(result.relatedLocations ?? [])]) {
        const ref = entry.physicalLocation?.artifactLocation;
        const uri = ref ? resolve(ref) : null;
        const file = uri ? evidencePath(uri, sourceRoot, true) : null;
        if (file) locations.push({ file, line: entry.physicalLocation?.region?.startLine, column: entry.physicalLocation?.region?.startColumn });
        else diagnostics.push(`Unresolved or out-of-checkout location for result ${runIndex}:${resultIndex}.`);
      }
      const severity = result.level ?? rule?.defaultConfiguration?.level ?? (kind === "fail" ? "warning" : "none");
      findings.push({ id: `${runIndex}:${resultIndex}`, ruleId: result.ruleId ?? rule?.id, ...messagePreview(rendered), severity: severity === "none" ? "note" : severity, state, locations });
    }
  }
  if (!report.runs.length) diagnostics.push("SARIF contains no analysis runs.");
  if (executionFailed) diagnostics.push("The SARIF tool reported an unsuccessful analysis invocation.");
  return { outcome: executionFailed || !report.runs.length || report.runs.some(r => !r.results) ? "unavailable" : active ? "failed" : "passed",
    findings, counts: { active, suppressed, absent, unresolved }, incomplete: diagnostics.length > 0,
    diagnostics, reportedCommits, reportedCommands, reportedTools, executed: executed && !executionFailed };
}
