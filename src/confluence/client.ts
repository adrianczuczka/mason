import type { ConfluenceConfig } from "../llm/config.js";

export interface ConfluencePage {
  id: string;
  title: string;
  version: number;
  body: string;
  parentId?: string;
}

export interface CreatePageInput {
  spaceId: string;
  title: string;
  body: string;
  parentId?: string;
}

export interface UpdatePageInput {
  id: string;
  title: string;
  body: string;
  version: number;
  parentId?: string;
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
}

export interface ConfluenceRootPage {
  id: string;
  title: string;
}

export interface ConfluenceClient {
  resolveSpaceId(spaceKey: string): Promise<string>;
  listSpaces(): Promise<ConfluenceSpace[]>;
  listRootPages(spaceId: string): Promise<ConfluenceRootPage[]>;
  findPageByTitle(spaceId: string, title: string): Promise<ConfluencePage | null>;
  createPage(input: CreatePageInput): Promise<ConfluencePage>;
  updatePage(input: UpdatePageInput): Promise<ConfluencePage>;
}

interface PageApiResponse {
  id: string;
  title: string;
  parentId?: string;
  version?: { number: number };
  body?: { storage?: { value?: string } };
}

export function createConfluenceClient(
  config: ConfluenceConfig,
  fetchFn: typeof fetch = fetch
): ConfluenceClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const auth =
    "Basic " +
    Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");

  async function call(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Confluence ${method} ${path} failed: ${res.status} ${res.statusText} — ${text}`
      );
    }

    if (res.status === 204) return null;
    return res.json();
  }

  function toPage(raw: PageApiResponse): ConfluencePage {
    return {
      id: raw.id,
      title: raw.title,
      version: raw.version?.number ?? 1,
      body: raw.body?.storage?.value ?? "",
      parentId: raw.parentId,
    };
  }

  return {
    async resolveSpaceId(spaceKey: string): Promise<string> {
      const res = (await call(
        "GET",
        `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`
      )) as { results?: Array<{ id: string; key: string }> };
      const space = res.results?.find((s) => s.key === spaceKey);
      if (!space) {
        throw new Error(`Confluence space not found: ${spaceKey}`);
      }
      return space.id;
    },

    async listSpaces(): Promise<ConfluenceSpace[]> {
      const all: ConfluenceSpace[] = [];
      let cursor = "/wiki/api/v2/spaces?limit=100";
      while (cursor) {
        const res = (await call("GET", cursor)) as {
          results?: Array<{ id: string; key: string; name?: string }>;
          _links?: { next?: string };
        };
        for (const s of res.results ?? []) {
          all.push({ id: s.id, key: s.key, name: s.name ?? s.key });
        }
        const next = res._links?.next;
        if (!next) break;
        // v2 returns relative paths beginning with "/wiki/..."
        cursor = next.startsWith("/") ? next : `/${next}`;
      }
      return all;
    },

    async listRootPages(spaceId: string): Promise<ConfluenceRootPage[]> {
      const url =
        `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages` +
        `?depth=root&limit=50`;
      const res = (await call("GET", url)) as {
        results?: Array<{ id: string; title: string }>;
      };
      return (res.results ?? []).map((p) => ({ id: p.id, title: p.title }));
    },

    async findPageByTitle(
      spaceId: string,
      title: string
    ): Promise<ConfluencePage | null> {
      const url =
        `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages` +
        `?title=${encodeURIComponent(title)}&body-format=storage&limit=1`;
      const res = (await call("GET", url)) as {
        results?: PageApiResponse[];
      };
      const match = res.results?.find((p) => p.title === title);
      return match ? toPage(match) : null;
    },

    async createPage(input: CreatePageInput): Promise<ConfluencePage> {
      const res = (await call("POST", "/wiki/api/v2/pages", {
        spaceId: input.spaceId,
        status: "current",
        title: input.title,
        parentId: input.parentId,
        body: {
          representation: "storage",
          value: input.body,
        },
      })) as PageApiResponse;
      return toPage(res);
    },

    async updatePage(input: UpdatePageInput): Promise<ConfluencePage> {
      const res = (await call("PUT", `/wiki/api/v2/pages/${input.id}`, {
        id: input.id,
        status: "current",
        title: input.title,
        parentId: input.parentId,
        body: {
          representation: "storage",
          value: input.body,
        },
        version: {
          number: input.version + 1,
        },
      })) as PageApiResponse;
      return toPage(res);
    },
  };
}
