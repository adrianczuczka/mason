import path from "node:path";

import { createFileAccess } from "../utils/files.js";
import { readStoreJson, writeStoreJson } from "../utils/storage.js";
import { sanitizeRepoPaths } from "../utils/paths.js";
import { trustHint, type TrustState } from "../context/trust.js";
import {
  compactDecisionKnowledge,
  effectiveDecision,
  decisionTrust,
  DECISION_GUIDANCE,
} from "../decisions/provenance.js";
import type { UpsertDecisionInput } from "../decisions/decisions.js";
import {
  reviewDecision as runDecisionReview,
  type ReviewDecisionInput,
} from "../decisions/review.js";
import { computeDecisionDrift } from "../decisions/drift.js";
import {
  loadSnapshot,
  updateSnapshot,
  getCurrentGitHash,
  normalizeFeatureType,
  type FeatureType,
} from "../snapshot/snapshot.js";
import { createSnapshotTrustReader, readSnapshotTrustIndex } from "../snapshot/trust.js";
import { computeDrift } from "../drift/drift.js";
import {
  prepareSnapshotReview,
  snapshotEntryContent,
  type SnapshotVerdict,
} from "../snapshot/review.js";
import type { DriftReport } from "../drift/drift.js";

import type { Snapshot, FeatureEntry, FlowEntry } from "../snapshot/snapshot.js";
import {
  loadProjectMarker,
  loadProjectFeatures,
  saveProjectMarker,
  setupPlaybook,
  type ProjectMarker,
  type InitMode,
} from "./init.js";
import { inspectOnboarding } from "./onboarding.js";

/** Existing maps remain readable; missing maps need no orientation workflow. */
async function unmappedContextResponse(_rootDir: string): Promise<string> {
  return JSON.stringify({
    exists: false,
    map: { status: "missing" },
    hint: "No Mason concept map exists. Use get_context for recorded decisions and get_impact for file evidence; inspect source with your agent's own tools. Managed map creation has been removed.",
  });
}

const STALE_DIFF_PREVIEW_LINES = 60;
const STALE_DIFF_MAX_FILES = 25;

async function buildChangedFilePreviews(
  rootDir: string,
  changedFiles: string[],
): Promise<Array<{ path: string; totalLines: number; preview: string }>> {
  const access = await createFileAccess(rootDir);
  const capped = changedFiles.slice(0, STALE_DIFF_MAX_FILES);
  const previews: Array<{ path: string; totalLines: number; preview: string }> = [];
  for (const filePath of capped) {
    const full = await access.read(filePath);
    if (!full) continue;
    const lines = full.content.split("\n");
    previews.push({
      path: full.path,
      totalLines: full.totalLines,
      preview: lines.slice(0, STALE_DIFF_PREVIEW_LINES).join("\n"),
    });
  }
  return previews;
}

