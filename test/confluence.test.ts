import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  renderFeaturePage,
  renderIndexPage,
  renderChangelogPage,
  renderChangelogSection,
  mergeIntoExistingBody,
  splitWrappedBody,
  replaceSentinelRegion,
  startSentinel,
  endSentinel,
} from "../src/confluence/renderer.js";
import {
  computeDiff,
  isMeaningfulDiff,
  loadSyncState,
  saveSyncState,
  snapshotMinimal,
  type SyncState,
} from "../src/confluence/diff.js";
import { exportToConfluence } from "../src/confluence/sync.js";
import type { RewriteResult } from "../src/confluence/rewrite.js";
import { createConfluenceClient } from "../src/confluence/client.js";
import { normalizeAtlassianBaseUrl } from "../src/confluence/url.js";
import {
  masonSetConfluence,
  exportToConfluenceTool,
  masonCompleteInit,
} from "../src/mcp/tools.js";
import type { Snapshot } from "../src/snapshot/snapshot.js";
import type { MasonConfig } from "../src/llm/config.js";
import type {
  ConfluenceClient,
  ConfluencePage,
  CreatePageInput,
  UpdatePageInput,
} from "../src/confluence/client.js";

function snapshot(features: Snapshot["features"], flows: Snapshot["flows"]): Snapshot {
  return {
    version: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    gitHash: "abc123",
    features,
    flows,
  };
}

function buildFakeClient(): {
  client: ConfluenceClient;
  pages: Map<string, ConfluencePage>;
  calls: { create: number; update: number };
} {
  const pages = new Map<string, ConfluencePage>();
  const calls = { create: 0, update: 0 };
  let idCounter = 100;

  const client: ConfluenceClient = {
    async resolveSpaceId(spaceKey: string) {
      return `space-${spaceKey}`;
    },
    async findPageByTitle(_spaceId: string, title: string) {
      return pages.get(title) ?? null;
    },
    async createPage(input: CreatePageInput) {
      calls.create++;
      const id = `id-${idCounter++}`;
      const page: ConfluencePage = {
        id,
        title: input.title,
        version: 1,
        body: input.body,
        parentId: input.parentId,
      };
      pages.set(input.title, page);
      return page;
    },
    async updatePage(input: UpdatePageInput) {
      calls.update++;
      const existing = Array.from(pages.values()).find((p) => p.id === input.id);
      if (!existing) throw new Error(`page not found: ${input.id}`);
      const updated: ConfluencePage = {
        id: input.id,
        title: input.title,
        version: input.version + 1,
        body: input.body,
        parentId: input.parentId,
      };
      // Remove old title mapping if title changed
      for (const [k, v] of Array.from(pages.entries())) {
        if (v.id === input.id) pages.delete(k);
      }
      pages.set(input.title, updated);
      return updated;
    },
  };

  return { client, pages, calls };
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mason-confluence-test-"));
}

const baseConfig: MasonConfig = {
  provider: "claude",
  confluence: {
    baseUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "secret-token",
    spaceKey: "DOCS",
    parentPageId: "root-1",
  },
};

