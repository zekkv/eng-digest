import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  UpstreamAuthError,
  completeJson,
  extractJson,
  extractPageText,
} from "#/features/digest/clients.server";
import {
  DEFAULT_MODEL,
  KEEP_ARTICLES,
  LLM_MAX_TOKENS,
  MAX_CHARS,
  SEED_SOURCES,
} from "#/features/digest/config";
import {
  dayStamp,
  fetchCandidates,
  fetchHnStories,
  hostnameOf,
  normalizeSummary,
  resolvePickCount,
  selectInteresting,
  stripHtml,
  summarizePicked,
  toCandidate,
  toPayload,
} from "#/features/digest/pipeline.server";
import { parseGetDigest, parseSummarize } from "#/features/digest/server-fns";
import { loadCache, mergeArticles, saveCache, withCacheLock } from "#/features/digest/store.server";
import type { CandidateArticle, DigestCache, Summary } from "#/features/digest/types";
import { isHttpUrl } from "#/features/digest/url";

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

// tests/setup.ts sets hermetic API keys. It is wired as the Vitest setup file.

function article(overrides: Partial<CandidateArticle> = {}): CandidateArticle {
  return {
    url: "https://example.com/a",
    title: "t",
    blog: "B",
    published: 0,
    blurb: "",
    ...overrides,
  };
}

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    tldr: "t",
    keyPoints: [],
    jargon: [],
    difficulty: "",
    model: "m",
    generatedAt: 2,
    words: 800,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response)
  );
}

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  it("parses JSON wrapped in prose", () => {
    expect(extractJson('Sure! {"a": 3} hope that helps')).toEqual({ a: 3 });
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(/did not return JSON/i);
  });

  it("throws when the braces hold invalid JSON", () => {
    expect(() => extractJson("{not json}")).toThrow(/did not return JSON/i);
  });
});

describe("feed mapping", () => {
  it("strips tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello  <b>world</b></p>\nnext")).toBe("Hello world next");
  });

  it("drops entries without url or title", () => {
    expect(toCandidate("B", { title: "t" })).toBeNull();
    expect(toCandidate("B", { link: "https://x.test/1" })).toBeNull();
  });

  it("maps dates to epoch seconds and caps the blurb", () => {
    const got = toCandidate("B", {
      link: "https://x.test/1",
      title: "t",
      content: `<p>${"w ".repeat(500)}</p>`,
      isoDate: "2026-01-02T03:04:05.000Z",
    });
    expect(got?.published).toBe(Date.parse("2026-01-02T03:04:05.000Z") / 1000);
    expect(got?.blurb.length).toBeLessThanOrEqual(280);
  });

  it("falls back to epoch zero without a date", () => {
    expect(toCandidate("B", { link: "https://x.test/1", title: "t" })?.published).toBe(0);
  });

  it("reads hostnames, tolerating junk", () => {
    expect(hostnameOf("https://engineering.grab.com/p")).toBe("engineering.grab.com");
    expect(hostnameOf("not a url", "web")).toBe("web");
  });
});

