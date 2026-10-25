import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_LEARNED_SOURCES, SEED_SOURCES, SOURCE_FAILURE_LIMIT } from "#/features/digest/config";
import {
  dateFromUrl,
  discoverSource,
  extractHtmlLinks,
  feedLinkFromHtml,
  fetchCandidates,
  isLikelyPostUrl,
  isPublicHost,
  pageTitleFromHtml,
  parseSitemap,
  sourceHost,
  sourcePrefix,
  sourcesFor,
  titleFromUrl,
  updateSourceHealth,
} from "#/features/digest/pipeline.server";
import type { DigestCache, TrackedSource } from "#/features/digest/types";

function tracked(overrides: Partial<TrackedSource> = {}): TrackedSource {
  return {
    host: "learned.test",
    name: "Learned",
    url: "https://learned.test/feed",
    kind: "rss",
    origin: "learned",
    addedAt: 1,
    lastOkAt: 1,
    misses: 0,
    ...overrides,
  };
}

function cacheWith(sources?: TrackedSource[]): Pick<DigestCache, "sources"> {
  return { sources };
}

function stubPages(handler: (url: string) => { ok: boolean; text?: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const page = handler(input);
      return {
        ok: page.ok,
        status: page.ok ? 200 : 404,
        text: async () => page.text ?? "",
      };
    })
  );
}

