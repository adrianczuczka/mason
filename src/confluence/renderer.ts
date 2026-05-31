import type { FeatureEntry, FlowEntry } from "../snapshot/snapshot.js";

// Mason fully owns each page body and overwrites it on every sync. Confluence
// strips HTML comments and re-serializes storage XHTML, so in-page region
// markers can't survive a round-trip — no-op detection happens via a content
// hash in the local sync state instead (see sync.ts / diff.ts).

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
  indexPageTitle: string;
}

export function renderFeaturePage(
  options: RenderFeaturePageOptions
): RenderedFeaturePage {
  const overviewBody =
    `<h2>What it does</h2>` + `<p>${escape(options.productDescription)}</p>`;

  // Only render "How it fits in" when there are flows — an empty section with a
  // "nothing here" placeholder reads as unfinished.
  const flowsBody = options.flowDescriptions.length
    ? `<h2>How it fits in</h2><ul>` +
      options.flowDescriptions
        .map(
          (f) =>
            `<li><strong>${escape(f.name)}</strong> — ${escape(f.description)}</li>`
        )
        .join("") +
      `</ul>`
    : "";

  // Native Confluence page link, resolved by title.
  const navBody =
    `<p><ac:link><ri:page ri:content-title="${escape(options.indexPageTitle)}"/>` +
    `<ac:plain-text-link-body><![CDATA[Back to ${options.indexPageTitle}]]></ac:plain-text-link-body>` +
    `</ac:link></p>`;

  // Provenance note as a footer, not wedged between the content sections.
  const footer = infoPanel(
    `Generated from code by Mason. This page is overwritten on each sync — ` +
      `edit the code, not the page.`
  );

  const body = overviewBody + flowsBody + navBody + footer;

  return {
    title: options.name,
    body,
  };
}

export interface RenderIndexPageOptions {
  featureTitles: string[];
  featurePrefix: string;
}

export function renderIndexPage(options: RenderIndexPageOptions): string {
  if (options.featureTitles.length === 0) {
    return infoPanel("No features in the snapshot yet.");
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
    `Generated from code by Mason. Maintained automatically — edit the code, not this page.`
  );

  return banner + list;
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
    return `<p><em>No sync has run yet.</em></p>`;
  }
  // Newest first
  return sections.join("\n<hr/>\n");
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