describe("mergeArticles", () => {
  it("dedupes by url with refreshed metadata winning, newest first", () => {
    const old = [
      article({ url: "u1", title: "old", published: 1 }),
      article({ url: "u2", title: "b", published: 2 }),
    ];
    const out = mergeArticles(old, [article({ url: "u1", title: "new", published: 3 })]);
    expect(out.map(a => a.url)).toEqual(["u1", "u2"]);
    expect(out[0].title).toBe("new");
  });

  it("caps the cache at KEEP_ARTICLES newest", () => {
    const many = Array.from({ length: KEEP_ARTICLES + 50 }, (_, i) =>
      article({ url: `u${i}`, published: i })
    );
    const out = mergeArticles([], many);
    expect(out).toHaveLength(KEEP_ARTICLES);
    expect(out[0].published).toBe(KEEP_ARTICLES + 49);
  });

  it("keeps undated hits behind dated items, ahead of the cap", () => {
    const dated = Array.from({ length: 199 }, (_, i) =>
      article({ url: `d${i}`, published: i + 1 })
    );
    const undated = Array.from({ length: 5 }, (_, i) => article({ url: `s${i}`, published: 0 }));
    const out = mergeArticles([], [...dated, ...undated]);
    expect(out).toHaveLength(KEEP_ARTICLES);
    expect(out[0].published).toBe(199);
    expect(out.slice(0, 199).every(a => a.published > 0)).toBe(true);
    expect(out[199].published).toBe(0);
  });

  it("keeps fresh undated discoveries ahead of the undated backlog", () => {
    const dated = Array.from({ length: 160 }, (_, i) =>
      article({ url: `d${i}`, published: i + 1 })
    );
    const old = Array.from({ length: 40 }, (_, i) => article({ url: `old${i}`, published: 0 }));
    const fresh = article({ url: "fresh", published: 0 });
    const out = mergeArticles([...old, ...dated], [fresh]);
    expect(out.some(a => a.url === "fresh")).toBe(true);
    expect(out.some(a => a.url === "old39")).toBe(false);
    expect(out.filter(a => a.published <= 0)).toHaveLength(40);
  });

  it("does not let an undated hit overwrite existing published timestamp or curated blog name", () => {
    const old = [
      article({ url: "u1", blog: "Curated Blog", title: "old", published: 100, source: "feed" }),
    ];
    const fresh = [
      article({
        url: "u1",
        blog: "search-domain.com",
        title: "new title",
        published: 0,
        source: "search",
      }),
    ];
    const out = mergeArticles(old, fresh);
    expect(out).toHaveLength(1);
    expect(out[0].published).toBe(100);
    expect(out[0].blog).toBe("Curated Blog");
    expect(out[0].title).toBe("new title");
    expect(out[0].source).toBe("feed");
  });

  it("never evicts preserved urls even when exceeding KEEP_ARTICLES", () => {
    const many = Array.from({ length: KEEP_ARTICLES + 50 }, (_, i) =>
      article({ url: `u${i}`, published: i + 10 })
    );
    const preserved = article({ url: "old-pick", published: 1 });
    const out = mergeArticles([preserved], many, ["old-pick"]);
    expect(out.some(a => a.url === "old-pick")).toBe(true);
  });
});

describe("selectInteresting", () => {
  const cands = [
    article({ url: "u1", title: "a" }),
    article({ url: "u2", title: "b" }),
    article({ url: "u3", title: "c" }),
  ];

  it("honors the LLM picks in candidate order", async () => {
    const got = await selectInteresting(cands, 2, () => Promise.resolve({ picked: ["u3", "u1"] }));
    expect(got.map(a => a.url)).toEqual(["u1", "u3"]);
  });

  it("caps at n", async () => {
    const got = await selectInteresting(cands, 1, () => Promise.resolve({ picked: ["u1", "u2"] }));
    expect(got.map(a => a.url)).toEqual(["u1"]);
  });

  it("falls back to newest on garbage output", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const got = await selectInteresting(cands, 2, () => {
        throw new Error("model did not return JSON");
      });
      expect(got.map(a => a.url)).toEqual(["u1", "u2"]);
    } finally {
      quiet.mockRestore();
    }
  });

  it("ignores picked urls outside the candidates", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const got = await selectInteresting(cands, 2, () =>
        Promise.resolve({ picked: ["https://evil.test/x"] })
      );
      expect(got.map(a => a.url)).toEqual(["u1", "u2"]);
    } finally {
      quiet.mockRestore();
    }
  });

  it("tops up with the newest remaining when the picker matches fewer than n", async () => {
    const got = await selectInteresting(cands, 3, () => Promise.resolve({ picked: ["u3"] }));
    expect(got.map(a => a.url)).toEqual(["u3", "u1", "u2"]);
  });
});

