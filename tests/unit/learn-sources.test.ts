import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { learnSources, refresh } from "#/features/digest/pipeline.server";
import type * as Store from "#/features/digest/store.server";
import type { CandidateArticle, DigestCache, TrackedSource } from "#/features/digest/types";

const state = vi.hoisted(() => ({
  cache: { fetchedAt: 0, articles: [], summaries: {}, feeds: [] } as DigestCache,
}));

vi.mock("#/features/digest/store.server", async importOriginal => {
  // The assertion narrows importOriginal() to the module type, because tsc needs it.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
  const actual = (await importOriginal()) as typeof Store;
  return {
    ...actual,
    loadCache: async (): Promise<DigestCache> => structuredClone(state.cache),
    saveCache: async (cache: DigestCache): Promise<void> => {
      state.cache = structuredClone(cache);
    },
    withCacheLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

interface MockResponse {
  ok: boolean;
  status?: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

function picked(overrides: Partial<CandidateArticle> = {}): CandidateArticle {
  return {
    url: "https://site.test/blog/post",
    title: "Post",
    blog: "site.test",
    published: 0,
    blurb: "",
    source: "search",
    ...overrides,
  };
}

const validRss = `<rss version="2.0"><channel><title>Learned</title><item>
  <title>Learned post</title>
  <link>https://learned.test/post</link>
  <pubDate>Wed, 01 Oct 2026 00:00:00 GMT</pubDate>
</item></channel></rss>`;

beforeEach(() => {
  state.cache = { fetchedAt: 0, articles: [], summaries: {}, feeds: [] };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("learnSources", () => {
  it("learns a new source from a picked search article", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: string) => Promise<MockResponse>>(async input =>
        input === "https://site.test/blog/post"
          ? {
              ok: true,
              status: 200,
              text: async () =>
                '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
            }
          : { ok: false, status: 404, text: async () => "" }
      )
    );

    await learnSources([picked()]);

    expect(state.cache.sources?.find(source => source.host === "site.test")).toMatchObject({
      url: "https://site.test/feed.xml",
      kind: "rss",
      origin: "learned",
      prefix: "/blog/",
    });
  });

  it("does not learn blocked or already tracked hosts", async () => {
    const fetch = vi.fn<() => Promise<MockResponse>>();
    vi.stubGlobal("fetch", fetch);

    await learnSources([
      picked({ url: "https://medium.com/@writer/post", blog: "medium.com" }),
      picked({ url: "https://react.dev/blog/post", blog: "react.dev" }),
    ]);

    expect(fetch).not.toHaveBeenCalled();
    expect(state.cache.sources?.some(source => source.origin === "learned") ?? false).toBe(false);
  });

  it("leaves the cache alone when discovery finds nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: string) => Promise<MockResponse>>(async () => ({
        ok: false,
        status: 404,
        text: async () => "",
      }))
    );

    await learnSources([picked({ url: "https://unknown.test/post", blog: "unknown.test" })]);

    expect(state.cache.sources).toBeUndefined();
  });
});

describe("refresh source health", () => {
  it("fetches a learned source and updates its status and lastOkAt", async () => {
    const learned: TrackedSource = {
      host: "learned.test",
      name: "learned.test",
      url: "https://learned.test/feed",
      kind: "rss",
      origin: "learned",
      prefix: "/",
      addedAt: 1,
      lastOkAt: 0,
      misses: 0,
    };
    state.cache = { ...state.cache, sources: [learned] };
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: string) => Promise<MockResponse>>(async input => {
        if (input.includes("hn.algolia.com")) {
          return { ok: true, status: 200, json: async () => ({ hits: [] }) };
        }
        if (input.includes("tavily")) {
          return { ok: true, status: 200, json: async () => ({ results: [] }) };
        }
        if (input === learned.url) {
          return { ok: true, status: 200, text: async () => validRss };
        }
        return { ok: true, status: 200, text: async () => "<rss></rss>" };
      })
    );

    await refresh({ ignoreCooldown: true });

    const updated = state.cache.sources?.find(source => source.host === "learned.test");
    expect(updated?.misses).toBe(0);
    expect(updated?.lastOkAt).toBeGreaterThan(0);
    expect(state.cache.feeds.find(feed => feed.name === "learned.test")).toMatchObject({
      ok: true,
      count: 1,
    });
    expect(state.cache.articles.some(article => article.url === "https://learned.test/post")).toBe(
      true
    );
  });
});