describe("Confluence renderer", () => {
  it("wraps overview and flows in sentinel comments", () => {
    const rendered = renderFeaturePage({
      name: "Checkout",
      productDescription: "Lets shoppers pay for their cart.",
      flowDescriptions: [
        { name: "Place order", description: "Customer confirms a basket and pays." },
      ],
      syncedAt: "2026-05-27T10:00:00Z",
      indexPageTitle: "System Map",
    });

    expect(rendered.body).toContain(startSentinel("overview"));
    expect(rendered.body).toContain(endSentinel("overview"));
    expect(rendered.body).toContain(startSentinel("flows"));
    expect(rendered.body).toContain(endSentinel("flows"));
    expect(rendered.body).toContain("Lets shoppers pay for their cart.");
    expect(rendered.body).toContain("Place order");
  });

  it("replaceSentinelRegion preserves content outside the region", () => {
    const existing =
      `<p>Hand-written intro.</p>\n` +
      `${startSentinel("overview")}\n<p>old</p>\n${endSentinel("overview")}\n` +
      `<p>Hand-written outro.</p>`;
    const merged = replaceSentinelRegion(
      existing,
      "overview",
      `${startSentinel("overview")}\n<p>new</p>\n${endSentinel("overview")}`
    );
    expect(merged).toContain("<p>Hand-written intro.</p>");
    expect(merged).toContain("<p>Hand-written outro.</p>");
    expect(merged).toContain("<p>new</p>");
    expect(merged).not.toContain("<p>old</p>");
  });

  it("mergeIntoExistingBody updates multiple regions independently", () => {
    const existing =
      `<p>Custom note.</p>\n` +
      `${startSentinel("overview")}\nA\n${endSentinel("overview")}\n` +
      `<p>Middle hand-written.</p>\n` +
      `${startSentinel("flows")}\nB\n${endSentinel("flows")}`;

    const regions = [
      { key: "overview" as const, content: `${startSentinel("overview")}\nA2\n${endSentinel("overview")}` },
      { key: "flows" as const, content: `${startSentinel("flows")}\nB2\n${endSentinel("flows")}` },
    ];
    const merged = mergeIntoExistingBody(existing, regions);

    expect(merged).toContain("<p>Custom note.</p>");
    expect(merged).toContain("<p>Middle hand-written.</p>");
    expect(merged).toContain("A2");
    expect(merged).toContain("B2");
    expect(merged).not.toContain("\nA\n");
    expect(merged).not.toContain("\nB\n");
  });

  it("splitWrappedBody extracts only present regions", () => {
    const body = renderIndexPage({
      featureTitles: ["A", "B"],
      featurePrefix: "Feature: ",
      syncedAt: "2026-05-27T10:00:00Z",
    });
    const regions = splitWrappedBody(body);
    expect(regions.length).toBe(1);
    expect(regions[0].key).toBe("index-body");
  });
});

describe("Confluence diff", () => {
  it("returns all features as added on first sync", () => {
    const snap = snapshot(
      {
        Checkout: { description: "x", files: ["a.ts"] },
        Auth: { description: "y", files: ["b.ts"] },
      },
      {}
    );
    const diff = computeDiff(null, snap, "2026-05-27T10:00:00Z");
    expect(diff.addedFeatures.sort()).toEqual(["Auth", "Checkout"]);
    expect(diff.removedFeatures).toEqual([]);
    expect(isMeaningfulDiff(diff)).toBe(true);
  });

  it("detects added, removed, and changed features", () => {
    const prev: SyncState = {
      version: 1,
      syncedAt: "2026-05-01T00:00:00Z",
      pageIds: { features: {} },
      lastSnapshot: {
        features: {
          Checkout: { description: "old desc" },
          Auth: { description: "y" },
        },
        flows: {},
      },
      changelogSections: [],
    };
    const next = snapshot(
      {
        Checkout: { description: "new desc", files: ["a.ts"] },
        Search: { description: "z", files: ["c.ts"] },
      },
      {}
    );
    const diff = computeDiff(prev, next, "2026-05-27T10:00:00Z");
    expect(diff.addedFeatures).toEqual(["Search"]);
    expect(diff.removedFeatures).toEqual(["Auth"]);
    expect(diff.changedFeatures).toEqual(["Checkout"]);
  });

  it("isMeaningfulDiff is false when nothing changed", () => {
    const prev: SyncState = {
      version: 1,
      syncedAt: "2026-05-01T00:00:00Z",
      pageIds: { features: {} },
      lastSnapshot: {
        features: { Checkout: { description: "x" } },
        flows: {},
      },
      changelogSections: [],
    };
    const next = snapshot(
      { Checkout: { description: "x", files: ["a.ts"] } },
      {}
    );
    const diff = computeDiff(prev, next, "2026-05-27T10:00:00Z");
    expect(isMeaningfulDiff(diff)).toBe(false);
  });

  it("renderChangelogSection produces non-empty XHTML for an added feature", () => {
    const section = renderChangelogSection({
      syncedAt: "2026-05-27T10:00:00Z",
      addedFeatures: ["Checkout"],
      removedFeatures: [],
      changedFeatures: [],
      addedFlows: [],
      removedFlows: [],
    });
    expect(section).toContain("Checkout");
    expect(section).toContain("Added features");
  });
});

