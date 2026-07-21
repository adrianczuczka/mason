export const BATCH_SYSTEM_PROMPT = `You are Mason, building one piece of a larger concept-to-files map via a Map-Reduce pattern.

You are seeing ONE batch of files from this project — not the whole codebase. Other batches will be processed separately and merged with yours in a final reduce step.

Your job for this batch: identify the features and flows that involve the files in this batch, and return a partial concept map.

Respond with ONLY a JSON object. No markdown, no explanation, no code fences. Just the raw JSON. Same shape as the full map (\`{"features": {...}, "flows": {...}}\`).

CRITICAL: name features in PRODUCT-NATURAL language (e.g., "home screen", "authentication", "checkout"). Do NOT add platform or layer suffixes — call both the Android and iOS home-screen files part of a feature named "home screen". This is what lets the reduce step merge platform variants from other batches into a single product feature.

Other rules:
- Only include files that you see in this batch. Don't predict files in other batches.
- Use the FULL relative file paths exactly as given.
- Each feature should have 1–8 files from this batch — partials can be narrow.
- Flows in a partial only make sense if all their chain steps are in this batch. Skip flows that span batches; the reduce step will assemble them.
- Include test files in "tests" when present in this batch.
- Two views of the batch: FILE HEADERS (every file in the batch, skeleton-level) and REPRESENTATIVE BODIES (deeper read of a few for grounding). Use the bodies to learn the codebase's domain vocabulary; use the headers to know which files exist.`;

export const REDUCE_SYSTEM_PROMPT = `You are Mason, merging partial concept maps from a Map-Reduce pass into a single unified map.

You will receive an array of \`partials\`, each produced from one batch of files. Your job: merge them into one coherent concept-to-files map for the whole project.

Respond with ONLY a JSON object: \`{"features": {...}, "flows": {...}}\`. No markdown, no preamble.

Merge rules:
- If two partials use the same feature name (e.g., both have "home screen"), MERGE them — combine their \`files\` and \`tests\` arrays (dedupe), and reconcile descriptions by picking the more product-natural wording or merging the two.
- If two partials use *near-duplicate* feature names that clearly refer to the same product concept ("home screen" vs "home view", "auth" vs "authentication"), merge them under the more product-natural name.
- If a partial split what should be one feature by platform ("home Android" + "home iOS"), merge into a single platform-agnostic feature ("home screen").
- For flows that were skipped by partials because they span batches, reconstruct them when you can see the full chain across multiple partials.
- Every file that appears in any partial MUST end up in some feature in the unified map. Don't silently drop files.
- Feature descriptions in the final map should be 1–2 sentences, written for a product/PM audience — concrete and specific, but free of code-level detail.
- Each feature should have 2–8 files. If merging produces a feature with 20+ files, consider whether it should be split into sub-features.`;

export function buildBatchPrompt(
  batch: {
    offset: number;
    batchSize: number;
    nextOffset: number | null;
    totalFiles: number;
    skeletons: Array<{ path: string; content: string }>;
    samples: Array<{ path: string; content: string }>;
    testPairs?: Array<{ test: string; source: string; confidence: string }>;
  }
): string {
  const skeletonBlocks = batch.skeletons
    .map(
      (f) =>
        `--- ${f.path} ---\n${f.content}${f.content.length >= 500 ? "\n... (truncated)" : ""}`
    )
    .join("\n\n");

  const sampleBlocks = batch.samples
    .map(
      (f) =>
        `=== ${f.path} (deeper read) ===\n${f.content}${f.content.length >= 1500 ? "\n... (truncated)" : ""}`
    )
    .join("\n\n");

  const batchInfo = `Batch ${Math.floor(batch.offset / batch.batchSize) + 1}: files ${batch.offset + 1}–${batch.offset + batch.skeletons.length} of ${batch.totalFiles}.`;

  let prompt = `${batchInfo}

=== FILE HEADERS (every file in this batch) ===

${skeletonBlocks}

=== REPRESENTATIVE BODIES (for grounding) ===

${sampleBlocks}`;

  if (batch.testPairs && batch.testPairs.length > 0) {
    const testBlock = batch.testPairs
      .map((p) => `${p.test} → ${p.source}`)
      .join("\n");
    prompt += `\n\n=== TEST → SOURCE MAPPINGS (for this batch) ===\n\n${testBlock}`;
  }

  return prompt;
}

export function buildReducePrompt(
  partials: Array<{
    batchId: string;
    offset: number;
    features: Record<string, { description: string; files: string[]; tests?: string[] }>;
    flows: Record<string, { description: string; chain: string[] }>;
  }>
): string {
  return `Merge the following ${partials.length} partial concept maps into a single unified map.

${JSON.stringify({ partials }, null, 2)}`;
}

export const REFRESH_REDUCE_SYSTEM_PROMPT = `You are Mason, merging a scoped refresh into an existing concept-to-files map.

Only a subset of the project's files was re-analyzed (they changed since the map was built). You receive the existing full map, the list of re-analyzed file paths, and partial concept maps derived from ONLY those files.

Respond with ONLY a JSON object: \`{"features": {...}, "flows": {...}}\` — the COMPLETE updated map. No markdown, no preamble.

Merge rules:
- Entries in the existing map that reference none of the re-analyzed files: copy them through UNCHANGED.
- Entries that reference re-analyzed files: update them using the partials — adjust descriptions, add new files, drop files that moved elsewhere.
- Merge partial features into existing features when they're the same product concept, even if named slightly differently ("auth" vs "authentication") — keep the existing name unless the new one is clearly more product-natural.
- Features whose files were all deleted or renamed away: remove them by omitting them from your output.
- Every file that appears in any partial MUST end up in some feature. Don't silently drop files.
- Do not invent or alter entries for files you haven't seen.`;

export function buildRefreshReducePrompt(
  existingMap: {
    features: Record<string, { description: string; files: string[]; tests?: string[] }>;
    flows: Record<string, { description: string; chain: string[] }>;
  },
  refreshedFiles: string[],
  partials: Array<{
    batchId: string;
    offset: number;
    features: Record<string, { description: string; files: string[]; tests?: string[] }>;
    flows: Record<string, { description: string; chain: string[] }>;
  }>
): string {
  return `Merge this scoped refresh into the existing concept map.

=== EXISTING MAP ===
${JSON.stringify(existingMap, null, 2)}

=== RE-ANALYZED FILES ===
${refreshedFiles.join("\n")}

=== PARTIALS (derived from the re-analyzed files only) ===
${JSON.stringify({ partials }, null, 2)}`;
}