export async function getSnapshot(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);

  const snapshot = await loadSnapshot(rootDir);

  if (!snapshot) {
    return unmappedContextResponse(rootDir);
  }

  // Staleness is per entry, not just top-level — a partially refreshed map
  // can be pinned to HEAD while individual entries lag behind.
  const drift = await computeDrift(rootDir);
  const isStale = drift?.stale ?? false;

  // Return compact format: feature/flow names -> file lists only.
  // Descriptions and metadata stay in the full snapshot on disk.
  // Deduplicate files that appear in multiple features.
  const seenFiles = new Set<string>();
  const compactFeatures: Record<string, { files: string[]; tests?: string[]; type: FeatureType }> =
    {};
  for (const [name, feat] of Object.entries(snapshot.features)) {
    const unique = feat.files.filter((f) => !seenFiles.has(f));
    if (unique.length === 0) continue; // Skip fully duplicate features
    for (const f of unique) seenFiles.add(f);
    const entry: { files: string[]; tests?: string[]; type: FeatureType } = {
      files: unique,
      type: normalizeFeatureType(feat.type),
    };
    if (feat.tests && feat.tests.length > 0) {
      entry.tests = feat.tests;
    }
    compactFeatures[name] = entry;
  }

  const compactFlows: Record<string, string[]> = {};
  for (const [name, flow] of Object.entries(snapshot.flows)) {
    compactFlows[name] = flow.chain; // Flows keep all files (order matters)
  }

  const output: Record<string, unknown> = {
    exists: true,
    map: { status: "available" },
    updatedAt: snapshot.updatedAt,
    features: compactFeatures,
    flows: compactFlows,
    stale: isStale,
  };

  // Compact decision index — titles only, no bodies (up to 150 × 1.5KB is
  // too heavy for the orientation call). Full text via get_context or the
  // record file itself.
  const { loadDecisionStore } = await import("../decisions/decisions.js");
  const store = await loadDecisionStore(rootDir);
  const decisionRecords = store.records;
  const decisionDrift = await computeDecisionDrift(rootDir, decisionRecords);
  const readTrust = createSnapshotTrustReader(rootDir);
  const trust: {
    features: Record<string, TrustState>;
    flows: Record<string, TrustState>;
    decisions: Record<string, TrustState>;
  } = {
    ...(await readSnapshotTrustIndex(readTrust, snapshot, drift)),
    decisions: Object.fromEntries(
      decisionRecords
        .filter((d) => d.status === "active")
        .map((d) => [
          d.id,
          decisionTrust(effectiveDecision(d), decisionDrift.freshness?.[d.id] ?? "unknown"),
        ]),
    ),
  };
  output.trust = trust;
  output.workingTree = drift?.workingTree;
  output.diagnostics = store.diagnostics;
  if (decisionRecords.length > 0) {
    const compactDecisions: Record<string, ReturnType<typeof compactDecisionKnowledge>> = {};
    for (const d of decisionRecords) {
      if (d.status !== "active") continue;
      compactDecisions[d.id] = compactDecisionKnowledge(
        d,
        decisionDrift.freshness?.[d.id] ?? "unknown",
        decisionDrift.pendingProposals?.[d.id]?.freshness ?? "unknown",
      );
    }
    output.decisions = compactDecisions;
    output.decisionsHint =
      DECISION_GUIDANCE + " Full bodies via get_context; full history via review_decision.";
  }

  if (isStale && drift) {
    output.hint = driftHint(drift);
    output.drift = {
      historyAvailable: drift.historyAvailable,
      staleFeatures: drift.staleFeatures,
      staleFlows: drift.staleFlows,
      unmappedFiles: drift.unmappedFiles,
      ghostFiles: drift.ghostFiles,
      renames: drift.renames,
      recommendation: drift.recommendation,
    };
    if (drift.historyAvailable && drift.changedFiles.length > 0) {
      const samples = await buildChangedFilePreviews(rootDir, drift.changedFiles);
      output.diff = {
        changedFiles: drift.changedFiles,
        samples,
        truncated: drift.changedFiles.length > STALE_DIFF_MAX_FILES,
      };
    }
  }

  output.hint = [
    output.hint,
    trustHint([
      ...Object.values(trust.features),
      ...Object.values(trust.flows),
      ...Object.values(trust.decisions),
    ]),
    store.diagnostics.length ? "Some decision records are invalid; consult diagnostics." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return JSON.stringify(output);
}

function driftHint(report: DriftReport): string {
  if (!report.stale) {
    return "No committed changes affect the map. Consult verification and working-tree evidence before relying on it.";
  }
  if (!report.historyAvailable) {
    return "Snapshot history is unavailable, so per-feature drift cannot be computed. Inspect affected source directly before updating entries with save_snapshot; do not claim unchanged entries are current.";
  }
  if (report.recommendation === "full-rebuild") {
    return "Drift affects much of the map. Inspect affected source with your own tools and correct entries with save_snapshot. Managed map creation has been removed.";
  }
  if (report.changedFiles.length + report.unmappedFiles.length > STALE_DIFF_MAX_FILES) {
    return "Many files drifted; inline previews are bounded. Inspect changedFiles and unmappedFiles using your own tools, then save_snapshot with only supported corrected entries. Entries not updated retain their prior freshness.";
  }
  const nothingToRemap =
    Object.keys(report.staleFeatures).length === 0 &&
    Object.keys(report.staleFlows).length === 0 &&
    report.unmappedFiles.length === 0 &&
    report.ghostFiles.length === 0;
  if (nothingToRemap) {
    return "Changes since the snapshot don't touch any mapped files. Call save_snapshot with empty features/flows to re-pin the snapshot to HEAD.";
  }
  return "Read the changed files under staleFeatures/staleFlows, update those entries (fold unmappedFiles into the right features), and call save_snapshot with only the affected entries — unchanged entries are preserved. Drop ghostFiles from any entries that reference them, and delete features/flows that no longer exist via save_snapshot's removeFeatures/removeFlows.";
}