describe("Confluence sync (end-to-end with fake client)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Identity rewrite: keep original descriptions, skip LLM entirely.
  const identityRewrite = async (snap: Snapshot): Promise<RewriteResult> => ({
    features: Object.fromEntries(
      Object.entries(snap.features).map(([k, v]) => [k, v.description])
    ),
    flows: Object.fromEntries(
      Object.entries(snap.flows).map(([k, v]) => [k, v.description])
    ),
  });

  async function writeSnapshot(snap: Snapshot): Promise<void> {
    const dir = path.join(tmp, ".mason");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "snapshot.json"),
      JSON.stringify(snap, null, 2),
      "utf-8"
    );
  }

  it("creates index, feature, and changelog pages on first sync", async () => {
    await writeSnapshot(
      snapshot(
        {
          Checkout: {
            description: "Cart checkout flow",
            files: ["src/checkout.ts"],
          },
          Auth: {
            description: "User login",
            files: ["src/auth.ts"],
          },
        },
        {
          "Place order": {
            description: "User pays for their cart",
            chain: ["src/checkout.ts"],
          },
        }
      )
    );

    const fake = buildFakeClient();
    const summary = await exportToConfluence(
      tmp,
      baseConfig,
      {},
      { client: fake.client, rewrite: identityRewrite }
    );

    expect(summary.created.sort()).toEqual([
      "Feature: Auth",
      "Feature: Checkout",
    ]);
    expect(summary.hadChanges).toBe(true);
    expect(fake.pages.has("Mason — System Map")).toBe(true);
    expect(fake.pages.has("Mason — Changelog")).toBe(true);
    expect(fake.pages.has("Feature: Checkout")).toBe(true);

    const checkoutPage = fake.pages.get("Feature: Checkout")!;
    expect(checkoutPage.body).toContain("Cart checkout flow");
    expect(checkoutPage.body).toContain("Place order");
  });

  it("preserves hand-edits outside sentinels on the second sync", async () => {
    await writeSnapshot(
      snapshot(
        {
          Checkout: {
            description: "First version",
            files: ["src/checkout.ts"],
          },
        },
        {}
      )
    );

    const fake = buildFakeClient();
    await exportToConfluence(tmp, baseConfig, {}, { client: fake.client, rewrite: identityRewrite });

    // Simulate a hand-edit on the feature page (outside sentinels)
    const checkout = fake.pages.get("Feature: Checkout")!;
    checkout.body =
      `<p>PM note: must integrate with billing by EOQ.</p>\n` + checkout.body;

    // Update snapshot (description change → triggers update)
    await writeSnapshot(
      snapshot(
        {
          Checkout: {
            description: "Second version",
            files: ["src/checkout.ts"],
          },
        },
        {}
      )
    );

    await exportToConfluence(tmp, baseConfig, {}, { client: fake.client, rewrite: identityRewrite });

    const afterSync = fake.pages.get("Feature: Checkout")!;
    expect(afterSync.body).toContain(
      "<p>PM note: must integrate with billing by EOQ.</p>"
    );
    expect(afterSync.body).toContain("Second version");
    expect(afterSync.body).not.toContain("First version");
    expect(afterSync.version).toBeGreaterThan(1);
  });

  it("appends a changelog section when the snapshot changes", async () => {
    await writeSnapshot(
      snapshot(
        {
          Checkout: { description: "x", files: ["src/checkout.ts"] },
        },
        {}
      )
    );

    const fake = buildFakeClient();
    await exportToConfluence(tmp, baseConfig, {}, { client: fake.client, rewrite: identityRewrite });
    const firstChangelogBody = fake.pages.get("Mason — Changelog")!.body;

    // Add a new feature
    await writeSnapshot(
      snapshot(
        {
          Checkout: { description: "x", files: ["src/checkout.ts"] },
          Auth: { description: "new", files: ["src/auth.ts"] },
        },
        {}
      )
    );

    const summary = await exportToConfluence(
      tmp,
      baseConfig,
      {},
      { client: fake.client, rewrite: identityRewrite }
    );
    expect(summary.hadChanges).toBe(true);

    const secondChangelogBody = fake.pages.get("Mason — Changelog")!.body;
    expect(secondChangelogBody.length).toBeGreaterThan(firstChangelogBody.length);
    expect(secondChangelogBody).toContain("Auth");
  });

  it("reports unchanged when re-running with no snapshot changes", async () => {
    await writeSnapshot(
      snapshot(
        {
          Checkout: { description: "x", files: ["src/checkout.ts"] },
        },
        {}
      )
    );

    const fake = buildFakeClient();
    await exportToConfluence(tmp, baseConfig, {}, { client: fake.client, rewrite: identityRewrite });
    const summary = await exportToConfluence(
      tmp,
      baseConfig,
      {},
      { client: fake.client, rewrite: identityRewrite }
    );

    expect(summary.created).toEqual([]);
    expect(summary.hadChanges).toBe(false);
  });
});

