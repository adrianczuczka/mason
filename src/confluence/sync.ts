import { loadSnapshot } from "../snapshot/snapshot.js";
import type { MasonConfig, ConfluenceConfig } from "../llm/config.js";
import { createConfluenceClient, type ConfluenceClient } from "./client.js";
import {
  renderFeaturePage,
  renderIndexPage,
  renderChangelogPage,
  renderChangelogSection,
  flowsForFeature,
  featurePageTitle,
} from "./renderer.js";
import {
  computeDiff,
  isMeaningfulDiff,
  loadSyncState,
  saveSyncState,
  snapshotMinimal,
  hashDescription,
  type SyncState,
} from "./diff.js";
import {
  rewriteForProduct,
  type RewriteResult,
  type RewriteContext,
} from "./rewrite.js";
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
  rewrite: (
    snapshot: Snapshot,
    config: MasonConfig,
    ctx: RewriteContext
  ) => Promise<RewriteResult>;
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
  // Wall-clock time is used ONLY for the append-only changelog heading. Page
  // bodies carry no timestamp/hash, so a page is re-published only when its own
  // content (description/flows) changes — not on every unrelated commit.
  const syncedAt = new Date().toISOString();
  const previousState = await loadSyncState(rootDir);
  const previousHashes = previousState?.pageHashes ?? {};
  const nextHashes: Record<string, string> = {};

  const productLanguage = await rewrite(snapshot, config, {
    previousCache: previousState?.rewriteCache,
  });

  // 1. Upsert index page (so feature pages can hang under it)
  const indexBody = renderIndexPage({
    featureTitles: Object.keys(snapshot.features),
    featurePrefix,
  });

  const indexPage = await upsertPage({
    client,
    spaceId,
    title: indexTitle,
    parentId: confluence.parentPageId,
    renderedBody: indexBody,
    previousHash: previousHashes[indexTitle],
  });
  nextHashes[indexTitle] = indexPage.hash;

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
      indexPageTitle: indexTitle,
    });

    const result = await upsertPage({
      client,
      spaceId,
      title,
      parentId: indexPage.id,
      renderedBody: rendered.body,
      previousHash: previousHashes[title],
    });
    nextHashes[title] = result.hash;

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
    previousHash: previousHashes[changelogTitle],
  });
  nextHashes[changelogTitle] = changelogPage.hash;

  // 4. Persist sync state
  const nextState: SyncState = {
    version: 2,
    syncedAt,
    pageIds: {
      index: indexPage.id,
      changelog: changelogPage.id,
      features: featurePageIds,
    },
    lastSnapshot: snapshotMinimal(snapshot),
    changelogSections: newSections,
    rewriteCache: productLanguage.cache,
    pageHashes: nextHashes,
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
  /** Hash of the body we published for this page last sync, if any. */
  previousHash?: string;
}

interface UpsertResult {
  id: string;
  outcome: "created" | "updated" | "unchanged";
  /** Hash of the body published this sync — persist for next-run comparison. */
  hash: string;
}

async function upsertPage(args: UpsertArgs): Promise<UpsertResult> {
  const hash = hashDescription(args.renderedBody);
  const existing = await args.client.findPageByTitle(args.spaceId, args.title);

  if (!existing) {
    const page = await args.client.createPage({
      spaceId: args.spaceId,
      title: args.title,
      parentId: args.parentId,
      body: args.renderedBody,
    });
    return { id: page.id, outcome: "created", hash };
  }

  // Confluence re-serializes stored bodies (strips comments, re-encodes
  // entities, injects macro ids), so we can't compare against existing.body.
  // Compare our render hash to the hash we stored last sync instead. When it
  // matches, the page is already current — skip the write entirely.
  if (args.previousHash === hash) {
    return { id: existing.id, outcome: "unchanged", hash };
  }

  // Mason owns the whole page body: overwrite it wholesale.
  const updated = await args.client.updatePage({
    id: existing.id,
    title: args.title,
    parentId: args.parentId,
    body: args.renderedBody,
    version: existing.version,
  });
  return { id: updated.id, outcome: "updated", hash };
}
