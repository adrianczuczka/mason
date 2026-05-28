export const SNAPSHOT_SYSTEM_PROMPT = `You are Mason, a context engineering tool. You're given source files from a codebase. Your job is to create a concept-to-files map that helps an AI coding assistant instantly find the right files for any task.

Respond with ONLY a JSON object. No markdown, no explanation, no code fences. Just the raw JSON.

The JSON must have two keys: "features" and "flows".

"features" maps user-facing feature names or concepts to the files that implement them. Group files by what a developer would naturally ask about. Use plain language names ("home screen", not "HomeScreenModule").

"flows" maps data/action flows to ordered chains of files showing how data moves through the system. These help when someone asks "what happens when X?"

Example output:
{
  "features": {
    "user authentication": {
      "description": "Login, signup, token refresh, and session management",
      "files": ["src/services/AuthService.ts", "src/middleware/AuthMiddleware.ts", "src/models/User.ts", "src/routes/auth.ts"],
      "tests": ["tests/auth.test.ts"]
    },
    "payment processing": {
      "description": "Stripe integration for subscriptions and one-time payments",
      "files": ["src/services/PaymentService.ts", "src/webhooks/stripe.ts", "src/models/Subscription.ts"],
      "tests": ["tests/payment.test.ts"]
    }
  },
  "flows": {
    "user login": {
      "description": "User submits credentials, gets JWT token",
      "chain": ["src/routes/auth.ts", "src/services/AuthService.ts", "src/models/User.ts"]
    },
    "process payment": {
      "description": "User initiates payment, Stripe charges card, webhook confirms",
      "chain": ["src/routes/payment.ts", "src/services/PaymentService.ts", "src/webhooks/stripe.ts"]
    }
  }
}

Rules:
- Use the FULL relative file paths exactly as given in the input
- Group by what a human would naturally ask about, not by technical structure
- Each feature should have 2-8 files — not too granular, not too broad
- Flows should show the actual call chain order
- Include test files in the "tests" field when they exist
- Cover ALL the files you're given — don't skip any`;

export function buildSnapshotPrompt(
  files: Array<{ path: string; content: string }>,
  testPairs?: Array<{ test: string; source: string; confidence: string }>
): string {
  const fileBlocks = files
    .map(
      (f) =>
        `=== ${f.path} ===\n${f.content.slice(0, 3000)}${f.content.length > 3000 ? "\n... (truncated)" : ""}`
    )
    .join("\n\n");

  let prompt = `Create a concept-to-files map for this codebase. Here are the key source files:\n\n${fileBlocks}`;

  if (testPairs && testPairs.length > 0) {
    const testBlock = testPairs
      .map((p) => `${p.test} → ${p.source}`)
      .join("\n");
    prompt += `\n\nHere are the test-to-source file mappings. Use these to populate the "tests" field for each feature:\n\n${testBlock}`;
  }

  return prompt;
}

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

export function buildIncrementalPrompt(
  files: Array<{ path: string; content: string }>,
  existingSnapshot: { features: Record<string, unknown>; flows: Record<string, unknown> }
): string {
  const fileBlocks = files
    .map(
      (f) =>
        `=== ${f.path} ===\n${f.content.slice(0, 3000)}${f.content.length > 3000 ? "\n... (truncated)" : ""}`
    )
    .join("\n\n");

  return `Here is the existing concept map for this project:
${JSON.stringify(existingSnapshot, null, 2)}

These files have been added or changed. Update the concept map to incorporate them. Return the FULL updated map (not just the changes).

Changed/new files:
${fileBlocks}`;
}