describe("normalizeSummary", () => {
  it("passes a well-formed summary through", () => {
    expect(
      normalizeSummary(
        {
          tldr: "  does x  ",
          key_points: ["a", 2],
          jargon: [{ term: "t", explanation: "e" }],
          difficulty: "Advanced",
        },
        "m",
        99
      )
    ).toEqual({
      tldr: "does x",
      keyPoints: ["a", "2"],
      jargon: [{ term: "t", explanation: "e" }],
      difficulty: "advanced",
      model: "m",
      generatedAt: 99,
      words: 0,
    });
  });

  it("rejects unknown difficulties and caps list lengths", () => {
    const got = normalizeSummary(
      {
        tldr: "valid tldr",
        difficulty: "expert",
        key_points: Array.from({ length: 20 }, (_, i) => `p${i}`),
        jargon: Array.from({ length: 20 }, (_, i) => ({ term: `t${i}`, explanation: "e" })),
      },
      "m",
      7
    );
    expect(got.difficulty).toBe("");
    expect(got.keyPoints).toHaveLength(8);
    expect(got.jargon).toHaveLength(12);
  });

  it("rejects invalid summaries and cleans/dedupes jargon", () => {
    expect(() => normalizeSummary(null, "m", 1)).toThrow(/object/);
    expect(() => normalizeSummary({ tldr: "" }, "m", 1)).toThrow(/tldr/);
    expect(() => normalizeSummary({ tldr: "t", key_points: [] }, "m", 1)).toThrow(/key points/);
    const got = normalizeSummary(
      {
        tldr: " tldr ",
        key_points: [" point 1 ", ""],
        jargon: [
          "nope",
          { term: "  ", explanation: "empty term" },
          { term: "term", explanation: "   " },
          { term: " Term ", explanation: "explanation 1" },
          { term: "term", explanation: "duplicate explanation" },
        ],
      },
      "m",
      1
    );
    expect(got.tldr).toBe("tldr");
    expect(got.keyPoints).toEqual(["point 1"]);
    expect(got.jargon).toEqual([{ term: "Term", explanation: "explanation 1" }]);
  });

  it("ignores model-reported word counts (the honest count comes from extraction)", () => {
    expect(normalizeSummary({ tldr: "t", key_points: ["kp"], words: 1500 }, "m", 1).words).toBe(0);
    expect(normalizeSummary({ tldr: "t", key_points: ["kp"], words: -3 }, "m", 1).words).toBe(0);
    expect(normalizeSummary({ tldr: "t", key_points: ["kp"], words: "lots" }, "m", 1).words).toBe(
      0
    );
    expect(normalizeSummary({ tldr: "t", key_points: ["kp"] }, "m", 1).words).toBe(0);
  });
});

describe("toPayload", () => {
  it("backfills legacy summaries without a word count", () => {
    const fresh = summary();
    const legacy = JSON.parse(JSON.stringify({ ...fresh, words: undefined })) as Summary;
    const payload = toPayload({
      fetchedAt: 1,
      articles: [article()],
      summaries: { "https://example.com/a": legacy },
      feeds: [{ name: "B", ok: true, count: 1 }],
      lastDaily: "2026-10-14",
    });
    expect(payload.articles[0].summary).toMatchObject({ words: 0 });
    expect(payload.feeds).toEqual([{ name: "B", ok: true, count: 1 }]);
    const withWords = toPayload({
      fetchedAt: 1,
      articles: [article()],
      summaries: { "https://example.com/a": fresh },
      feeds: [],
    });
    expect(withWords.articles[0].summary?.words).toBe(800);
  });

  it("marks articles summarized on the lastDaily local day as picked", () => {
    const today = dayStamp();
    const now = Math.floor(Date.now() / 1000);
    const base = { fetchedAt: 1, articles: [article()], feeds: [] };
    const picked = toPayload({
      ...base,
      summaries: { "https://example.com/a": summary({ generatedAt: now }) },
      lastDaily: today,
    });
    expect(picked.articles[0].picked).toBe(true);
    const stale = toPayload({
      ...base,
      summaries: { "https://example.com/a": summary({ generatedAt: now }) },
      lastDaily: "2000-01-01",
    });
    expect(stale.articles[0].picked).toBe(false);
    const unsummarized = toPayload({ ...base, summaries: {}, lastDaily: today });
    expect(unsummarized.articles[0].picked).toBe(false);
    const neverRan = toPayload({
      ...base,
      summaries: { "https://example.com/a": summary({ generatedAt: now }) },
    });
    expect(neverRan.articles[0].picked).toBe(false);
  });

  it("marks articles in cache.pickedUrls as picked", () => {
    const base = {
      fetchedAt: 1,
      articles: [
        article({ url: "https://example.com/picked" }),
        article({ url: "https://example.com/other" }),
      ],
      feeds: [],
    };
    const payload = toPayload({
      ...base,
      summaries: {},
      pickedUrls: ["https://example.com/picked"],
    });
    expect(payload.articles[0].picked).toBe(true);
    expect(payload.articles[1].picked).toBe(false);
  });
});