describe("Confluence REST client (fetch wiring)", () => {
  it("sends Basic auth and v2 path for create", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: typeof fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return new Response(
        JSON.stringify({
          id: "page-1",
          title: "Hi",
          version: { number: 1 },
          body: { storage: { value: "<p>x</p>" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const client = createConfluenceClient(
      {
        baseUrl: "https://example.atlassian.net",
        email: "user@example.com",
        apiToken: "tok",
        spaceKey: "DOCS",
      },
      fetchFn
    );

    await client.createPage({
      spaceId: "abc",
      title: "Hi",
      body: "<p>x</p>",
    });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://example.atlassian.net/wiki/api/v2/pages");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      "Basic " + Buffer.from("user@example.com:tok").toString("base64")
    );
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.spaceId).toBe("abc");
    expect(body.title).toBe("Hi");
    expect(body.body.representation).toBe("storage");
  });

  it("increments version on update", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: typeof fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return new Response(
        JSON.stringify({
          id: "page-1",
          title: "Hi",
          version: { number: 3 },
          body: { storage: { value: "<p>new</p>" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const client = createConfluenceClient(
      {
        baseUrl: "https://example.atlassian.net",
        email: "user@example.com",
        apiToken: "tok",
        spaceKey: "DOCS",
      },
      fetchFn
    );

    await client.updatePage({
      id: "page-1",
      title: "Hi",
      body: "<p>new</p>",
      version: 2,
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.version.number).toBe(3);
    expect(calls[0].url).toBe(
      "https://example.atlassian.net/wiki/api/v2/pages/page-1"
    );
    expect(calls[0].init.method).toBe("PUT");
  });

  it("loadSyncState / saveSyncState roundtrip persists changelog sections", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mason-cf-state-"));
    try {
      const state: SyncState = {
        version: 1,
        syncedAt: "2026-05-27T10:00:00Z",
        pageIds: {
          index: "i",
          changelog: "c",
          features: { Checkout: "id-1" },
        },
        lastSnapshot: snapshotMinimal(
          snapshot({ Checkout: { description: "x", files: [] } }, {})
        ),
        changelogSections: ["<h3>first</h3>"],
      };
      await saveSyncState(tmp, state);
      const loaded = await loadSyncState(tmp);
      expect(loaded).toEqual(state);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("Confluence URL helper + client", () => {
  describe("normalizeAtlassianBaseUrl", () => {
    it("accepts a full https URL unchanged (trims trailing slash)", () => {
      expect(normalizeAtlassianBaseUrl("https://acme.atlassian.net/")).toBe(
        "https://acme.atlassian.net"
      );
    });

    it("upgrades a bare hostname to https", () => {
      expect(normalizeAtlassianBaseUrl("acme.atlassian.net")).toBe(
        "https://acme.atlassian.net"
      );
    });

    it("expands a bare subdomain into atlassian.net", () => {
      expect(normalizeAtlassianBaseUrl("acme")).toBe("https://acme.atlassian.net");
    });

    it("trims whitespace", () => {
      expect(normalizeAtlassianBaseUrl("  acme  ")).toBe("https://acme.atlassian.net");
    });

    it("preserves http for self-hosted Confluence", () => {
      expect(normalizeAtlassianBaseUrl("http://wiki.internal:8090")).toBe(
        "http://wiki.internal:8090"
      );
    });

    it("rejects empty input", () => {
      expect(() => normalizeAtlassianBaseUrl("   ")).toThrow();
    });
  });

  describe("listSpaces / listRootPages (fetch wiring)", () => {
    it("listSpaces follows pagination cursors", async () => {
      const pages = [
        {
          results: [{ id: "1", key: "A", name: "Alpha" }],
          _links: { next: "/wiki/api/v2/spaces?cursor=2" },
        },
        {
          results: [{ id: "2", key: "B", name: "Beta" }],
          _links: {},
        },
      ];
      const calls: string[] = [];
      const fetchFn: typeof fetch = (async (url: string) => {
        calls.push(url.toString());
        const page = pages.shift();
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = createConfluenceClient(
        {
          baseUrl: "https://example.atlassian.net",
          email: "u@e.com",
          apiToken: "tok",
          spaceKey: "",
        },
        fetchFn
      );

      const spaces = await client.listSpaces();
      expect(spaces).toEqual([
        { id: "1", key: "A", name: "Alpha" },
        { id: "2", key: "B", name: "Beta" },
      ]);
      expect(calls).toEqual([
        "https://example.atlassian.net/wiki/api/v2/spaces?limit=100",
        "https://example.atlassian.net/wiki/api/v2/spaces?cursor=2",
      ]);
    });

    it("listRootPages targets the depth=root pages endpoint", async () => {
      const fetched: string[] = [];
      const fetchFn: typeof fetch = (async (url: string) => {
        fetched.push(url.toString());
        return new Response(
          JSON.stringify({
            results: [
              { id: "p1", title: "Engineering" },
              { id: "p2", title: "Product" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as unknown as typeof fetch;

      const client = createConfluenceClient(
        {
          baseUrl: "https://example.atlassian.net",
          email: "u@e.com",
          apiToken: "tok",
          spaceKey: "",
        },
        fetchFn
      );

      const pages = await client.listRootPages("space-1");
      expect(pages).toEqual([
        { id: "p1", title: "Engineering" },
        { id: "p2", title: "Product" },
      ]);
      expect(fetched[0]).toBe(
        "https://example.atlassian.net/wiki/api/v2/spaces/space-1/pages?depth=root&limit=50"
      );
    });
  });
});

describe("Confluence MCP tools", () => {
  let originalHome: string | undefined;
  let fakeHome: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "mason-confl-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    globalThis.fetch = originalFetch;
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  function stubFetch(handler: (url: string, init: RequestInit) => Response) {
    globalThis.fetch = (async (url: string, init: RequestInit) =>
      handler(url.toString(), init)) as unknown as typeof fetch;
  }

  describe("masonSetConfluence", () => {
    it("normalizes a bare subdomain and lists spaces on first call", async () => {
      stubFetch(() =>
        new Response(
          JSON.stringify({
            results: [
              { id: "s1", key: "DOCS", name: "Documentation" },
              { id: "s2", key: "ENG", name: "Engineering" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const raw = await masonSetConfluence({
        baseUrl: "acme",
        email: "u@e.com",
        apiToken: "tok",
      });
      const data = JSON.parse(raw);

      expect(data.status).toBe("spaces_listed");
      expect(data.baseUrl).toBe("https://acme.atlassian.net");
      expect(data.spaces).toEqual([
        { key: "DOCS", name: "Documentation" },
        { key: "ENG", name: "Engineering" },
      ]);
    });

    it("persists credentials on second call when spaceKey matches", async () => {
      stubFetch(() =>
        new Response(
          JSON.stringify({
            results: [{ id: "s1", key: "DOCS", name: "Documentation" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const raw = await masonSetConfluence({
        baseUrl: "acme",
        email: "u@e.com",
        apiToken: "tok",
        spaceKey: "DOCS",
      });
      const data = JSON.parse(raw);

      expect(data.status).toBe("saved");
      expect(data.spaceKey).toBe("DOCS");
      expect(data.spaceName).toBe("Documentation");

      const configPath = path.join(fakeHome, ".mason", "config.json");
      const stored = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(stored.confluence).toEqual({
        baseUrl: "https://acme.atlassian.net",
        email: "u@e.com",
        apiToken: "tok",
        spaceKey: "DOCS",
        parentPageId: undefined,
      });
    });

    it("rejects an unknown spaceKey with a helpful error", async () => {
      stubFetch(() =>
        new Response(
          JSON.stringify({
            results: [{ id: "s1", key: "DOCS", name: "Documentation" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const raw = await masonSetConfluence({
        baseUrl: "acme",
        email: "u@e.com",
        apiToken: "tok",
        spaceKey: "BOGUS",
      });
      const data = JSON.parse(raw);

      expect(data.status).toBe("error");
      expect(data.error).toMatch(/Space key "BOGUS" was not found/);
      expect(data.error).toMatch(/DOCS/);
    });

    it("surfaces 401 as a friendly error", async () => {
      stubFetch(
        () =>
          new Response("Unauthorized", {
            status: 401,
            statusText: "Unauthorized",
          })
      );

      const raw = await masonSetConfluence({
        baseUrl: "acme",
        email: "u@e.com",
        apiToken: "bad",
      });
      const data = JSON.parse(raw);

      expect(data.status).toBe("error");
      expect(data.error).toMatch(/Credentials rejected/);
    });

    it("rejects obviously bad input early", async () => {
      const bad1 = JSON.parse(
        await masonSetConfluence({ baseUrl: "", email: "u@e.com", apiToken: "tok" })
      );
      expect(bad1.status).toBe("error");

      const bad2 = JSON.parse(
        await masonSetConfluence({ baseUrl: "acme", email: "no-at-sign", apiToken: "tok" })
      );
      expect(bad2.status).toBe("error");
      expect(bad2.error).toMatch(/Email/);

      const bad3 = JSON.parse(
        await masonSetConfluence({ baseUrl: "acme", email: "u@e.com", apiToken: "   " })
      );
      expect(bad3.status).toBe("error");
      expect(bad3.error).toMatch(/API token/);
    });
  });

  describe("exportToConfluenceTool", () => {
    it("refuses to run on un-initialized projects", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mason-export-test-"));
      try {
        const raw = await exportToConfluenceTool(tmp);
        const data = JSON.parse(raw);
        expect(data.initialized).toBe(false);
        expect(data.hint).toMatch(/mason_init/);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("errors clearly when initialized but no Confluence creds configured", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mason-export-test-"));
      try {
        await masonCompleteInit(tmp);
        const raw = await exportToConfluenceTool(tmp);
        const data = JSON.parse(raw);
        expect(data.status).toBe("error");
        expect(data.error).toMatch(/No Confluence credentials/);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