interface PageMock {
  ok: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("source URL helpers", () => {
  it("normalizes the host and finds the blog prefix", () => {
    expect(sourceHost("https://WWW.Example.com/blog/post")).toBe("example.com");
    expect(sourceHost("not a url")).toBe("");
    expect(sourcePrefix("https://x.test/blog/2026/10/post")).toBe("/blog/");
    expect(sourcePrefix("https://x.test/engineering/post")).toBe("/engineering/");
    expect(sourcePrefix("https://x.test/notes/post")).toBe("/notes/");
    expect(sourcePrefix("https://x.test/guide/install")).toBe("/guide/");
    expect(sourcePrefix("https://x.test/2026/10/post")).toBe("/");
    expect(sourcePrefix("https://x.test/post")).toBe("/");
  });

  it("turns slugs into titles and reads dates from paths", () => {
    expect(titleFromUrl("https://x.test/blog/how-we-cut-p99-latency")).toBe(
      "How we cut p99 latency"
    );
    expect(titleFromUrl("https://x.test/blog/post.html")).toBe("Post");
    expect(titleFromUrl("https://x.test/")).toBe("x.test");
    expect(dateFromUrl("https://x.test/2026/10/02/post")).toBe(
      Math.floor(Date.UTC(2026, 9, 2) / 1000)
    );
    expect(dateFromUrl("https://x.test/2026/10/post")).toBe(
      Math.floor(Date.UTC(2026, 9, 1) / 1000)
    );
    expect(dateFromUrl("https://x.test/blog/post")).toBe(0);
  });

  it("keeps posts and drops indexes, tags, sections, and assets", () => {
    expect(isLikelyPostUrl("https://x.test/blog/post", "/blog/")).toBe(true);
    expect(isLikelyPostUrl("https://x.test/blog/2026/10/post", "/blog/")).toBe(true);
    expect(isLikelyPostUrl("https://x.test/blog/", "/blog/")).toBe(false);
    expect(isLikelyPostUrl("https://x.test/blog/tag/rust", "/blog/")).toBe(false);
    expect(isLikelyPostUrl("https://x.test/blog/page/2", "/blog/")).toBe(false);
    expect(isLikelyPostUrl("https://x.test/blog/cover.png", "/blog/")).toBe(false);
    expect(isLikelyPostUrl("https://x.test/blog/feed.xml", "/blog/")).toBe(false);
    expect(isLikelyPostUrl("https://x.test/about", "/")).toBe(false);
    expect(isLikelyPostUrl("https://x.test/post", "/blog/")).toBe(false);
  });

  it("refuses private hosts before making a request", () => {
    expect(isPublicHost("example.com")).toBe(true);
    expect(isPublicHost("localhost")).toBe(false);
    expect(isPublicHost("127.0.0.1")).toBe(false);
    expect(isPublicHost("10.0.0.5")).toBe(false);
    expect(isPublicHost("192.168.1.5")).toBe(false);
    expect(isPublicHost("172.16.0.5")).toBe(false);
    expect(isPublicHost("172.32.0.5")).toBe(true);
    expect(isPublicHost("100.100.100.200")).toBe(false);
    expect(isPublicHost("198.18.0.1")).toBe(false);
    expect(isPublicHost("198.20.0.1")).toBe(true);
    expect(isPublicHost("169.254.169.254")).toBe(false);
    expect(isPublicHost("metadata.google.internal")).toBe(false);
    expect(isPublicHost("[::1]")).toBe(false);
    expect(isPublicHost("fe80::1")).toBe(false);
  });
});

describe("sitemap and index parsing", () => {
  it("parses a urlset, decodes entities, and keeps lastmod", () => {
    const parsed = parseSitemap(`<?xml version="1.0"?>
      <urlset>
        <url><loc>https://x.test/a?b=1&amp;c=2</loc><lastmod>2026-10-01T00:00:00Z</lastmod></url>
        <url><loc>not-a-url</loc></url>
      </urlset>`);
    expect(parsed.entries).toEqual([
      {
        loc: "https://x.test/a?b=1&c=2",
        lastmod: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000),
      },
    ]);
    expect(parsed.children).toEqual([]);
  });

  it("parses a sitemap index and keeps child lastmod", () => {
    const parsed = parseSitemap(`<sitemapindex>
      <sitemap><loc>https://x.test/sitemap-1.xml</loc><lastmod>2026-10-02</lastmod></sitemap>
      <sitemap><loc>https://x.test/sitemap-2.xml</loc></sitemap>
    </sitemapindex>`);
    expect(parsed.entries).toEqual([]);
    expect(parsed.children).toEqual([
      {
        loc: "https://x.test/sitemap-1.xml",
        lastmod: Math.floor(Date.parse("2026-10-02") / 1000),
      },
      { loc: "https://x.test/sitemap-2.xml", lastmod: 0 },
    ]);
  });

  it("rejects a truncated sitemap before the block regex", () => {
    expect(parseSitemap("<urlset><url><loc>https://x.test/a</loc>").entries).toEqual([]);
  });

  it("finds a relative feed link and skips comment feeds", () => {
    expect(
      feedLinkFromHtml(
        '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
        "https://x.test/blog/post"
      )
    ).toBe("https://x.test/feed.xml");
    expect(
      feedLinkFromHtml(
        '<link rel="alternate" type="application/atom+xml" href="/atom">',
        "https://x.test/"
      )
    ).toBe("https://x.test/atom");
    expect(
      feedLinkFromHtml(
        '<link rel="alternate" type="application/rss+xml" title="Comments Feed" href="/comments/feed">',
        "https://x.test/"
      )
    ).toBeNull();
    expect(feedLinkFromHtml('<link rel="stylesheet" href="/a.css">', "https://x.test/")).toBeNull();
  });

  it("reads a page title, preferring og:title and decoding entities", () => {
    expect(pageTitleFromHtml('<meta property="og:title" content="OG &amp; title">')).toBe(
      "OG & title"
    );
    expect(pageTitleFromHtml("<title>Plain title</title>")).toBe("Plain title");
    expect(pageTitleFromHtml('<meta content="Content first" property="og:title">')).toBe(
      "Content first"
    );
  });

  it("extracts same-host post links in document order", () => {
    const links = extractHtmlLinks(
      `<a href="/blog/first-post">First post</a>
       <a href="/blog/2026/10/second-post">Second post</a>
       <a href="/blog/tag/rust">Rust</a>
       <a href="/blog/cover.png">Cover</a>
       <a href="https://other.test/blog/offsite">Offsite</a>
       <a href="/about">About</a>
       <a href="/blog/third-post"><span>Third &amp; final post</span></a>`,
      "https://index.test/blog/",
      "/blog/",
      "Index"
    );
    expect(links.map(link => link.url)).toEqual([
      "https://index.test/blog/first-post",
      "https://index.test/blog/2026/10/second-post",
      "https://index.test/blog/third-post",
    ]);
    expect(links[0].title).toBe("First post");
    expect(links[1].published).toBe(Math.floor(Date.UTC(2026, 9, 1) / 1000));
    expect(links[2].title).toBe("Third & final post");
    expect(links.every(link => link.source === "feed")).toBe(true);
  });

  it("keeps the longest anchor text for duplicate links", () => {
    const links = extractHtmlLinks(
      '<a href="/blog/post">Learn more</a><a href="/blog/post">The actual post title</a>',
      "https://index.test/blog/",
      "/blog/",
      "Index"
    );
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe("The actual post title");
  });
});

