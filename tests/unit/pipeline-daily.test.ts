import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dayStamp, daily, loadDigest } from "#/features/digest/pipeline.server";
import type * as Store from "#/features/digest/store.server";
import type { DigestCache } from "#/features/digest/types";

let mockStoreCache: DigestCache;

function resetCache(): DigestCache {
  return {
    fetchedAt: Math.floor(Date.now() / 1000),
    articles: [],
    summaries: {},
    feeds: [],
    lastDaily: undefined,
  };
}

const { getParserItems, setParserItems } = vi.hoisted(() => {
  let items = [
    {
      link: "https://example.com/feed-item-1",
      title: "Feed Item 1",
      content: "<p>Article snippet</p>",
      isoDate: "2026-01-01T00:00:00.000Z",
    },
  ];
  return {
    getParserItems: () => items,
    setParserItems: (
      newItems: Array<{ link: string; title: string; content: string; isoDate: string }>
    ) => {
      items = newItems;
    },
  };
});

vi.mock("rss-parser", () => {
  class FakeParser {
    parseString = async () => ({
      items: getParserItems(),
    });
  }
  return { default: FakeParser };
});

vi.mock("#/features/digest/store.server", async importOriginal => {
  const actual = await importOriginal<typeof Store>();
  return {
    ...actual,
    loadCache: vi.fn<() => Promise<DigestCache>>(async () => ({
      ...mockStoreCache,
      articles: [...mockStoreCache.articles],
      summaries: { ...mockStoreCache.summaries },
      feeds: [...mockStoreCache.feeds],
    })),
    saveCache: vi.fn<(cache: DigestCache) => Promise<void>>(async (cache: DigestCache) => {
      mockStoreCache = {
        ...cache,
        articles: [...cache.articles],
        summaries: { ...cache.summaries },
        feeds: [...cache.feeds],
      };
    }),
    withCacheLock: vi.fn<<T>(fn: () => Promise<T>) => Promise<T>>(
      async <T>(fn: () => Promise<T>): Promise<T> => fn()
    ),
  };
});

function stubAllFetch(
  options: { failLlm?: boolean; authFailLlm?: boolean; failDiscovery?: boolean } = {}
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("hn.algolia.com")) {
        return {
          ok: true,
          json: async () => ({
            hits: [
              {
                title: "HN story",
                url: "https://example.com/hn-1",
                points: 500,
                num_comments: 10,
                created_at_i: 1700000000,
              },
            ],
          }),
        };
      }
      if (typeof url === "string" && url.includes("tavily")) {
        return {
          ok: true,
          json: async () => ({
            results: [{ raw_content: "Extracted article body content with words." }],
          }),
        };
      }
      if (typeof url === "string" && url.includes("openrouter")) {
        if (options.authFailLlm) {
          return { ok: false, status: 401 };
        }
        if (options.failLlm) {
          return { ok: false, status: 500 };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tldr: "Summary of post",
                    key_points: ["Point A", "Point B"],
                    jargon: [{ term: "Term", explanation: "Definition" }],
                    difficulty: "intermediate",
                  }),
                },
              },
            ],
          }),
        };
      }
      if (typeof url === "string" && url.startsWith("https://example.com/")) {
        if (options.failDiscovery) {
          return { ok: false, status: 404, text: async (): Promise<string> => "" };
        }
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> =>
            '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
        };
      }
      // RSS feeds
      return {
        ok: true,
        text: async (): Promise<string> => "<rss></rss>",
      };
    })
  );
}