describe("server function validators", () => {
  it("accepts an omitted refresh flag", () => {
    expect(parseGetDigest({})).toEqual({});
    expect(parseGetDigest({ refresh: true })).toEqual({ refresh: true });
  });

  it("rejects a non-boolean refresh", () => {
    expect(() => parseGetDigest({ refresh: "yes" })).toThrow(/invalid input/i);
  });

  it("accepts a url and rejects blanks and non-urls", () => {
    expect(parseSummarize({ url: "https://x.test/1" })).toEqual({ url: "https://x.test/1" });
    expect(() => parseSummarize({ url: "   " })).toThrow(/url is required/i);
    expect(() => parseSummarize({ url: "not a url" })).toThrow(/valid url/i);
    expect(() => parseSummarize({})).toThrow(/invalid input/i);
  });

  it("rejects non-http and non-https schemes", () => {
    expect(() => parseSummarize({ url: "javascript:alert(1)" })).toThrow(/http or https/i);
    expect(() => parseSummarize({ url: "ftp://example.com" })).toThrow(/http or https/i);
  });
});

describe("daily helpers", () => {
  it("resolves the pick count with a default of 10", () => {
    expect(resolvePickCount(undefined)).toBe(10);
    expect(resolvePickCount("5")).toBe(5);
    expect(resolvePickCount("abc")).toBe(10);
    expect(resolvePickCount("0")).toBe(1);
  });

  it("stamps the day in SGT", () => {
    expect(dayStamp(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01-05");
    expect(dayStamp(new Date(Date.UTC(2026, 0, 5, 15, 59)))).toBe("2026-01-05");
    expect(dayStamp(new Date(Date.UTC(2026, 0, 5, 16)))).toBe("2026-01-06");
    expect(dayStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("cache roundtrip", () => {
  it("loads empty when missing and roundtrips through a temp file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
    try {
      const file = path.join(dir, "cache.json");
      expect(await loadCache(file)).toEqual({
        fetchedAt: 0,
        articles: [],
        summaries: {},
        feeds: [],
        lastDaily: undefined,
      });
      const cache: DigestCache = {
        fetchedAt: 42,
        articles: [article()],
        summaries: {},
        feeds: [{ name: "B", ok: true, count: 1 }],
        lastDaily: "2026-01-05",
      };
      await saveCache(cache, file);
      expect(await loadCache(file)).toEqual(cache);
      // The write is atomic. No temporary file is left behind.
      const leftovers = (await readdir(dir)).filter(name => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("quarantines a corrupt cache file and loads empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
    try {
      const file = path.join(dir, "cache.json");
      await writeFile(file, "{oops", "utf-8");
      expect(await loadCache(file)).toEqual({
        fetchedAt: 0,
        articles: [],
        summaries: {},
        feeds: [],
        lastDaily: undefined,
      });
      const entries = await readdir(dir);
      expect(entries.some(name => name.startsWith("cache.json.corrupt-"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("quarantines a non-object cache file and loads empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
    try {
      const file = path.join(dir, "cache.json");
      await writeFile(file, "42", "utf-8");
      const cache = await loadCache(file);
      expect(cache.articles).toEqual([]);
      expect(cache.summaries).toEqual({});
      const entries = await readdir(dir);
      expect(entries.some(name => name.startsWith("cache.json.corrupt-"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops invalid entries and defaults bad scalars", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
    try {
      const file = path.join(dir, "cache.json");
      const valid = article({ url: "https://example.com/ok" });
      await writeFile(
        file,
        JSON.stringify({
          fetchedAt: "yesterday",
          articles: [{ nope: true }, valid],
          summaries: {
            junk: { nope: true },
            "https://example.com/ok": {
              tldr: "t",
              keyPoints: [],
              jargon: [],
              difficulty: "",
              model: "m",
              generatedAt: 1,
            },
          },
          feeds: [{ nope: true }, { name: "B", ok: true, count: 1 }],
          lastDaily: 5,
        }),
        "utf-8"
      );
      const cache = await loadCache(file);
      expect(cache.fetchedAt).toBe(0);
      expect(cache.articles).toEqual([valid]);
      expect(Object.keys(cache.summaries)).toEqual(["https://example.com/ok"]);
      expect(cache.feeds).toEqual([{ name: "B", ok: true, count: 1 }]);
      expect(cache.lastDaily).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops summaries with invalid element shapes instead of crashing SSR", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
    try {
      const file = path.join(dir, "cache.json");
      const good = {
        tldr: "t",
        keyPoints: ["a"],
        jargon: [{ term: "t", explanation: "e" }],
        difficulty: "",
        model: "m",
        generatedAt: 1,
      };
      await writeFile(
        file,
        JSON.stringify({
          fetchedAt: 0,
          articles: [],
          summaries: {
            "https://example.com/ok": good,
            "https://example.com/null-point": { ...good, keyPoints: [null] },
            "https://example.com/null-jargon": { ...good, jargon: [null] },
            "https://example.com/bad-points": { ...good, keyPoints: "nope" },
          },
          feeds: [],
        }),
        "utf-8"
      );
      const cache = await loadCache(file);
      expect(Object.keys(cache.summaries)).toEqual(["https://example.com/ok"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes summaries for articles no longer in the cache", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
    try {
      const file = path.join(dir, "cache.json");
      const active = article({ url: "https://example.com/active" });
      const good = {
        tldr: "t",
        keyPoints: ["a"],
        jargon: [{ term: "t", explanation: "e" }],
        difficulty: "" as const,
        model: "m",
        generatedAt: 1,
      };
      const cache: DigestCache = {
        fetchedAt: 1,
        articles: [active],
        summaries: {
          "https://example.com/active": good,
          "https://example.com/dead": good,
        },
        feeds: [],
      };
      await saveCache(cache, file);
      const loaded = await loadCache(file);
      expect(Object.keys(loaded.summaries)).toEqual(["https://example.com/active"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isHttpUrl", () => {
  it("accepts valid http and https urls", () => {
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("https://example.com/path?query=1#hash")).toBe(true);
  });

  it("rejects non-http schemes and malformed strings", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("ftp://files.example.com")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("cache lock", () => {
  it("holds concurrent sections mutually exclusive", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
    try {
      const file = path.join(dir, "cache.json");
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const first = withCacheLock(async () => {
        order.push("first");
        await gate;
      }, file);
      // Wait until the first holder owns the lock file.
      await vi.waitFor(async () => {
        expect(await readdir(dir)).toContain("cache.lock");
      });
      const second = withCacheLock(async () => {
        order.push("second");
      }, file);
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(order).toEqual(["first"]);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
      expect(await readdir(dir)).not.toContain("cache.lock");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("steals a stale lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
    try {
      const file = path.join(dir, "cache.json");
      await writeFile(path.join(dir, "cache.lock"), "stale", "utf-8");
      const old = new Date(Date.now() - 60_000);
      await utimes(path.join(dir, "cache.lock"), old, old);
      await expect(withCacheLock(async () => "ok", file)).resolves.toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("OpenRouter client", () => {
  it("returns parsed JSON on success", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"picked":["u1"]}' } }] }),
    });
    await expect(completeJson("sys", "user")).resolves.toEqual({ picked: ["u1"] });
  });

  it("throws a readable error on HTTP failure", async () => {
    stubFetch({ ok: false, status: 500 });
    await expect(completeJson("sys", "user")).rejects.toThrow(/status 500/);
  });

  it("throws a readable error when fetch itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      })
    );
    await expect(completeJson("sys", "user")).rejects.toThrow(/LLM request failed: boom/);
  });

  it("throws when the model returns no content", async () => {
    stubFetch({ ok: true, json: async () => ({ choices: [] }) });
    await expect(completeJson("sys", "user")).rejects.toThrow(/no content/i);
  });

  it("sends model, token budget, reasoning effort, and truncated text", async () => {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        body = init?.body ?? "";
        return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
      })
    );
    await completeJson("sys", "Z".repeat(MAX_CHARS + 100));
    const parsed = JSON.parse(body) as {
      model: string;
      max_tokens: number;
      reasoning: unknown;
      response_format: unknown;
      messages: { content: string }[];
    };
    expect(parsed.model).toBe(DEFAULT_MODEL);
    expect(parsed.max_tokens).toBe(LLM_MAX_TOKENS);
    expect(parsed.reasoning).toEqual({ effort: "low" });
    expect(parsed.response_format).toEqual({ type: "json_object" });
    expect(parsed.messages[1].content).toHaveLength(MAX_CHARS);
  });

  it("throws UpstreamAuthError on 401/403", async () => {
    stubFetch({ ok: false, status: 401 });
    await expect(completeJson("sys", "user")).rejects.toBeInstanceOf(UpstreamAuthError);
    stubFetch({ ok: false, status: 403 });
    await expect(completeJson("sys", "user")).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});

describe("Tavily clients", () => {
  it("extracts page text", async () => {
    stubFetch({ ok: true, json: async () => ({ results: [{ raw_content: "page text" }] }) });
    await expect(extractPageText("https://x.test/1")).resolves.toBe("page text");
  });

  it("throws a readable error when extraction is empty", async () => {
    stubFetch({ ok: true, json: async () => ({ results: [] }) });
    await expect(extractPageText("https://x.test/1")).rejects.toThrow(/could not extract/i);
  });

  it("throws a readable error on HTTP failure", async () => {
    stubFetch({ ok: false, status: 502 });
    await expect(extractPageText("https://x.test/1")).rejects.toThrow(/status 502/);
  });

  it("posts the url as a urls array", async () => {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        body = init?.body ?? "";
        return { ok: true, json: async () => ({ results: [{ raw_content: "page text" }] }) };
      })
    );
    await extractPageText("https://x.test/1");
    expect(JSON.parse(body)).toEqual({ urls: ["https://x.test/1"] });
  });

  it("throws UpstreamAuthError on 401/403", async () => {
    stubFetch({ ok: false, status: 401 });
    await expect(extractPageText("https://x.test/1")).rejects.toBeInstanceOf(UpstreamAuthError);
    stubFetch({ ok: false, status: 403 });
    await expect(extractPageText("https://x.test/1")).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});

describe("summarizePicked", () => {
  const picks = [article({ url: "u1", title: "a" }), article({ url: "u2", title: "b" })];

  it("aborts the remaining picks on the first auth failure", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const summarize = vi.fn<(article: CandidateArticle) => Promise<unknown>>(async () => {
        throw new UpstreamAuthError("Tavily rejected the API key (status 401)");
      });
      const ok = await summarizePicked(picks, summarize);
      expect(ok).toBe(0);
      expect(summarize).toHaveBeenCalledTimes(1);
    } finally {
      quiet.mockRestore();
    }
  });

  it("counts successes and continues past per-article failures", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const summarize = vi
        .fn<() => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("boom"));
      const ok = await summarizePicked(picks, summarize);
      expect(ok).toBe(1);
      expect(summarize).toHaveBeenCalledTimes(2);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("fetchCandidates", () => {
  it("merges mocked feeds and Hacker News stories, newest first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("hn.algolia.com")) {
          return {
            ok: true,
            json: async () => ({
              hits: [
                {
                  title: "HN story",
                  url: "https://hn.test/a",
                  points: 500,
                  num_comments: 42,
                  created_at_i: 1_700_000_000,
                },
                {
                  title: "low score",
                  url: "https://hn.test/b",
                  points: 5,
                  num_comments: 0,
                  created_at_i: 1_700_000_000,
                },
              ],
            }),
          };
        }
        return { ok: true, text: async () => "<rss></rss>" };
      })
    );
    const { articles, feeds } = await fetchCandidates();
    const rssSeeds = SEED_SOURCES.filter(source => (source.kind ?? "rss") === "rss");
    expect(feeds).toHaveLength(SEED_SOURCES.length);
    expect(feeds.filter(feed => feed.ok)).toHaveLength(rssSeeds.length);
    expect(articles).toHaveLength(rssSeeds.length + 1);
    expect(articles[0].published).toBeGreaterThan(0);
    const hn = articles.find(entry => entry.url === "https://hn.test/a");
    expect(hn?.blurb).toContain("500 points");
    expect(hn?.published).toBe(1_700_000_000);
    expect(hn?.source).toBe("hn");
    expect(articles.some(entry => entry.url === "https://hn.test/b")).toBe(false);
  });

  it("filters Hacker News stories by score and skips self-posts and junk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          hits: [
            {
              title: "keeper",
              url: "https://eng.test/a",
              points: 200,
              num_comments: 10,
              created_at_i: 5,
            },
            { title: "self-post", points: 900, num_comments: 300, created_at_i: 4 },
            {
              title: "hn link",
              url: "https://news.ycombinator.com/item?id=1",
              points: 800,
              created_at_i: 3,
            },
            { title: "no score", url: "https://eng.test/b", created_at_i: 2 },
            { title: "bad url", url: "javascript:alert(1)", points: 500, created_at_i: 1 },
          ],
        }),
      }))
    );
    const stories = await fetchHnStories();
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({
      url: "https://eng.test/a",
      blog: "eng.test",
      published: 5,
    });
  });

  it("records a failed Hacker News call as a feed status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("hn.algolia.com")) return { ok: false, status: 503 };
        return { ok: true, text: async () => "<rss></rss>" };
      })
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { feeds } = await fetchCandidates();
      const hn = feeds.filter(feed => feed.name === "Hacker News");
      expect(hn).toHaveLength(1);
      expect(hn[0].ok).toBe(false);
      expect(hn[0].error).toContain("503");
    } finally {
      quiet.mockRestore();
    }
  });

  it("stops at the refresh deadline and reports only fetched sources", async () => {
    const fetch = vi.fn<
      (
        input: string,
        init?: { signal?: AbortSignal }
      ) => Promise<{ ok: true; text: () => Promise<string> }>
    >((_input, init) => {
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await fetchCandidates(
      [{ name: "Slow", url: "https://slow.test/feed" }],
      undefined,
      Date.now() + 100
    );

    expect(result.fetchedSources).toEqual([]);
    expect(result.feeds).toEqual([]);
    expect(result.articles).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps fast sources when another source in the wave reaches the deadline", async () => {
    const fetch = vi.fn<
      (
        input: string,
        init?: { signal?: AbortSignal }
      ) => Promise<{ ok: true; text: () => Promise<string> }>
    >((input, init) => {
      if (input === "https://slow.test/feed") {
        return new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      }
      return Promise.resolve({ ok: true, text: async () => "<rss></rss>" });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await fetchCandidates(
      [
        { name: "Fast", url: "https://fast.test/feed" },
        { name: "Slow", url: "https://slow.test/feed" },
      ],
      undefined,
      Date.now() + 60
    );

    expect(result.fetchedSources.map(source => source.name)).toEqual(["Fast"]);
    expect(result.feeds).toEqual([{ name: "Fast", ok: true, count: 1 }]);
    expect(result.articles.some(entry => entry.url === "https://feed.test/1")).toBe(true);
  });
});