describe("source list", () => {
  it("seeds from config and keeps learned sources, dropping stale seeds", () => {
    const learned = tracked();
    const staleSeed = tracked({
      host: "old.test",
      name: "Old",
      url: "https://old.test/feed",
      origin: "seed",
    });
    const seeded = sourcesFor(cacheWith());
    expect(seeded).toHaveLength(SEED_SOURCES.length);
    expect(seeded.every(source => source.origin === "seed")).toBe(true);
    expect(seeded.map(source => source.url)).toEqual(SEED_SOURCES.map(source => source.url));
    expect(seeded.find(source => source.name === "DeepSeek")).toMatchObject({
      kind: "sitemap",
      prefix: "/news/",
      reverse: true,
      hydrateTitles: true,
    });

    const merged = sourcesFor(cacheWith([learned, staleSeed]));
    expect(merged).toHaveLength(SEED_SOURCES.length + 1);
    expect(merged.some(source => source.url === learned.url)).toBe(true);
    expect(merged.some(source => source.url === staleSeed.url)).toBe(false);

    const duplicateHost = tracked({
      host: "qwenlm.github.io",
      url: "https://qwenlm.github.io/other.xml",
    });
    expect(
      sourcesFor(cacheWith([duplicateHost])).some(source => source.url === duplicateHost.url)
    ).toBe(false);
  });

  it("lets config update a seed without losing its health", () => {
    const seed = SEED_SOURCES[0];
    const old = tracked({
      host: sourceHost(seed.url),
      name: "Old name",
      url: seed.url,
      origin: "seed",
      lastOkAt: 42,
      misses: 1,
    });
    const [current] = sourcesFor(cacheWith([old]));
    expect(current.name).toBe(seed.name);
    expect(current).toMatchObject({ lastOkAt: 42, misses: 1, origin: "seed" });
  });

  it("resets health on success and drops learned sources after repeated failures", () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const learned = tracked({ misses: SOURCE_FAILURE_LIMIT - 1 });
      const dropped = updateSourceHealth(
        [learned],
        [learned],
        [{ name: "Learned", ok: false, error: "503" }]
      );
      expect(dropped).toEqual([]);

      const healthy = updateSourceHealth(
        [tracked({ misses: 2, lastOkAt: 1 })],
        [tracked({ misses: 2, lastOkAt: 1 })],
        [{ name: "Learned", ok: true, count: 3 }],
        123
      );
      expect(healthy[0]).toMatchObject({ misses: 0, lastOkAt: 123 });
    } finally {
      quiet.mockRestore();
    }
  });

  it("never drops a seed and caps the learned list", () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const seed = tracked({
        host: "seed.test",
        url: "https://seed.test/feed",
        origin: "seed",
        misses: 99,
      });
      const kept = updateSourceHealth([seed], [seed], [{ name: "Seed", ok: false, error: "503" }]);
      expect(kept).toHaveLength(1);
      expect(kept[0].misses).toBe(100);

      const many = Array.from({ length: MAX_LEARNED_SOURCES + 5 }, (_, i) =>
        tracked({ url: `https://learned.test/${i}`, lastOkAt: i })
      );
      const capped = updateSourceHealth(many, [], []);
      expect(capped).toHaveLength(MAX_LEARNED_SOURCES);
      expect(capped[0].lastOkAt).toBe(MAX_LEARNED_SOURCES + 4);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("fetchCandidates with sitemap and HTML sources", () => {
  it("merges both source kinds and reports one status per source", async () => {
    const older = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const newer = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const sources: TrackedSource[] = [
      tracked({
        host: "index.test",
        name: "Index",
        url: "https://index.test/blog/",
        kind: "html",
        origin: "seed",
        prefix: "/blog/",
        misses: 0,
      }),
      tracked({
        host: "sitemap.test",
        name: "Sitemap",
        url: "https://sitemap.test/sitemap.xml",
        kind: "sitemap",
        origin: "seed",
        prefix: "/posts/",
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("hn.algolia.com")) {
          return { ok: true, json: async () => ({ hits: [] }) };
        }
        if (input.includes("tavily")) {
          return { ok: true, json: async () => ({ results: [] }) };
        }
        if (input === "https://index.test/blog/") {
          return {
            ok: true,
            text: async () =>
              `<a href="/blog/first-post">First post</a>
               <a href="/blog/2020/10/second-post">Second post</a>
               <a href="/blog/tag/rust">Rust</a>`,
          };
        }
        if (input === "https://sitemap.test/sitemap.xml") {
          return {
            ok: true,
            text: async () =>
              `<urlset>
                 <url><loc>https://sitemap.test/posts/one</loc><lastmod>${older}</lastmod></url>
                 <url><loc>https://sitemap.test/tags/x</loc></url>
                 <url><loc>https://evil.test/posts/outside</loc><lastmod>${newer}</lastmod></url>
                 <url><loc>https://sitemap.test/posts/two</loc><lastmod>${newer}</lastmod></url>
               </urlset>`,
          };
        }
        throw new Error(`unexpected fetch ${input}`);
      })
    );

    const { articles, feeds } = await fetchCandidates(sources);
    expect(feeds).toEqual([
      { name: "Index", ok: true, count: 2 },
      { name: "Sitemap", ok: true, count: 2 },
    ]);
    expect(articles.map(article => article.url)).toEqual([
      "https://sitemap.test/posts/two",
      "https://sitemap.test/posts/one",
      "https://index.test/blog/2020/10/second-post",
      "https://index.test/blog/first-post",
    ]);
  });

  it("skips known sitemap entries and stays healthy when nothing is new", async () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const source = tracked({
      host: "sitemap.test",
      name: "Sitemap",
      url: "https://sitemap.test/sitemap.xml",
      kind: "sitemap",
      origin: "seed",
      prefix: "/posts/",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("hn.algolia.com")) {
          return { ok: true, json: async () => ({ hits: [] }) };
        }
        if (input.includes("tavily")) {
          return { ok: true, json: async () => ({ results: [] }) };
        }
        if (input === source.url) {
          return {
            ok: true,
            text: async () =>
              `<urlset><url><loc>https://sitemap.test/posts/one</loc><lastmod>${recent}</lastmod></url></urlset>`,
          };
        }
        throw new Error(`unexpected fetch ${input}`);
      })
    );

    const first = await fetchCandidates([source]);
    expect(first.articles.map(article => article.url)).toEqual(["https://sitemap.test/posts/one"]);

    const second = await fetchCandidates([source], new Set(["https://sitemap.test/posts/one"]));
    expect(second.articles).toEqual([]);
    expect(second.feeds).toEqual([{ name: "Sitemap", ok: true, count: 0 }]);
  });

  it("hydrates sitemap titles from the article page", async () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const source = tracked({
      host: "hydrate.test",
      name: "DeepSeek",
      url: "https://hydrate.test/sitemap.xml",
      kind: "sitemap",
      origin: "seed",
      prefix: "/news/",
      hydrateTitles: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("hn.algolia.com")) {
          return { ok: true, json: async () => ({ hits: [] }) };
        }
        if (input.includes("tavily")) {
          return { ok: true, json: async () => ({ results: [] }) };
        }
        if (input === source.url) {
          return {
            ok: true,
            text: async () =>
              `<urlset><url><loc>https://hydrate.test/news/news261017</loc><lastmod>${recent}</lastmod></url></urlset>`,
          };
        }
        if (input === "https://hydrate.test/news/news261017") {
          return {
            ok: true,
            text: async () => "<html><head><title>DeepSeek-V3 Release</title></head></html>",
          };
        }
        throw new Error(`unexpected fetch ${input}`);
      })
    );

    const { articles } = await fetchCandidates([source]);
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("DeepSeek-V3 Release");
  });

  it("reverses a date-less sitemap when the source asks for it", async () => {
    const source = tracked({
      host: "deepseek.test",
      name: "DeepSeek",
      url: "https://deepseek.test/sitemap.xml",
      kind: "sitemap",
      origin: "seed",
      prefix: "/news/",
      reverse: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("hn.algolia.com")) {
          return { ok: true, json: async () => ({ hits: [] }) };
        }
        if (input.includes("tavily")) {
          return { ok: true, json: async () => ({ results: [] }) };
        }
        if (input === source.url) {
          return {
            ok: true,
            text: async () =>
              `<urlset>
                 <url><loc>https://deepseek.test/news/old</loc></url>
                 <url><loc>https://deepseek.test/news/new</loc></url>
               </urlset>`,
          };
        }
        throw new Error(`unexpected fetch ${input}`);
      })
    );

    const { articles } = await fetchCandidates([source]);
    expect(articles.map(article => article.url)).toEqual([
      "https://deepseek.test/news/new",
      "https://deepseek.test/news/old",
    ]);
  });
});