export async function checkDrift(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);

  const report = await computeDrift(rootDir);
  if (!report) {
    return JSON.stringify({
      exists: false,
      hint: "No concept map exists to check. Decisions and impact work without one; inspect source using your agent’s tools. Managed map creation has been removed.",
    });
  }

  // Report recorded correctness verdicts alongside freshness evidence.
  const snapshot = await loadSnapshot(rootDir);
  let verification: Record<string, unknown> | undefined;
  let hint = driftHint(report);
  if (snapshot) {
    const all = [...Object.values(snapshot.features), ...Object.values(snapshot.flows)];
    const failedNames = [
      ...Object.entries(snapshot.features)
        .filter(([, e]) => e.verificationFailed)
        .map(([n]) => n),
      ...Object.entries(snapshot.flows)
        .filter(([, e]) => e.verificationFailed)
        .map(([n]) => n),
    ];
    verification = {
      neverVerified: all.filter((e) => !e.verifiedAt).length,
      failed: failedNames,
    };
    if (failedNames.length > 0) {
      hint += ` Verification previously FAILED for [${failedNames.join(", ")}] — re-map those entries before trusting them.`;
    }
  }

  return JSON.stringify({ exists: true, ...report, verification, hint });
}

function sanitizePaths(rootDir: string, files: string[]): string[] {
  return sanitizeRepoPaths(files);
}

export async function saveSnapshotData(
  dir: string,
  features: Record<
    string,
    {
      description: string;
      files: string[];
      tests?: string[];
      refreshedHash?: string;
      type?: FeatureType;
    }
  >,
  flows: Record<string, { description: string; chain: string[]; refreshedHash?: string }>,
  removeFeatures: string[] = [],
  removeFlows: string[] = [],
): Promise<string> {
  const rootDir = path.resolve(dir);
  return updateSnapshot(rootDir, async (previous) => {
    const gitHash = await getCurrentGitHash(rootDir);
    const now = new Date().toISOString();

    // Sanitize all file paths to prevent path traversal, and normalize the
    // capability/infrastructure classification (defaults to "capability").
    for (const feat of Object.values(features)) {
      feat.files = sanitizePaths(rootDir, feat.files);
      if (feat.tests) feat.tests = sanitizePaths(rootDir, feat.tests);
      feat.type = normalizeFeatureType(feat.type);
    }
    for (const flow of Object.values(flows)) {
      flow.chain = sanitizePaths(rootDir, flow.chain);
    }

    const existing = previous;
    // Copy-through entries must not silently lose a failed verification during
    // a direct update. A changed description/path set requires a new verdict.
    const preserveVerification = (
      next: FeatureEntry | FlowEntry,
      old?: FeatureEntry | FlowEntry,
    ) => {
      delete next.verifiedAt;
      delete next.verifiedHash;
      delete next.verificationToken;
      delete next.verificationFailed;
      delete next.verificationNote;
      if (!old) return;
      if (JSON.stringify(snapshotEntryContent(next)) !== JSON.stringify(snapshotEntryContent(old)))
        return;
      next.verificationToken = old.verificationToken;
      next.verifiedAt = old.verifiedAt;
      next.verifiedHash = old.verifiedHash;
      next.verificationFailed = old.verificationFailed;
      next.verificationNote = old.verificationNote;
    };
    for (const [name, entry] of Object.entries(features))
      preserveVerification(entry, previous?.features[name]);
    for (const [name, entry] of Object.entries(flows))
      preserveVerification(entry, previous?.flows[name]);

    if (existing) {
      // Entries not re-sent in this call are only verified as of the previous
      // hash — record that before the top-level gitHash moves to HEAD, so
      // drift detection can still see which entries were skipped.
      if (existing.gitHash !== "unknown") {
        for (const feat of Object.values(existing.features)) {
          feat.refreshedHash ??= existing.gitHash;
        }
        for (const flow of Object.values(existing.flows)) {
          flow.refreshedHash ??= existing.gitHash;
        }
      }

      const removedFeatures = removeFeatures.filter((name) => name in existing.features);
      const removedFlows = removeFlows.filter((name) => name in existing.flows);
      for (const name of removedFeatures) delete existing.features[name];
      for (const name of removedFlows) delete existing.flows[name];

      if (gitHash !== "unknown") {
        for (const feat of Object.values(features)) feat.refreshedHash = gitHash;
        for (const flow of Object.values(flows)) flow.refreshedHash = gitHash;
      }

      existing.features = { ...existing.features, ...features };
      existing.flows = { ...existing.flows, ...flows };
      existing.updatedAt = now;
      existing.gitHash = gitHash;
      return {
        snapshot: existing,
        result: JSON.stringify({
          status: "updated",
          mode: "merged",
          features: Object.keys(existing.features).length,
          flows: Object.keys(existing.flows).length,
          removedFeatures: removedFeatures.length,
          removedFlows: removedFlows.length,
        }),
      };
    }

    const snapshot: Snapshot = {
      version: 2,
      createdAt: now,
      updatedAt: now,
      gitHash,
      features,
      flows,
    };

    return {
      snapshot,
      result: JSON.stringify({
        status: "created",
        mode: "fresh",
        features: Object.keys(features).length,
        flows: Object.keys(flows).length,
      }),
    };
  });
}

