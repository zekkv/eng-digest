import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as Pipeline from "#/features/digest/pipeline.server";
import type * as Store from "#/features/digest/store.server";
import type {
  CandidateArticle,
  DigestCache,
  FeedStatus,
  TrackedSource,
} from "#/features/digest/types";
import { dryRun } from "../../scripts/digest-daily";

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
  };
});

describe("dryRun() from scripts/digest-daily.ts", () => {
  beforeEach(() => {
    state.cache = { fetchedAt: 0, articles: [], summaries: {}, feeds: [] };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints feed counts, feed details, and candidate breakdown for healthy feeds", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => {
      logs.push(String(msg));
    });
    const learned: TrackedSource = {
      host: "learned.test",
      name: "learned.test",
      url: "https://learned.test/feed",
      kind: "rss",
      origin: "learned",
      addedAt: 1,
      lastOkAt: 1,
      misses: 0,
    };
    state.cache = { ...state.cache, sources: [learned] };

    const mockFeeds: FeedStatus[] = [
      { name: "Engineering Blog A", ok: true, count: 4 },
      { name: "Engineering Blog B", ok: true, count: 1 },
    ];
    const mockArticles: CandidateArticle[] = [
      { url: "https://a.test/1", title: "Article 1", blog: "A", published: 1000, blurb: "b" },
      { url: "https://a.test/2", title: "Article 2", blog: "A", published: 2000, blurb: "b" },
      { url: "https://b.test/3", title: "Article 3", blog: "B", published: 0, blurb: "b" },
    ];

    const fetchCandidates = vi.spyOn(Pipeline, "fetchCandidates").mockResolvedValueOnce({
      articles: mockArticles,
      feeds: mockFeeds,
      fetchedSources: [],
    });

    await dryRun();

    expect(logs).toContain("feeds: 2/2 ok");
    expect(logs).toContain("  ok Engineering Blog A: 4 articles");
    expect(logs).toContain("  ok Engineering Blog B: 1 articles");
    expect(logs).toContain("candidates: 3 (2 dated, 1 undated)");
    expect(fetchCandidates.mock.calls[0]?.[0]?.some(source => source.url === learned.url)).toBe(
      true
    );
  });

  it("correctly logs failures when some feeds are down", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation(msg => {
      logs.push(String(msg));
    });

    const mockFeeds: FeedStatus[] = [
      { name: "Good Feed", ok: true, count: 2 },
      { name: "Broken Feed", ok: false, error: "503 Service Unavailable" },
    ];

    vi.spyOn(Pipeline, "fetchCandidates").mockResolvedValueOnce({
      articles: [],
      feeds: mockFeeds,
      fetchedSources: [],
    });

    await dryRun();

    expect(logs).toContain("feeds: 1/2 ok");
    expect(logs).toContain("  ok Good Feed: 2 articles");
    expect(logs).toContain("  FAIL Broken Feed: 503 Service Unavailable");
    expect(logs).toContain("candidates: 0 (0 dated, 0 undated)");
  });
});