describe("loadDigest()", () => {
  beforeEach(() => {
    mockStoreCache = resetCache();
    stubAllFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns cached payload immediately when cache is fresh", async () => {
    mockStoreCache.fetchedAt = Math.floor(Date.now() / 1000);
    mockStoreCache.articles = [
      { url: "https://example.com/a1", title: "A1", blog: "Blog", published: 100, blurb: "" },
    ];

    const payload = await loadDigest(false);

    expect(payload.articles).toHaveLength(1);
    expect(payload.articles[0].url).toBe("https://example.com/a1");
    expect(payload.articles[0].summary).toBeNull();
    expect(payload.articles[0].picked).toBe(false);
  });

  it("marks picked articles correctly when matching lastDaily stamp", async () => {
    const today = dayStamp();
    mockStoreCache.lastDaily = today;
    mockStoreCache.articles = [
      { url: "https://example.com/a1", title: "A1", blog: "Blog", published: 100, blurb: "" },
    ];
    mockStoreCache.summaries = {
      "https://example.com/a1": {
        tldr: "Today TLDR",
        keyPoints: [],
        jargon: [],
        difficulty: "beginner",
        model: "m",
        generatedAt: Math.floor(Date.now() / 1000),
        words: 500,
      },
    };

    const payload = await loadDigest(false);

    expect(payload.articles[0].summary).not.toBeNull();
    expect(payload.articles[0].picked).toBe(true);
  });

  it("forces a refresh when forceRefresh is true", async () => {
    mockStoreCache.fetchedAt = 0;
    const payload = await loadDigest(true);

    expect(payload.feeds.length).toBeGreaterThan(0);
    expect(mockStoreCache.fetchedAt).toBeGreaterThan(0);
  });

  it("returns the cached payload without fetching feeds, however old the cache is", async () => {
    mockStoreCache.fetchedAt = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    mockStoreCache.articles = [
      { url: "https://example.com/old", title: "Old", blog: "B", published: 10, blurb: "" },
    ];

    const payload = await loadDigest(false);
    expect(payload.articles[0].title).toBe("Old");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("daily()", () => {
  beforeEach(() => {
    setParserItems([
      {
        link: "https://example.com/feed-item-1",
        title: "Feed Item 1",
        content: "<p>Article snippet</p>",
        isoDate: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mockStoreCache = resetCache();
    stubAllFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips execution if already built today and force is false", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => logs.push(String(msg)));

    const today = dayStamp();
    mockStoreCache.lastDaily = today;

    await daily(false);

    expect(logs.some(line => line.includes("digest already built today"))).toBe(true);
    // Did not refresh feeds
    expect(logs.some(line => line.includes("fetching feeds..."))).toBe(false);
  });

  it("proceeds with force=true even if already built today", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => logs.push(String(msg)));

    const today = dayStamp();
    mockStoreCache.lastDaily = today;

    await daily(true);

    expect(logs.some(line => line.includes("fetching feeds..."))).toBe(true);
  });

  it("completes cleanly and stamps today when there are no unsummarized articles", async () => {
    setParserItems([]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => logs.push(String(msg)));

    // Feeds return empty results when RSS/HN/Tavily have nothing
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("hn.algolia.com")) {
          return { ok: true, json: async () => ({ hits: [] }) };
        }
        if (typeof url === "string" && url.includes("tavily")) {
          return { ok: true, json: async () => ({ results: [] }) };
        }
        return { ok: true, text: async (): Promise<string> => "<rss></rss>" };
      })
    );

    mockStoreCache.articles = [];
    mockStoreCache.summaries = {};

    await daily(false);

    expect(logs.some(line => line.includes("nothing new — done"))).toBe(true);
    expect(mockStoreCache.lastDaily).toBe(dayStamp());
  });

  it("summarizes candidate articles, stamps today, and logs counts on success", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => logs.push(String(msg)));

    await daily(false);

    expect(logs.some(line => line.includes("summarized"))).toBe(true);
    expect(mockStoreCache.lastDaily).toBe(dayStamp());
    expect(Object.keys(mockStoreCache.summaries).length).toBeGreaterThan(0);
    expect(mockStoreCache.sources?.some(source => source.host === "example.com")).toBe(true);
  });

  it("stamps today even when source discovery fails", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => logs.push(String(msg)));

    stubAllFetch({ failDiscovery: true });

    await daily(false);

    expect(mockStoreCache.lastDaily).toBe(dayStamp());
    expect(mockStoreCache.sources?.some(source => source.host === "example.com") ?? false).toBe(
      false
    );
    expect(logs.some(line => line.includes("could not discover a source"))).toBe(true);
  });

  it("does not stamp lastDaily when all summaries fail", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => logs.push(String(msg)));

    stubAllFetch({ failLlm: true });

    mockStoreCache.articles = [
      { url: "https://example.com/fail-1", title: "Fail 1", blog: "B", published: 10, blurb: "" },
    ];
    mockStoreCache.lastDaily = undefined;

    const result = await daily(false);

    expect(result.summarized).toBe(0);
    expect(result.pending).toBeGreaterThan(0);
    expect(logs.some(line => line.includes("nothing succeeded"))).toBe(true);
    expect(mockStoreCache.lastDaily).toBeUndefined();
  });

  it("aborts remaining summaries when an upstream auth error occurs", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => logs.push(String(msg)));

    stubAllFetch({ authFailLlm: true });

    mockStoreCache.articles = [
      { url: "https://example.com/auth-1", title: "Auth 1", blog: "B", published: 10, blurb: "" },
      { url: "https://example.com/auth-2", title: "Auth 2", blog: "B", published: 20, blurb: "" },
    ];
    mockStoreCache.lastDaily = undefined;

    await daily(false);

    expect(logs.some(line => line.includes("auth failed, aborting the rest"))).toBe(true);
    expect(mockStoreCache.lastDaily).toBeUndefined();
  });
});