export async function configureProject(
  dir: string,
  config: {
    patterns?: string[];
    alwaysInclude?: string[];
    ignore?: string[];
  },
): Promise<string> {
  const rootDir = path.resolve(dir);
  const existing = ((await readStoreJson(rootDir, ".mason/config.json")) ?? {}) as Record<
    string,
    unknown
  >;

  if (config.patterns) existing.patterns = config.patterns;
  if (config.alwaysInclude) existing.alwaysInclude = config.alwaysInclude;
  if (config.ignore) existing.ignore = config.ignore;

  await writeStoreJson(rootDir, ".mason/config.json", existing);

  return JSON.stringify({
    status: "saved",
    path: path.join(rootDir, ".mason/config.json"),
    config: existing,
  });
}

export async function getImpact(dir: string, files: string[]): Promise<string> {
  const rootDir = path.resolve(dir);
  const { analyzeImpact } = await import("../impact/impact.js");
  const result = await analyzeImpact(rootDir, files);
  return JSON.stringify(result, null, 2);
}

const VERIFY_DEFAULT_SAMPLE = 5;

/**
 * Verification closes the day-one hole drift can't: drift proves the map is
 * current against git, but nothing proves an entry was CORRECT when written.
 * Sample entries weighted toward never-verified, then oldest-verified.
 */
export async function verifySnapshot(
  dir: string,
  sample: number = VERIFY_DEFAULT_SAMPLE,
): Promise<string> {
  const rootDir = path.resolve(dir);
  const snapshot = await loadSnapshot(rootDir);
  if (!snapshot) {
    return JSON.stringify({
      exists: false,
      hint: "No concept map exists yet — nothing to verify.",
    });
  }

  const entries = [
    ...Object.entries(snapshot.features).map(([name, e]) => ({
      name,
      kind: "feature" as const,
      description: e.description,
      files: e.files,
      verifiedAt: e.verifiedAt,
    })),
    ...Object.entries(snapshot.flows).map(([name, e]) => ({
      name,
      kind: "flow" as const,
      description: e.description,
      files: e.chain,
      verifiedAt: e.verifiedAt,
    })),
  ];

  entries.sort((a, b) => {
    if (!a.verifiedAt && !b.verifiedAt) return a.name.localeCompare(b.name);
    if (!a.verifiedAt) return -1;
    if (!b.verifiedAt) return 1;
    return a.verifiedAt.localeCompare(b.verifiedAt);
  });

  const access = await createFileAccess(rootDir);
  const picked = entries.slice(0, Math.max(1, sample));
  const toVerify = [];
  for (const entry of picked) {
    const stored =
      entry.kind === "feature" ? snapshot.features[entry.name] : snapshot.flows[entry.name];
    toVerify.push({
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      lastVerified: entry.verifiedAt ?? "never",
      ...(await prepareSnapshotReview(access, entry.kind, entry.name, stored)),
    });
  }

  const neverVerified = entries.filter((e) => !e.verifiedAt).length;

  return JSON.stringify({
    exists: true,
    totalEntries: entries.length,
    neverVerified,
    entries: toVerify,
    instructions:
      'Judge whether the files implement each claimed feature/flow, then call save_verification with verdicts: {"<entry name>": {"kind": "<feature|flow from the entry>", "reviewToken": "<token from the entry>", "ok": true|false, "note": "<required when ok is false>"}}. Tokens cover the entry and full contents of the previewed files (at most 8), including unavailable-file markers; previews themselves are truncated. This is a spot-check, not proof of unshown files. A conflict requires verify_snapshot and a fresh review; never reuse a verdict for changed content. If a feature and flow share a name, submit their verdicts in separate calls.',
  });
}

