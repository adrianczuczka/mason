import { loadSnapshot } from "../snapshot/snapshot.js";
import type { MasonConfig, ConfluenceConfig } from "../llm/config.js";
import { createConfluenceClient, type ConfluenceClient } from "./client.js";
import {
  renderFeaturePage,
  renderIndexPage,
  renderChangelogPage,
  renderChangelogSection,
  mergeIntoExistingBody,
  splitWrappedBody,
  flowsForFeature,
  featurePageTitle,
} from "./renderer.js";
import {
  computeDiff,
  isMeaningfulDiff,
  loadSyncState,
  saveSyncState,
  snapshotMinimal,
  type SyncState,
} from "./diff.js";
import { rewriteForProduct, type RewriteResult } from "./rewrite.js";
import type { Snapshot } from "../snapshot/snapshot.js";

export interface SyncOptions {
  indexPageTitle?: string;
  changelogPageTitle?: string;
  featurePagePrefix?: string;
}

export interface SyncSummary {
  created: string[];
  updated: string[];
  unchanged: string[];
  indexPageId: string;
  changelogPageId: string;
  hadChanges: boolean;
}

export interface SyncDeps {
  client: ConfluenceClient;
  rewrite: (snapshot: Snapshot, config: MasonConfig) => Promise<RewriteResult>;
}

const DEFAULT_INDEX_TITLE = "Mason — System Map";
const DEFAULT_CHANGELOG_TITLE = "Mason — Changelog";
const DEFAULT_FEATURE_PREFIX = "Feature: ";

export async function exportToConfluence(
  rootDir: string,
  config: MasonConfig,
  options: SyncOptions = {},
  deps?: Partial<SyncDeps>
): Promise<SyncSummary> {
  const confluence = config.confluence;
  if (!confluence) {
    throw new Error(
      'No Confluence credentials configured. Run "mason set-confluence" first.'
    );
  }

  const snapshot = await loadSnapshot(rootDir);
  if (!snapshot) {
    throw new Error(
      'No snapshot found. Run "mason snapshot" first to build the concept map.'
    );
  }

  const client = deps?.client ?? createConfluenceClient(confluence);
  const rewrite = deps?.rewrite ?? rewriteForProduct;

  const indexTitle = options.indexPageTitle ?? DEFAULT_INDEX_TITLE;
  const changelogTitle = options.changelogPageTitle ?? DEFAULT_CHANGELOG_TITLE;
  const featurePrefix = options.featurePagePrefix ?? DEFAULT_FEATURE_PREFIX;

  const spaceId = await client.resolveSpaceId(confluence.spaceKey);
  const syncedAt = new Date().toISOString();
  const previousState = await loadSyncState(rootDir);

  const productLanguage = await rewrite(snapshot, config);

  // 1. Upsert index page (so feature pages can hang under it)
  const indexBody = renderIndexPage({
    featureTitles: Object.keys(snapshot.features),
    featurePrefix,
    syncedAt,
  });

  const indexPage = await upsertPage({
    client,
    spaceId,
    title: indexTitle,
    parentId: confluence.parentPageId,
    renderedBody: indexBody,
  });

  // 2. Upsert each feature page under the index
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const featurePageIds: Record<string, string> = {};

  for (const [name, entry] of Object.entries(snapshot.features)) {
    const title = featurePageTitle(featurePrefix, name);
    const productDescription =
      productLanguage.features[name] ?? entry.description;
    const relatedFlows = flowsForFeature(entry.files, snapshot.flows).map(
      (f) => ({
        name: f.name,
        description: productLanguage.flows[f.name] ?? f.description,
      })
    );

    const rendered = renderFeaturePage({
      name,
      productDescription,
      flowDescriptions: relatedFlows,
      syncedAt,
      indexPageTitle: indexTitle,
    });

    const result = await upsertPage({
      client,
      spaceId,
      title,
      parentId: indexPage.id,
      renderedBody: rendered.body,
    });

    featurePageIds[name] = result.id;
    if (result.outcome === "created") created.push(title);
    else if (result.outcome === "updated") updated.push(title);
    else unchanged.push(title);
  }

  // 3. Diff + changelog page
  const diff = computeDiff(previousState, snapshot, syncedAt);
  const hadChanges = previousState === null || isMeaningfulDiff(diff);

  const previousSections = previousState?.changelogSections ?? [];
  let newSections = previousSections;
  if (hadChanges) {
    const section = renderChangelogSection(diff);
    newSections = [section, ...previousSections].slice(0, 50);
  }

  const changelogBody = renderChangelogPage(newSections);
  const changelogPage = await upsertPage({
    client,
    spaceId,
    title: changelogTitle,
    parentId: indexPage.id,
    renderedBody: changelogBody,
  });

  // 4. Persist sync state
  const nextState: SyncState = {
    version: 1,
    syncedAt,
    pageIds: {
      index: indexPage.id,
      changelog: changelogPage.id,
      features: featurePageIds,
    },
    lastSnapshot: snapshotMinimal(snapshot),
    changelogSections: newSections,
  };
  await saveSyncState(rootDir, nextState);

  return {
    created,
    updated,
    unchanged,
    indexPageId: indexPage.id,
    changelogPageId: changelogPage.id,
    hadChanges,
  };
}

interface UpsertArgs {
  client: ConfluenceClient;
  spaceId: string;
  title: string;
  parentId?: string;
  renderedBody: string;
}

interface UpsertResult {
  id: string;
  outcome: "created" | "updated" | "unchanged";
}

async function upsertPage(args: UpsertArgs): Promise<UpsertResult> {
  const existing = await args.client.findPageByTitle(args.spaceId, args.title);

  if (!existing) {
    const page = await args.client.createPage({
      spaceId: args.spaceId,
      title: args.title,
      parentId: args.parentId,
      body: args.renderedBody,
    });
    return { id: page.id, outcome: "created" };
  }

  const regions = splitWrappedBody(args.renderedBody);
  const mergedBody = mergeIntoExistingBody(existing.body, regions);

  if (mergedBody === existing.body) {
    return { id: existing.id, outcome: "unchanged" };
  }

  const updated = await args.client.updatePage({
    id: existing.id,
    title: args.title,
    parentId: args.parentId,
    body: mergedBody,
    version: existing.version,
  });
  return { id: updated.id, outcome: "updated" };
}
