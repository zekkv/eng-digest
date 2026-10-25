import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DAILY_SUMMARY_BUDGET,
  FORCE_REFRESH_COOLDOWN_SECONDS,
  SEED_SOURCES,
} from "#/features/digest/config";
import { refresh, summarizeArticle } from "#/features/digest/pipeline.server";
import type { DigestCache, Summary } from "#/features/digest/types";
import type * as Store from "#/features/digest/store.server";

vi.mock("rss-parser", () => {
  class FakeParser {
    parseString = async (_xml: string) => ({
      items: [
        {
          link: "https://feed.test/1",
          title: "feed story",
          content: "<p>hello</p>",
          isoDate: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
  }
  return { default: FakeParser };
});

// In-memory cache keyed on `state`, so tests can seed it. The lock is a passthrough.
const state = vi.hoisted(() => ({
  cache: { fetchedAt: 0, articles: [], summaries: {}, feeds: [] } as DigestCache,
}));

vi.mock("#/features/digest/store.server", async importOriginal => {
  // The assertion narrows importOriginal() to the module type, because tsc needs it.
  // oxlint's type comparison reads both sides as identical, hence the disable.
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

const nowSec = () => Math.floor(Date.now() / 1000);

function todaySummary(): Summary {
  return {
    tldr: "t",
    keyPoints: [],
    jargon: [],
    difficulty: "",
    model: "m",
    generatedAt: nowSec(),
    words: 100,
  };
}

function cachedArticle(url: string) {
  return { url, title: "target", blog: "B", published: 0, blurb: "" };
}

/** This stubs fetch. Tavily extract returns the article text, and JSON completion returns the LLM answer. */
function stubPaidFetch() {
  const fetch = vi.fn<
    (input: string | URL | Request) => Promise<{
      ok: true;
      text: () => Promise<string>;
      json: () => Promise<unknown>;
    }>
  >(async input => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/extract")) {
      return {
        ok: true,
        text: async () => "<rss></rss>",
        json: async () => ({ results: [{ raw_content: "word ".repeat(300) }] }),
      };
    }
    return {
      ok: true,
      text: async () => "<rss></rss>",
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"tldr":"ok","key_points":["a"],"jargon":[],"difficulty":"beginner"}',
            },
          },
        ],
      }),
    };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  state.cache = { fetchedAt: 0, articles: [], summaries: {}, feeds: [] };
  vi.unstubAllGlobals();
});

describe("daily summary budget", () => {
  it("refuses on-demand summaries once the day's budget is spent, before any network call", async () => {
    const url = "https://example.com/target";
    const summaries: Record<string, Summary | undefined> = {};
    for (let i = 0; i < DAILY_SUMMARY_BUDGET; i += 1)
      summaries[`https://example.com/${i}`] = todaySummary();
    state.cache = { ...state.cache, articles: [cachedArticle(url)], summaries };
    const fetch = stubPaidFetch();

    await expect(summarizeArticle(url)).rejects.toThrow(/budget/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows on-demand summaries while budget remains and counts only today's", async () => {
    const url = "https://example.com/target";
    const yesterday = Math.floor(
      new Date(new Date().setDate(new Date().getDate() - 1)).getTime() / 1000
    );
    const summaries: Record<string, Summary | undefined> = {};
    for (let i = 0; i < DAILY_SUMMARY_BUDGET; i += 1) {
      summaries[`https://example.com/${i}`] = { ...todaySummary(), generatedAt: yesterday };
    }
    state.cache = { ...state.cache, articles: [cachedArticle(url)], summaries };
    stubPaidFetch();

    const summary = await summarizeArticle(url);
    expect(summary.tldr).toBe("ok");
    expect(state.cache.summaries[url]?.tldr).toBe("ok");
  });

  it("lets the daily job bypass the budget and returns cached summaries for free", async () => {
    const url = "https://example.com/target";
    const summaries: Record<string, Summary | undefined> = { [url]: todaySummary() };
    for (let i = 0; i < DAILY_SUMMARY_BUDGET; i += 1)
      summaries[`https://example.com/${i}`] = todaySummary();
    state.cache = { ...state.cache, articles: [cachedArticle(url)], summaries };
    const fetch = stubPaidFetch();

    // A cached summary is free even at the cap.
    const cached = await summarizeArticle(url);
    expect(cached.tldr).toBe("t");

    // The budget-bypass path reaches the network despite the spent budget.
    const freshUrl = "https://example.com/fresh";
    state.cache = { ...state.cache, articles: [...state.cache.articles, cachedArticle(freshUrl)] };
    const fresh = await summarizeArticle(freshUrl, { ignoreBudget: true });
    expect(fresh.tldr).toBe("ok");
    expect(fetch).toHaveBeenCalled();
  });
});

describe("forced refresh cooldown", () => {
  it("skips a forced sweep inside the cooldown window", async () => {
    state.cache = { ...state.cache, lastForced: nowSec() };
    const fetch = vi.fn<() => Promise<{ ok: true; json: () => Promise<{ results: never[] }> }>>(
      async () => ({ ok: true, json: async () => ({ results: [] }) })
    );
    vi.stubGlobal("fetch", fetch);

    await refresh();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs the sweep once the cooldown has passed and stamps the new window", async () => {
    state.cache = { ...state.cache, lastForced: nowSec() - FORCE_REFRESH_COOLDOWN_SECONDS - 1 };
    const fetch = vi.fn<
      (input: string) => Promise<{ ok: true; json: () => Promise<Record<string, unknown>> }>
    >(async input => ({
      ok: true,
      json: async (): Promise<Record<string, unknown>> =>
        input.includes("hn.algolia.com") ? { hits: [] } : { results: [] },
    }));
    vi.stubGlobal("fetch", fetch);

    await refresh();
    // One refresh. Sources answer through fetch (RSS is parsed with parseString),
    // plus one Hacker News call.
    expect(fetch).toHaveBeenCalledTimes(SEED_SOURCES.length + 1);
    expect(state.cache.lastForced).toBeGreaterThanOrEqual(nowSec() - 1);
  });
});