export async function saveVerification(
  dir: string,
  verdicts: Record<string, SnapshotVerdict>,
): Promise<string> {
  const rootDir = path.resolve(dir);
  return updateSnapshot(rootDir, async (snapshot) => {
    if (!snapshot) {
      return {
        snapshot: null,
        result: JSON.stringify({
          exists: false,
          stamped: [],
          hint: "No concept map exists. Build it and run verify_snapshot before recording verdicts.",
        }),
      };
    }

    const stamped: string[] = [],
      unknown: string[] = [],
      failed: string[] = [];
    const conflicts: string[] = [],
      reviewRequired: string[] = [],
      invalid: string[] = [];
    const candidates: Array<{
      name: string;
      verdict: SnapshotVerdict;
      entry: FeatureEntry | FlowEntry;
    }> = [];
    let access: Awaited<ReturnType<typeof createFileAccess>> | undefined;
    for (const [name, verdict] of Object.entries(verdicts)) {
      if (
        !verdict.kind ||
        !["feature", "flow"].includes(verdict.kind) ||
        !/^[a-f0-9]{64}$/.test(verdict.reviewToken ?? "")
      ) {
        reviewRequired.push(name);
        continue;
      }
      if (typeof verdict.ok !== "boolean" || (!verdict.ok && !verdict.note?.trim())) {
        invalid.push(name);
        continue;
      }
      const collection = verdict.kind === "feature" ? snapshot.features : snapshot.flows;
      if (!Object.hasOwn(collection, name)) {
        unknown.push(name);
        conflicts.push(name);
        continue;
      }
      const entry = collection[name];
      access ??= await createFileAccess(rootDir);
      const current = await prepareSnapshotReview(access, verdict.kind, name, entry);
      if (current.reviewToken !== verdict.reviewToken) conflicts.push(name);
      else candidates.push({ name, verdict, entry });
    }

    const verifiedHash = candidates.length ? await getCurrentGitHash(rootDir) : "unknown";
    // Refresh the inventory and source reads before committing a multi-entry batch.
    // Editors do not take our lock; the persisted token identifies the evidence
    // actually checked, while normal drift reporting handles later source edits.
    const freshAccess = candidates.length ? await createFileAccess(rootDir) : null;
    const now = new Date().toISOString();
    for (const { name, verdict, entry } of candidates) {
      const current = await prepareSnapshotReview(freshAccess!, verdict.kind!, name, entry);
      if (current.reviewToken !== verdict.reviewToken) {
        conflicts.push(name);
        continue;
      }
      entry.verifiedAt = now;
      entry.verifiedHash = verifiedHash;
      entry.verificationToken = verdict.reviewToken;
      if (verdict.ok) {
        delete entry.verificationFailed;
        delete entry.verificationNote;
      } else {
        entry.verificationFailed = true;
        entry.verificationNote = verdict.note!.trim();
        failed.push(name);
      }
      stamped.push(name);
    }

    const rejected = conflicts.length + reviewRequired.length + invalid.length;
    const status = rejected
      ? stamped.length
        ? "partial"
        : conflicts.length
          ? "conflict"
          : reviewRequired.length
            ? "review_required"
            : "invalid"
      : stamped.length
        ? "saved"
        : "unchanged";
    const hints: string[] = [];
    if (conflicts.length)
      hints.push(
        `Entries [${conflicts.join(", ")}] changed or were deleted after review. Run verify_snapshot and review current evidence before retrying.`,
      );
    if (reviewRequired.length)
      hints.push(
        `Entries [${reviewRequired.join(", ")}] need kind and reviewToken from verify_snapshot. Inspect that evidence before submitting a verdict.`,
      );
    if (invalid.length)
      hints.push(
        `Entries [${invalid.join(", ")}] need a boolean ok and a non-empty note when ok is false.`,
      );
    if (failed.length)
      hints.push(
        `Entries [${failed.join(", ")}] are mis-mapped. Re-map them: read their actual files, correct the entries, and call save_snapshot with only those entries (plus removeFeatures/removeFlows if a concept no longer exists). Then run verify_snapshot for fresh review tokens.`,
      );
    if (!hints.length)
      hints.push(
        stamped.length
          ? "All submitted entries verified against the reviewed evidence. Re-run verify_snapshot periodically."
          : "No verdicts submitted; nothing changed.",
      );
    if (stamped.length) snapshot.updatedAt = now;
    return {
      snapshot: stamped.length ? snapshot : null,
      result: JSON.stringify({
        status,
        stamped,
        unknown,
        failed,
        conflicts,
        reviewRequired,
        invalid,
        hint: hints.join(" "),
      }),
    };
  });
}

