import type { FeatureEntry, FlowEntry } from "../snapshot/snapshot.js";

export const SENTINEL_PREFIX = "mason:";

export type SentinelKey =
  | "overview"
  | "flows"
  | "index-body"
  | "changelog-entries";

export function startSentinel(key: SentinelKey): string {
  return `<!-- ${SENTINEL_PREFIX}start:${key} -->`;
}

export function endSentinel(key: SentinelKey): string {
  return `<!-- ${SENTINEL_PREFIX}end:${key} -->`;
}

function wrap(key: SentinelKey, content: string): string {
  return `${startSentinel(key)}\n${content}\n${endSentinel(key)}`;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function infoPanel(text: string): string {
  return (
    `<ac:structured-macro ac:name="info"><ac:rich-text-body>` +
    `<p>${escape(text)}</p>` +
    `</ac:rich-text-body></ac:structured-macro>`
  );
}

export function featurePageTitle(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

export interface RenderedFeaturePage {
  body: string;
  title: string;
}

export interface RenderFeaturePageOptions {
  name: string;
  productDescription: string;
  flowDescriptions: Array<{ name: string; description: string }>;
  syncedAt: string;
  indexPageTitle: string;
}

export function renderFeaturePage(
  options: RenderFeaturePageOptions
): RenderedFeaturePage {
  const overviewBody =
    `<h2>What it does</h2>` +
    `<p>${escape(options.productDescription)}</p>` +
    infoPanel(
      `Auto-synced from code by Mason on ${options.syncedAt}. ` +
        `Content between mason:start/end markers is overwritten on each sync — ` +
        `edits outside those regions are preserved.`
    );

  const flowsBody = options.flowDescriptions.length
    ? `<h2>How it fits in</h2><ul>` +
      options.flowDescriptions
        .map(
          (f) =>
            `<li><strong>${escape(f.name)}</strong> — ${escape(f.description)}</li>`
        )
        .join("") +
      `</ul>`
    : `<h2>How it fits in</h2><p><em>No related flows recorded yet.</em></p>`;

  const body =
    wrap("overview", overviewBody) +
    `\n` +
    wrap("flows", flowsBody) +
    `\n<p><a href="" data-mason-index-link="true">Back to ${escape(options.indexPageTitle)}</a></p>`;

  return {
    title: options.name,
    body,
  };
}

export interface RenderIndexPageOptions {
  featureTitles: string[];
  featurePrefix: string;
  syncedAt: string;
}

export function renderIndexPage(options: RenderIndexPageOptions): string {
  if (options.featureTitles.length === 0) {
    return wrap(
      "index-body",
      infoPanel("No features in the snapshot yet.")
    );
  }

  const list =
    `<h2>Features</h2><ul>` +
    options.featureTitles
      .map((name) => {
        const pageTitle = featurePageTitle(options.featurePrefix, name);
        return (
          `<li><ac:link><ri:page ri:content-title="${escape(pageTitle)}"/>` +
          `<ac:plain-text-link-body><![CDATA[${name}]]></ac:plain-text-link-body>` +
          `</ac:link></li>`
        );
      })
      .join("") +
    `</ul>`;

  const banner = infoPanel(
    `Last synced from code on ${options.syncedAt}. Maintained automatically by Mason.`
  );

  return wrap("index-body", banner + list);
}

export interface DiffSection {
  syncedAt: string;
  addedFeatures: string[];
  removedFeatures: string[];
  changedFeatures: string[];
  addedFlows: string[];
  removedFlows: string[];
}

export function renderChangelogSection(section: DiffSection): string {
  const segments: string[] = [];
  if (section.addedFeatures.length) {
    segments.push(
      `<p><strong>Added features:</strong> ${section.addedFeatures.map(escape).join(", ")}</p>`
    );
  }
  if (section.removedFeatures.length) {
    segments.push(
      `<p><strong>Removed features:</strong> ${section.removedFeatures.map(escape).join(", ")}</p>`
    );
  }
  if (section.changedFeatures.length) {
    segments.push(
      `<p><strong>Updated features:</strong> ${section.changedFeatures.map(escape).join(", ")}</p>`
    );
  }
  if (section.addedFlows.length) {
    segments.push(
      `<p><strong>Added flows:</strong> ${section.addedFlows.map(escape).join(", ")}</p>`
    );
  }
  if (section.removedFlows.length) {
    segments.push(
      `<p><strong>Removed flows:</strong> ${section.removedFlows.map(escape).join(", ")}</p>`
    );
  }
  if (segments.length === 0) {
    segments.push(`<p><em>No meaningful changes detected.</em></p>`);
  }

  return (
    `<h3>${escape(section.syncedAt)}</h3>` + segments.join("")
  );
}

export function renderChangelogPage(sections: string[]): string {
  if (sections.length === 0) {
    return wrap(
      "changelog-entries",
      `<p><em>No sync has run yet.</em></p>`
    );
  }
  // Newest first
  return wrap("changelog-entries", sections.join("\n<hr/>\n"));
}

export function replaceSentinelRegion(
  existingBody: string,
  key: SentinelKey,
  newRegion: string
): string {
  const start = startSentinel(key);
  const end = endSentinel(key);
  const startIdx = existingBody.indexOf(start);
  const endIdx = existingBody.indexOf(end);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    // No existing region — append the new region at the end
    const sep = existingBody.length && !existingBody.endsWith("\n") ? "\n" : "";
    return existingBody + sep + newRegion;
  }

  const before = existingBody.slice(0, startIdx);
  const after = existingBody.slice(endIdx + end.length);
  return before + newRegion + after;
}

export function mergeIntoExistingBody(
  existingBody: string,
  regions: Array<{ key: SentinelKey; content: string }>
): string {
  let merged = existingBody;
  for (const { key, content } of regions) {
    merged = replaceSentinelRegion(merged, key, content);
  }
  return merged;
}

export function splitWrappedBody(rendered: string): Array<{
  key: SentinelKey;
  content: string;
}> {
  const keys: SentinelKey[] = [
    "overview",
    "flows",
    "index-body",
    "changelog-entries",
  ];
  const regions: Array<{ key: SentinelKey; content: string }> = [];
  for (const key of keys) {
    const start = startSentinel(key);
    const end = endSentinel(key);
    const startIdx = rendered.indexOf(start);
    const endIdx = rendered.indexOf(end);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      regions.push({
        key,
        content: rendered.slice(startIdx, endIdx + end.length),
      });
    }
  }
  return regions;
}

export type FeatureMap = Record<string, FeatureEntry>;
export type FlowMap = Record<string, FlowEntry>;

export function flowsForFeature(
  featureFiles: string[],
  flows: FlowMap
): Array<{ name: string; description: string }> {
  const fileSet = new Set(featureFiles);
  const result: Array<{ name: string; description: string }> = [];
  for (const [name, flow] of Object.entries(flows)) {
    if (flow.chain.some((file) => fileSet.has(file))) {
      result.push({ name, description: flow.description });
    }
  }
  return result;
}