describe("discoverSource", () => {
  it("prefers the article's own feed link", async () => {
    stubPages(url => {
      if (url === "https://site.test/blog/post") {
        return {
          ok: true,
          text: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
        };
      }
      return { ok: false };
    });
    await expect(discoverSource("https://site.test/blog/post")).resolves.toEqual({
      host: "site.test",
      name: "site.test",
      url: "https://site.test/feed.xml",
      kind: "rss",
      prefix: "/blog/",
    });
  });

  it("falls back to the site root", async () => {
    stubPages(url => {
      if (url === "https://site.test/") {
        return {
          ok: true,
          text: '<link rel="alternate" type="application/atom+xml" href="/atom.xml">',
        };
      }
      return { ok: false };
    });
    await expect(discoverSource("https://site.test/blog/post")).resolves.toMatchObject({
      kind: "rss",
      url: "https://site.test/atom.xml",
    });
  });

  it("falls back to a sitemap from robots.txt", async () => {
    stubPages(url => {
      if (url === "https://site.test/robots.txt") {
        return { ok: true, text: "User-agent: *\nSitemap: https://site.test/sitemap.xml\n" };
      }
      if (url === "https://site.test/sitemap.xml") {
        return {
          ok: true,
          text: "<urlset><url><loc>https://site.test/blog/post</loc></url></urlset>",
        };
      }
      return { ok: false };
    });
    await expect(discoverSource("https://site.test/blog/post")).resolves.toMatchObject({
      kind: "sitemap",
      url: "https://site.test/sitemap.xml",
    });
  });

  it("falls back to an HTML index when there is no feed or sitemap", async () => {
    stubPages(url => {
      if (url === "https://site.test/blog/") {
        return { ok: true, text: '<a href="/blog/post">Post</a>' };
      }
      return { ok: false };
    });
    await expect(discoverSource("https://site.test/blog/post")).resolves.toMatchObject({
      kind: "html",
      url: "https://site.test/blog/",
    });
  });

  it("returns null when nothing usable answers", async () => {
    stubPages(() => ({ ok: false }));
    await expect(discoverSource("https://site.test/blog/post")).resolves.toBeNull();
  });

  it("refuses a redirect to a private host", async () => {
    const fetchMock = vi.fn<(input: string) => Promise<PageMock>>(async input => {
      if (input === "https://site.test/blog/post") {
        return {
          ok: false,
          status: 302,
          headers: { get: () => "http://127.0.0.1/" },
          body: null,
          text: async () => "",
        };
      }
      return { ok: false, status: 404, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverSource("https://site.test/blog/post")).resolves.toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url.includes("127.0.0.1"))).toBe(false);
  });

  it("follows a public relative redirect and reads a streaming body", async () => {
    const fetchMock = vi.fn<(input: string) => Promise<PageMock>>(async input => {
      if (input === "https://site.test/blog/post") {
        return {
          ok: false,
          status: 302,
          headers: { get: () => "/moved" },
          body: null,
          text: async () => "",
        };
      }
      if (input === "https://site.test/moved") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '<link rel="alternate" type="application/rss+xml" href="/feed.xml">'
              )
            );
            controller.close();
          },
        });
        return {
          ok: true,
          status: 200,
          body,
          text: async () => {
            throw new Error("the stream path should be used");
          },
        };
      }
      return { ok: false, status: 404, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverSource("https://site.test/blog/post")).resolves.toMatchObject({
      kind: "rss",
      url: "https://site.test/feed.xml",
    });
  });

  it("rejects a feed link on another host", async () => {
    stubPages(url =>
      url === "https://site.test/blog/post"
        ? {
            ok: true,
            text: '<link rel="alternate" type="application/rss+xml" href="https://evil.test/feed">',
          }
        : { ok: false }
    );

    await expect(discoverSource("https://site.test/blog/post")).resolves.toBeNull();
  });

  it("does not fetch a private candidate host", async () => {
    const fetch = vi.fn<() => Promise<never>>();
    vi.stubGlobal("fetch", fetch);
    await expect(discoverSource("http://127.0.0.1/blog/post")).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