export async function saveDecision(dir: string, input: UpsertDecisionInput): Promise<string> {
  const rootDir = path.resolve(dir);
  const { upsertDecision } = await import("../decisions/decisions.js");
  const result = await upsertDecision(rootDir, input);
  return JSON.stringify(result);
}

export async function reviewDecision(dir: string, input: ReviewDecisionInput): Promise<string> {
  return JSON.stringify(await runDecisionReview(path.resolve(dir), input));
}

export async function getContext(dir: string, task: string, files?: string[]): Promise<string> {
  const rootDir = path.resolve(dir);
  const { assembleContext } = await import("../context/assemble.js");
  const bundle = await assembleContext(rootDir, task, files);
  return JSON.stringify(bundle);
}

// ===== Init MCP tools =====

export async function masonAutomation(dir: string, action: "status" | "check"): Promise<string> {
  try {
    const { automate, automationStatus, summarize } = await import("../automation/runtime.js");
    const { installedAutomation } = await import("../automation/install.js");
    if (action === "status") {
      const { setupStatus } = await import("../setup/status.js");
      return JSON.stringify({
        ...(await automationStatus(dir)),
        configured: await installedAutomation(dir),
        setup: await setupStatus(dir),
      });
    }
    if (action !== "check") throw new Error("Expected status or check.");
    const { report } = await automate(dir, { event: "task_end" });
    const { findings, ...summary } = report;
    return JSON.stringify({
      ...summary,
      findings: findings.slice(0, 5),
      truncated: findings.length > 5,
      summary: summarize(report),
    });
  } catch (error) {
    const { automationFailure } = await import("../automation/execution.js");
    const failure = automationFailure(error);
    return JSON.stringify({ version: 1, status: "unavailable", error: failure.message, failure });
  }
}

export async function masonInit(
  dir: string,
  options: { mode?: InitMode; host?: "codex" | "claude"; base?: string; evidence?: string[] } = {},
): Promise<string> {
  if (options.mode && options.mode !== "quickstart" && options.mode !== "setup")
    throw new Error("Managed map creation has been removed; use quickstart or setup.");
  if (options.mode === "setup") {
    const { setupProject } = await import("../setup/setup.js");
    return JSON.stringify(await setupProject(dir, options), null, 2);
  }
  if (options.host) throw new Error("host applies only to mode: setup.");
  const rootDir = path.resolve(dir);
  const marker = await loadProjectMarker(rootDir);
  const { loadSetup } = await import("../setup/model.js");
  const setup = await loadSetup(rootDir);
  const mode = options.mode ?? "quickstart";
  const findings = await inspectOnboarding(rootDir, options.base, options.evidence);
  return JSON.stringify(
    {
      initialized: marker !== null || setup !== null,
      ...(marker ? { initializedAt: marker.initializedAt } : {}),
      mode,
      ...findings,
      playbook: setupPlaybook(),
    },
    null,
    2,
  );
}

export async function masonCompleteInit(dir: string): Promise<string> {
  const rootDir = path.resolve(dir);
  const existing = await loadProjectMarker(rootDir);
  const features = await loadProjectFeatures(rootDir);
  const marker: ProjectMarker = {
    version: 1,
    initializedAt: existing?.initializedAt ?? new Date().toISOString(),
    features,
  };
  await saveProjectMarker(rootDir, marker);
  return JSON.stringify(
    {
      status: "initialized",
      marker,
      hint: "Assistant setup recorded. Save decisions as you learn, review and commit them, and retrieve them with get_context. A concept map is optional.",
    },
    null,
    2,
  );
}
