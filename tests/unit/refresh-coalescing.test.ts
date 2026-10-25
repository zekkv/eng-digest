import { describe, expect, it, vi } from "vitest";

import { SEED_SOURCES } from "#/features/digest/config";
import { refresh, summarizeArticle } from "#/features/digest/pipeline.server";
import type { DigestCache } from "#/features/digest/types";
import * as Store from "#/features/digest/store.server";

vi.mock("rss-parser", () => {
  class FakeParser {
    parseString = async (_xml: string) => ({
      items: [
        {
          link: "https://feed.test/1",
          title: "feed story",
          content: "<p>hello world</p>",
          isoDate: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
  }
  return { default: FakeParser };
});

// In-memory cache. The refresh logic stays real, but nothing touches data/cache.json.
// The lock is a passthrough, because locking is not what this test checks.
vi.mock("#/features/digest/store.server", async importOriginal => {
  // The assertion narrows importOriginal() to the module type, because tsc needs it.
  // oxlint's type comparison reads both sides as identical, hence the disable.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
  const actual = (await importOriginal()) as typeof Store;
  let stored: DigestCache = { fetchedAt: 0, articles: [], summaries: {}, feeds: [] };
  return {
    ...actual,
    loadCache: async (): Promise<DigestCache> => ({
      ...stored,
      articles: [...stored.articles],
      summaries: { ...stored.summaries },
      feeds: [...stored.feeds],
    }),
    saveCache: async (cache: DigestCache): Promise<void> => {
      stored = cache;
    },
    withCacheLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

describe("refresh coalescing", () => {
  it("runs one feed sweep for two concurrent forced refreshes", async () => {
    const fetch = vi.fn<
      (input: string) => Promise<{
        ok: true;
        text: () => Promise<string>;
        json: () => Promise<Record<string, unknown>>;
      }>
    >(async input => ({
      ok: true,
      text: async () => "<rss></rss>",
      json: async (): Promise<Record<string, unknown>> =>
        input.includes("hn.algolia.com") ? { hits: [] } : { results: [] },
    }));
    vi.stubGlobal("fetch", fetch);
    try {
      await Promise.all([refresh(), refresh()]);
      // One refresh. Sources answer through fetch (RSS is parsed with parseString),
      // plus one Hacker News call.
      expect(fetch).toHaveBeenCalledTimes(SEED_SOURCES.length + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("coalesces concurrent summarizeArticle requests for the same URL", async () => {
    let extractCalls = 0;
    const fetch = vi.fn<
      (input: string | URL | Request) => Promise<{
        ok: true;
        text: () => Promise<string>;
        json: () => Promise<Record<string, unknown>>;
      }>
    >(async input => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/extract")) {
        extractCalls += 1;
        await new Promise(r => setTimeout(r, 20));
        return {
          ok: true,
          text: async () => "",
          json: async () => ({ results: [{ raw_content: "extracted text content" }] }),
        };
      }
      return {
        ok: true,
        text: async () => "",
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  tldr: "good tldr",
                  key_points: ["point 1"],
                  jargon: [],
                  difficulty: "beginner",
                }),
              },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const targetUrl = "https://feed.test/1";
      await Store.saveCache({
        fetchedAt: 1,
        articles: [{ url: targetUrl, title: "Title", blog: "Blog", published: 1, blurb: "" }],
        summaries: {},
        feeds: [],
      });
      const [s1, s2] = await Promise.all([
        summarizeArticle(targetUrl),
        summarizeArticle(targetUrl),
      ]);
      expect(s1.tldr).toBe("good tldr");
      expect(s2.tldr).toBe("good tldr");
      expect(extractCalls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
