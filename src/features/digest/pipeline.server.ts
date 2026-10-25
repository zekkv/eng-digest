// oxlint-disable node/no-process-env, no-console
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import Parser from "rss-parser";
import { z } from "zod";
import {
  BLOCKED_HOSTS,
  BLURB_CHARS,
  CANDIDATE_POOL,
  DAILY_SUMMARY_BUDGET,
  DEFAULT_MODEL,
  DEFAULT_PICK_COUNT,
  DISCOVERY_TIMEOUT_MS,
  FEED_BATCH,
  FEED_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  FORCE_REFRESH_COOLDOWN_SECONDS,
  HN_FRONT_PAGE_URL,
  HN_MAX_STORIES,
  HN_MIN_POINTS,
  MANUAL_REFRESH_BUDGET_MS,
  MANUAL_SOURCE_TIMEOUT_MS,
  MAX_CONCURRENT_SUMMARIES,
  MAX_LEARNED_SOURCES,
  MAX_NEW_SOURCES_PER_RUN,
  MAX_PER_FEED,
  PAGE_MAX_BYTES,
  PROMPT,
  SEED_SOURCES,
  SELECT_PROMPT,
  SITEMAP_CHILD_LIMIT,
  SITEMAP_LOOKBACK_DAYS,
  SOURCE_FAILURE_LIMIT,
} from "#/features/digest/config";
import type { DigestFeed } from "#/features/digest/config";
import type { ChatCompletion } from "#/features/digest/clients.server";
import { UpstreamAuthError, completeJson, extractPageText } from "#/features/digest/clients.server";
import { loadCache, mergeArticles, saveCache, withCacheLock } from "#/features/digest/store.server";
import type {
  CandidateArticle,
  Difficulty,
  DigestCache,
  DigestPayload,
  FeedStatus,
  JargonTerm,
  SourceKind,
  Summary,
  TrackedSource,
} from "#/features/digest/types";
import { isHttpUrl } from "#/features/digest/url";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hostnameOf(url: string, fallback = ""): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Lowercased host without `www.`. This is the key for learned-source dedupe. */
export function sourceHost(url: string): string {
  return hostnameOf(url)
    .toLowerCase()
    .replace(/^www\./, "");
}

const SECTION_SEGMENTS = new Set([
  "blog",
  "blogs",
  "posts",
  "articles",
  "engineering",
  "tech",
  "news",
  "writing",
]);

/** Best-effort blog path prefix, so a docs sitemap cannot flood the digest.
 * `/blog/2026/post` becomes `/blog/`; `/notes/post` becomes `/notes/`;
 * date-rooted `/2026/10/post` stays `/`. */
export function sourcePrefix(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length === 0) return "/";
    const section = parts.findIndex(part => SECTION_SEGMENTS.has(part.toLowerCase()));
    if (section !== -1) return `/${parts.slice(0, section + 1).join("/")}/`;
    if (parts.length < 2) return "/";
    const first = parts[0].toLowerCase();
    if (/^\d{4}$/.test(first) || /^\d{1,2}$/.test(first)) return "/";
    return `/${parts[0]}/`;
  } catch {
    return "/";
  }
}

/** A readable title from a URL slug, used when a sitemap or index gives no title. */
export function titleFromUrl(raw: string): string {
  try {
    const parts = new URL(raw).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const last = parts.pop() ?? "";
    let slug = last;
    try {
      slug = decodeURIComponent(last);
    } catch {
      // Keep the raw segment when the percent-encoding is malformed.
    }
    slug = slug
      .replace(/\.(?:html?|php|aspx?)$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
    if (!slug) return hostnameOf(raw, raw);
    return slug.charAt(0).toUpperCase() + slug.slice(1);
  } catch {
    return raw;
  }
}

/** A date embedded in the URL path, as epoch seconds. Zero when there is none. */
export function dateFromUrl(raw: string): number {
  try {
    const match = /(20\d{2})[/-](\d{2})(?:[/-](\d{2}))?/.exec(new URL(raw).pathname);
    if (!match) return 0;
    const month = Number(match[2]);
    const day = Number(match.at(3) ?? "1");
    if (month < 1 || month > 12 || day < 1 || day > 31) return 0;
    return Math.floor(Date.UTC(Number(match[1]), month - 1, day) / 1000);
  } catch {
    return 0;
  }
}

const NON_POST_SEGMENTS = new Set([
  "about",
  "archive",
  "archives",
  "author",
  "authors",
  "blogroll",
  "book",
  "career",
  "careers",
  "category",
  "categories",
  "contact",
  "cookie",
  "cookies",
  "cv",
  "donate",
  "events",
  "feed",
  "feeds",
  "home",
  "index",
  "jobs",
  "legal",
  "links",
  "login",
  "newsletter",
  "now",
  "page",
  "photos",
  "podcast",
  "podcasts",
  "portfolio",
  "privacy",
  "projects",
  "resume",
  "rss",
  "search",
  "series",
  "shop",
  "signup",
  "sitemap",
  "speaking",
  "sponsors",
  "store",
  "subscribe",
  "tag",
  "tags",
  "talks",
  "terms",
  "uses",
  "videos",
]);

const ASSET_EXTENSION =
  /\.(?:avif|css|eot|gif|ico|jpe?g|js|json|mjs|mp3|mp4|pdf|png|svg|ttf|txt|webp|woff2?|xml|zip)$/i;

/** True for a URL that looks like a post, not a tag, section, asset, or index page. */
export function isLikelyPostUrl(raw: string, prefix = "/"): boolean {
  if (!isHttpUrl(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const { pathname } = parsed;
  if (pathname === "/" || pathname === prefix) return false;
  if (!pathname.startsWith(prefix)) return false;
  if (ASSET_EXTENSION.test(pathname)) return false;
  const segments = pathname.split("/").filter(Boolean);
  const lowered = segments.map(segment => segment.toLowerCase());
  if (lowered.some(segment => NON_POST_SEGMENTS.has(segment))) return false;
  const last = lowered.at(-1) ?? "";
  if (SECTION_SEGMENTS.has(last)) return false;
  return segments.length > 0;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

export interface SitemapEntry {
  loc: string;
  lastmod: number;
}

/** Parse a urlset or a sitemapindex without an XML dependency. */
export function parseSitemap(xml: string): {
  entries: SitemapEntry[];
  children: SitemapEntry[];
} {
  // Reject a malformed body before the lazy block regex can scan to end-of-file
  // at every opener. A truncated CDN response must not wedge the event loop.
  const opens = xml.match(/<(?:url|sitemap)\b/gi)?.length ?? 0;
  const closes = xml.match(/<\/(?:url|sitemap)>/gi)?.length ?? 0;
  if (opens > 20_000 || closes !== opens) return { entries: [], children: [] };
  const entries: SitemapEntry[] = [];
  const children: SitemapEntry[] = [];
  for (const block of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const kind = block[1].toLowerCase();
    const body = block[2];
    const loc = decodeXml(body.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1]?.trim() ?? "");
    if (!loc || !isHttpUrl(loc)) continue;
    const rawDate = body.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1];
    const stamp = rawDate ? Date.parse(rawDate) : Number.NaN;
    const entry = { loc, lastmod: Number.isNaN(stamp) ? 0 : Math.floor(stamp / 1000) };
    if (kind === "sitemap") children.push(entry);
    else entries.push(entry);
  }
  return { entries, children };
}

/** A page title for slug-only sitemap entries. Prefer og:title, then <title>. */
export function pageTitleFromHtml(html: string): string {
  const meta =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
  const raw = meta ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return decodeXml(stripHtml(raw)).trim().slice(0, 200);
}

/** The first non-comment RSS/Atom link in a page's head. */
export function feedLinkFromHtml(html: string, base: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*alternate/i.test(tag)) continue;
    if (!/\btype\s*=\s*["']application\/(?:rss|atom)\+xml/i.test(tag)) continue;
    const href = decodeXml(tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? "");
    if (!href) continue;
    const title = tag.match(/\btitle\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    if (/comment/i.test(title) || /\/comments?\//i.test(href)) continue;
    try {
      const resolved = new URL(href, base);
      if (isHttpUrl(resolved.href)) return resolved.href;
    } catch {
      // Try the next link tag.
    }
  }
  return null;
}

/** Same-host post links from an index page, in document order (newest first on most blogs). */
export function extractHtmlLinks(
  html: string,
  base: string,
  prefix: string,
  blog: string
): CandidateArticle[] {
  // A truncated page with unclosed anchors is not worth the regex scan.
  const opens = html.match(/<a\b/gi)?.length ?? 0;
  const closes = html.match(/<\/a>/gi)?.length ?? 0;
  if (opens > 10_000 || closes < opens) return [];
  const baseHost = sourceHost(base);
  const byUrl = new Map<string, CandidateArticle>();
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  )) {
    let resolved: URL;
    try {
      resolved = new URL(match[1], base);
    } catch {
      continue;
    }
    if (sourceHost(resolved.href) !== baseHost) continue;
    resolved.hash = "";
    const url = resolved.href;
    if (!isLikelyPostUrl(url, prefix)) continue;
    const text = decodeXml(stripHtml(match[2])).slice(0, 200);
    const existing = byUrl.get(url);
    if (existing) {
      // Cards often link the same post twice: a "Learn more" CTA, then the title.
      if (text.length > existing.title.length) existing.title = text;
      continue;
    }
    byUrl.set(url, {
      url,
      title: text || titleFromUrl(url),
      blog,
      published: dateFromUrl(url),
      blurb: "",
      source: "feed",
    });
  }
  return [...byUrl.values()].slice(0, MAX_PER_FEED);
}

/** True for a hostname that is safe to fetch from the server. Guards the discovery
 * path: candidate URLs come from HN and Tavily, not from config. */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain")
  ) {
    return false;
  }
  if (/^(?:0|10|127|169\.254|192\.168)\./.test(host)) return false;
  if (host.startsWith("192.0.0.")) return false;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
  if (/^198\.1[89]\./.test(host)) return false;
  if (host === "metadata" || host === "metadata.google.internal" || host === "instance-data") {
    return false;
  }
  // IPv6 literals are refused outright: no digest source uses one, and this removes
  // loopback, v4-mapped, link-local, and unique-local bypasses in one rule.
  if (host.startsWith("[") || host.includes(":")) return false;
  // A name can still rebind between this check and the fetch; the DNS guard
  // below rejects a resolved private address.
  return true;
}

const DNS_CHECK = process.env.DIGEST_DNS_CHECK !== "0";

/** Reject a public name that resolves to a private address. A failed lookup is
 * left to the fetch; an unresolvable name cannot reach a private target. */
async function assertPublicDns(hostname: string): Promise<void> {
  if (!DNS_CHECK || isIP(hostname)) return;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return;
  }
  for (const { address, family } of addresses) {
    if (family === 4) {
      if (!isPublicHost(address)) throw new Error("refusing a private address");
      continue;
    }
    const bare = address.toLowerCase();
    if (bare.startsWith("::ffff:")) {
      if (!isPublicHost(bare.slice(7))) throw new Error("refusing a private address");
      continue;
    }
    if (bare === "::1" || bare === "::" || /^f[cd]/.test(bare) || bare.startsWith("fe80")) {
      throw new Error("refusing a private address");
    }
  }
}

interface PageResponse {
  ok: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
}

const USER_AGENT = "Mozilla/5.0 (compatible; engineering-digest/1.0)";
const MAX_REDIRECTS = 5;

/** Read at most `maxBytes`. The stream path bounds chunked bodies; the text path
 * keeps the test doubles and unusual runtimes working. */
async function readCapped(response: PageResponse, maxBytes: number): Promise<string> {
  const length = Number(response.headers?.get("content-length") ?? "");
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("response too large");
  }
  if (!response.body) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("response too large");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- stream chunks are read in order
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // oxlint-disable-next-line no-await-in-loop -- only on the over-size path
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Fetch a page as text. Redirects are followed manually so every hop re-enters the
 * public-host guard. The UA identifies the digest. */
async function fetchPage(
  url: string,
  maxBytes = PAGE_MAX_BYTES,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (!isPublicHost(parsed.hostname)) throw new Error("refusing a private host");
    // oxlint-disable-next-line no-await-in-loop -- each redirect hop is checked
    await assertPublicDns(parsed.hostname);
    // oxlint-disable-next-line no-await-in-loop -- redirects are followed one hop at a time
    const response = (await fetch(current, {
      redirect: "manual",
      signal,
      headers: { "user-agent": USER_AGENT },
    })) as PageResponse;
    const status = response.status ?? 200;
    if (status >= 300 && status < 400) {
      const location = response.headers?.get("location");
      if (!location) throw new Error(`status ${status}`);
      // oxlint-disable-next-line no-await-in-loop -- only on a redirect hop
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      // oxlint-disable-next-line no-await-in-loop -- only on the error path
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`status ${status}`);
    }
    return readCapped(response, maxBytes);
  }
  throw new Error("too many redirects");
}

interface FeedItemInput {
  link?: string;
  title?: string;
  content?: string;
  summary?: string;
  contentSnippet?: string;
  isoDate?: string;
  pubDate?: string;
}

/** Map one RSS/Atom entry to a candidate; entries without url/title or invalid URL are dropped. */
export function toCandidate(blog: string, item: FeedItemInput): CandidateArticle | null {
  const url = item.link?.trim();
  const title = item.title?.trim();
  if (!url || !title || !isHttpUrl(url)) return null;
  const plain = stripHtml(item.content ?? item.summary ?? item.contentSnippet ?? "");
  const stamp = Date.parse(item.isoDate ?? item.pubDate ?? "");
  return {
    url,
    title,
    blog,
    published: Number.isNaN(stamp) ? 0 : Math.floor(stamp / 1000),
    blurb: plain.slice(0, BLURB_CHARS),
    source: "feed",
  };
}

async function fetchRssFeed(
  parser: Parser,
  source: DigestFeed,
  timeoutMs = FETCH_TIMEOUT_MS,
  budgeted = false
): Promise<{ articles: CandidateArticle[]; status: FeedStatus } | null> {
  try {
    // parseURL wraps node:http, which edge runtimes do not have; fetching with
    // the portable global fetch and parsing the text keeps both runtimes equal.
    // The identifying UA is required by some feeds (Reddit 403s an empty one).
    const parsed = await parser.parseString(await fetchPage(source.url, FEED_MAX_BYTES, timeoutMs));
    if (parsed.items.length === 0) throw new Error("no entries");
    const articles = parsed.items
      .slice(0, MAX_PER_FEED)
      .map((item: FeedItemInput) => toCandidate(source.name, item))
      .filter((article): article is CandidateArticle => article !== null);
    return { articles, status: { name: source.name, ok: true, count: articles.length } };
  } catch (error) {
    if (budgeted) return null;
    return {
      articles: [],
      status: { name: source.name, ok: false, error: messageOf(error).slice(0, 120) },
    };
  }
}

/** Read a urlset, following one level of sitemap index children. Post sitemaps win
 * over category/page sitemaps when an index offers both. */
async function readSitemap(
  url: string,
  depth = 0,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<SitemapEntry[]> {
  const parsed = parseSitemap(await fetchPage(url, FEED_MAX_BYTES, timeoutMs));
  if (parsed.entries.length > 0 || depth >= 1 || parsed.children.length === 0) {
    return parsed.entries;
  }
  const rootHost = sourceHost(url);
  const children = parsed.children
    .filter(child => sameSiteHost(sourceHost(child.loc), rootHost))
    .map((child, index) => ({
      loc: child.loc,
      lastmod: child.lastmod,
      postish: /(post|blog|article|news)/i.test(child.loc) ? 1 : 0,
      date: dateFromUrl(child.loc),
      index,
    }))
    .toSorted(
      (a, b) =>
        b.postish - a.postish || (b.lastmod || b.date) - (a.lastmod || a.date) || a.index - b.index
    )
    .slice(0, SITEMAP_CHILD_LIMIT);
  const nested = await Promise.all(
    children.map(child => readSitemap(child.loc, depth + 1, timeoutMs).catch(() => []))
  );
  return nested.flat();
}

async function fetchSitemapSource(
  source: DigestFeed,
  knownUrls?: ReadonlySet<string>,
  timeoutMs = FETCH_TIMEOUT_MS,
  budgeted = false
): Promise<{ articles: CandidateArticle[]; status: FeedStatus } | null> {
  try {
    const entries = await readSitemap(source.url, 0, timeoutMs);
    const prefix = source.prefix ?? "/";
    const rootHost = sourceHost(source.url);
    const postEntries = entries.filter(
      entry => sameSiteHost(sourceHost(entry.loc), rootHost) && isLikelyPostUrl(entry.loc, prefix)
    );
    if (postEntries.length === 0) throw new Error("no post entries");
    // lastmod wins; otherwise the URL date is a usable recency signal.
    const cutoff = nowSec() - SITEMAP_LOOKBACK_DAYS * 24 * 3600;
    const ordered = postEntries
      .map(entry => ({
        loc: entry.loc,
        lastmod: entry.lastmod,
        order: entry.lastmod || dateFromUrl(entry.loc),
      }))
      .filter(entry => entry.order === 0 || entry.order >= cutoff)
      .toSorted((a, b) => b.order - a.order);
    // Some sitemaps are date-less and emitted oldest-first. Only trust the
    // per-source flag when there are no dates to sort by.
    if (source.reverse && ordered.every(entry => entry.order === 0)) ordered.reverse();
    // For a reversed, date-less sitemap, the top entries are the only recent ones.
    // Do not walk into the archive just because the top entries are already known.
    const windowed = source.reverse ? ordered.slice(0, MAX_PER_FEED) : ordered;
    const seen = new Set<string>();
    const articles: CandidateArticle[] = [];
    for (const entry of windowed) {
      if (seen.has(entry.loc) || knownUrls?.has(entry.loc)) continue;
      seen.add(entry.loc);
      articles.push({
        url: entry.loc,
        title: titleFromUrl(entry.loc),
        blog: source.name,
        published: entry.order,
        blurb: "",
        source: "feed",
      });
      if (articles.length >= MAX_PER_FEED) break;
    }
    if (source.hydrateTitles && articles.length > 0) {
      await Promise.all(
        articles.map(async article => {
          try {
            const html = await fetchPage(article.url, PAGE_MAX_BYTES, timeoutMs);
            const title = pageTitleFromHtml(html);
            if (title) article.title = title;
          } catch {
            // Keep the slug title when the page will not answer.
          }
        })
      );
    }
    return { articles, status: { name: source.name, ok: true, count: articles.length } };
  } catch (error) {
    if (budgeted) return null;
    return {
      articles: [],
      status: { name: source.name, ok: false, error: messageOf(error).slice(0, 120) },
    };
  }
}

async function fetchHtmlSource(
  source: DigestFeed,
  timeoutMs = FETCH_TIMEOUT_MS,
  budgeted = false
): Promise<{ articles: CandidateArticle[]; status: FeedStatus } | null> {
  try {
    const html = await fetchPage(source.url, PAGE_MAX_BYTES, timeoutMs);
    const articles = extractHtmlLinks(html, source.url, source.prefix ?? "/", source.name);
    if (articles.length === 0) throw new Error("no entries");
    return { articles, status: { name: source.name, ok: true, count: articles.length } };
  } catch (error) {
    if (budgeted) return null;
    return {
      articles: [],
      status: { name: source.name, ok: false, error: messageOf(error).slice(0, 120) },
    };
  }
}

async function fetchSource(
  parser: Parser,
  source: DigestFeed,
  knownUrls?: ReadonlySet<string>,
  timeoutMs = FETCH_TIMEOUT_MS,
  budgeted = false
): Promise<{ articles: CandidateArticle[]; status: FeedStatus } | null> {
  const kind = source.kind ?? "rss";
  if (kind === "sitemap") return fetchSitemapSource(source, knownUrls, timeoutMs, budgeted);
  if (kind === "html") return fetchHtmlSource(source, timeoutMs, budgeted);
  return fetchRssFeed(parser, source, timeoutMs, budgeted);
}

/** A sitemap URL from robots.txt or the common paths, verified to be a sitemap. */
async function discoverSitemap(
  host: string,
  prefix: string,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<string | null> {
  const root = `https://${host}`;
  const candidates: string[] = [];
  try {
    const robots = await fetchPage(`${root}/robots.txt`, PAGE_MAX_BYTES, timeoutMs);
    for (const match of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      const url = decodeXml(match[1]);
      if (isHttpUrl(url) && sameSiteHost(sourceHost(url), host)) candidates.push(url);
    }
  } catch {
    // Plenty of sites have no robots.txt.
  }
  candidates.push(
    `${root}/sitemap.xml`,
    `${root}/sitemap_index.xml`,
    `${root}/sitemap-index.xml`,
    `${root}/wp-sitemap.xml`
  );
  if (prefix !== "/") candidates.push(`${root}${prefix}sitemap.xml`);
  for (const candidate of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- candidates are probed in order
      const xml = await fetchPage(candidate, FEED_MAX_BYTES, timeoutMs);
      if (/<(?:urlset|sitemapindex)\b/i.test(xml)) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export interface DiscoveredSource {
  host: string;
  name: string;
  url: string;
  kind: SourceKind;
  prefix: string;
}

function sameSiteHost(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** A feed is only accepted from the article's own site. This keeps a picked page
 * from turning an unrelated (or blocklisted) feed into a long-lived source. */
function feedForHost(feed: string | null, host: string): string | null {
  if (!feed) return null;
  const feedHost = sourceHost(feed);
  if (!sameSiteHost(feedHost, host)) return null;
  if (hostIsBlocked(feedHost) || !isPublicHost(feedHost)) return null;
  return feed;
}

/** Resolve a picked post into something the fetcher can poll daily.
 * Prefer the article's own feed link, then the site root, then a sitemap, then an index page. */
export async function discoverSource(articleUrl: string): Promise<DiscoveredSource | null> {
  const host = sourceHost(articleUrl);
  if (!host || hostIsBlocked(host) || !isPublicHost(host)) return null;
  const prefix = sourcePrefix(articleUrl);
  const timeout = DISCOVERY_TIMEOUT_MS;
  let rootHtml: string | null = null;
  try {
    const html = await fetchPage(articleUrl, PAGE_MAX_BYTES, timeout);
    const feed = feedForHost(feedLinkFromHtml(html, articleUrl), host);
    if (feed) return { host, name: host, url: feed, kind: "rss", prefix };
  } catch {
    // The article may block plain fetches; the site root may still work.
  }
  const root = `https://${host}/`;
  try {
    rootHtml = await fetchPage(root, PAGE_MAX_BYTES, timeout);
    const feed = feedForHost(feedLinkFromHtml(rootHtml, root), host);
    if (feed) return { host, name: host, url: feed, kind: "rss", prefix };
  } catch {
    // Fall through to sitemap and index discovery.
  }
  const sitemap = await discoverSitemap(host, prefix, timeout);
  if (sitemap) return { host, name: host, url: sitemap, kind: "sitemap", prefix };
  if (prefix === "/") {
    if (rootHtml && extractHtmlLinks(rootHtml, root, prefix, host).length > 0) {
      return { host, name: host, url: root, kind: "html", prefix };
    }
  } else {
    const indexUrl = `${root}${prefix.replace(/^\//, "")}`;
    try {
      const html = await fetchPage(indexUrl, PAGE_MAX_BYTES, timeout);
      if (extractHtmlLinks(html, indexUrl, prefix, host).length > 0) {
        return { host, name: host, url: indexUrl, kind: "html", prefix };
      }
    } catch {
      // No usable index page.
    }
  }
  return null;
}

function seedEntry(seed: DigestFeed, now: number, existing?: TrackedSource): TrackedSource {
  return {
    host: sourceHost(seed.url),
    name: seed.name,
    url: seed.url,
    kind: seed.kind ?? "rss",
    origin: "seed",
    prefix: seed.prefix ?? existing?.prefix,
    reverse: seed.reverse ?? existing?.reverse,
    hydrateTitles: seed.hydrateTitles ?? existing?.hydrateTitles,
    addedAt: existing?.addedAt ?? now,
    lastOkAt: existing?.lastOkAt ?? 0,
    misses: existing?.misses ?? 0,
  };
}

/** Seeds from config plus learned sources from the cache. Seeds always win,
 * and a seed removed from config is dropped from the cache. */
export function sourcesFor(cache: Pick<DigestCache, "sources">, now = nowSec()): TrackedSource[] {
  const seedsByUrl = new Map(SEED_SOURCES.map(seed => [seed.url, seed]));
  const seedHosts = new Set(SEED_SOURCES.map(seed => sourceHost(seed.url)));
  const entries = new Map<string, TrackedSource>();
  for (const source of cache.sources ?? []) {
    if (source.origin === "seed" && !seedsByUrl.has(source.url)) continue;
    if (source.origin === "learned" && seedHosts.has(source.host)) continue;
    entries.set(source.url, source);
  }
  for (const seed of SEED_SOURCES) {
    entries.set(seed.url, seedEntry(seed, now, entries.get(seed.url)));
  }
  return capLearnedSources([...entries.values()]);
}

function hostIsBlocked(host: string): boolean {
  return BLOCKED_HOSTS.some(blocked => host === blocked || host.endsWith(`.${blocked}`));
}

/** Keep every seed, cap learned sources at the most recently successful. */
function capLearnedSources(sources: TrackedSource[]): TrackedSource[] {
  const seeds = sources.filter(source => source.origin === "seed");
  const learned = sources
    .filter(source => source.origin === "learned")
    .toSorted((a, b) => b.lastOkAt - a.lastOkAt)
    .slice(0, MAX_LEARNED_SOURCES);
  return [...seeds, ...learned];
}

/** Apply fetch outcomes to the source list. Learned sources drop out after repeated failures. */
export function updateSourceHealth(
  current: TrackedSource[],
  fetched: DigestFeed[],
  statuses: Array<FeedStatus | undefined>,
  now = nowSec()
): TrackedSource[] {
  const statusByUrl = new Map<string, FeedStatus>();
  fetched.forEach((source, index) => {
    const status = statuses[index];
    if (status) statusByUrl.set(source.url, status);
  });
  const updated = current.map(source => {
    const status = statusByUrl.get(source.url);
    if (!status) return source;
    if (status.ok) return { ...source, lastOkAt: now, misses: 0 };
    return { ...source, misses: source.misses + 1 };
  });
  const kept = updated.filter(
    source => source.origin === "seed" || source.misses < SOURCE_FAILURE_LIMIT
  );
  for (const source of updated) {
    if (!kept.includes(source)) {
      console.log(`  dropped source ${source.host} after ${source.misses} failures`);
    }
  }
  return capLearnedSources(kept);
}

/** Promote hosts of successful picks into tracked sources. Best-effort:
 * a discovery failure only costs a log line. Discovery-sourced candidates only;
 * RSS candidates already have a tracked source. */
export async function learnSources(picked: CandidateArticle[]): Promise<void> {
  const cache = await loadCache();
  const sources = sourcesFor(cache);
  const knownHosts = new Set(sources.map(source => source.host));
  const seenHosts = new Set<string>();
  const discovered: TrackedSource[] = [];
  let attempts = 0;
  for (const article of picked) {
    if (article.source !== "search" && article.source !== "hn") continue;
    const host = sourceHost(article.url);
    if (!host || knownHosts.has(host) || seenHosts.has(host) || hostIsBlocked(host)) continue;
    if (attempts >= MAX_NEW_SOURCES_PER_RUN) {
      console.log(`  source discovery budget spent (${MAX_NEW_SOURCES_PER_RUN})`);
      break;
    }
    seenHosts.add(host);
    attempts += 1;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one discovery per new host, once a day
      const found = await discoverSource(article.url);
      if (!found) {
        console.log(`  could not discover a source for ${host}`);
        continue;
      }
      const now = nowSec();
      discovered.push({
        ...found,
        origin: "learned",
        addedAt: now,
        lastOkAt: now,
        misses: 0,
      });
      console.log(`  learned source ${host} (${found.kind})`);
    } catch (error) {
      console.log(`  source discovery failed for ${host}: ${messageOf(error).slice(0, 120)}`);
    }
  }
  if (discovered.length === 0) return;
  await withCacheLock(async () => {
    const fresh = await loadCache();
    const current = sourcesFor(fresh);
    const currentHosts = new Set(current.map(source => source.host));
    const currentUrls = new Set(current.map(source => source.url));
    const additions = discovered.filter(
      source => !currentHosts.has(source.host) && !currentUrls.has(source.url)
    );
    if (additions.length === 0) return;
    fresh.sources = capLearnedSources([...current, ...additions]);
    await saveCache(fresh);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Hacker News front page discovery: stories with an external link and enough points
 * become candidates carrying their score, which the feeds cannot signal. */
export async function fetchHnStories(timeoutMs = 30_000): Promise<CandidateArticle[]> {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- HN_MIN_POINTS is a config knob; 0 disables HN discovery
  if (HN_MIN_POINTS <= 0) return [];
  const response = await fetch(HN_FRONT_PAGE_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || !("hits" in data) || !Array.isArray(data.hits)) {
    throw new Error("unexpected response shape");
  }
  const hits: unknown[] = data.hits;
  const stories: CandidateArticle[] = [];
  for (const raw of hits) {
    if (!isRecord(raw)) continue;
    const { title, url, points, num_comments, created_at_i } = raw;
    if (typeof title !== "string" || typeof url !== "string") continue; // self-posts have no url
    if (typeof points !== "number" || points < HN_MIN_POINTS) continue;
    if (!/^https?:\/\//.test(url) || url.includes("news.ycombinator.com")) continue;
    const comments = typeof num_comments === "number" ? num_comments : 0;
    stories.push({
      url,
      title,
      blog: hostnameOf(url, "web"),
      published: typeof created_at_i === "number" ? created_at_i : 0,
      blurb: `${points} points · ${comments} comments on Hacker News`,
      source: "hn",
    });
  }
  return stories.toSorted((a, b) => b.published - a.published).slice(0, HN_MAX_STORIES);
}

/** Tracked sources plus Hacker News discovery, merged into one newest-first candidate pool.
 * `feeds` keeps the source statuses first, in the same order as `fetchedSources`. */
export async function fetchCandidates(
  sources: DigestFeed[] = SEED_SOURCES,
  knownUrls?: ReadonlySet<string>,
  deadline?: number
): Promise<{
  articles: CandidateArticle[];
  feeds: FeedStatus[];
  fetchedSources: DigestFeed[];
}> {
  const parser = new Parser();
  // Sources are fetched in small waves: dozens of parallel fetches queue behind a
  // serverless platform's connection limits, and late sources then trip their own
  // timeout even though the source is healthy.
  const settled: NonNullable<Awaited<ReturnType<typeof fetchSource>>>[] = [];
  const fetchedSources: DigestFeed[] = [];
  for (let index = 0; index < sources.length; index += FEED_BATCH) {
    const remaining = deadline === undefined ? FETCH_TIMEOUT_MS : deadline - Date.now();
    if (remaining <= 0) break;
    const timeoutMs =
      deadline === undefined
        ? FETCH_TIMEOUT_MS
        : Math.max(1, Math.min(MANUAL_SOURCE_TIMEOUT_MS, remaining));
    const batch = sources.slice(index, index + FEED_BATCH);
    // oxlint-disable-next-line no-await-in-loop -- waves are the point
    const results = await Promise.all(
      batch.map(source => fetchSource(parser, source, knownUrls, timeoutMs, deadline !== undefined))
    );
    for (const [batchIndex, result] of results.entries()) {
      if (result === null) continue;
      settled.push(result);
      fetchedSources.push(batch[batchIndex]);
    }
  }
  const articles = settled.flatMap(result => result.articles);
  const feeds = settled.map(result => result.status);
  // Hacker News is best-effort discovery too: its front page surfaces the day's
  // popular engineering posts, and the score gives the picker a signal feeds lack.
  const hnRemaining = deadline === undefined ? 30_000 : deadline - Date.now();
  if (hnRemaining >= 1_000) {
    try {
      articles.push(...(await fetchHnStories(Math.min(30_000, hnRemaining))));
    } catch (error) {
      const message = messageOf(error).slice(0, 120);
      console.error(`  hacker news failed: ${message}`);
      feeds.push({ name: "Hacker News", ok: false, error: message });
    }
  }
  return {
    articles: articles.toSorted((a, b) => b.published - a.published),
    feeds,
    fetchedSources,
  };
}

const PickerOutput = z.object({ picked: z.array(z.unknown()).optional() });

/** Ask the LLM to pick the best n; fall back to newest on any failure. */
export async function selectInteresting(
  candidates: CandidateArticle[],
  n: number,
  complete: ChatCompletion = completeJson
): Promise<CandidateArticle[]> {
  const listed = candidates
    .map(a => `- ${a.url} | ${a.blog}: ${a.title} — ${a.blurb.slice(0, 180)}`)
    .join("\n");
  try {
    const parsed = PickerOutput.safeParse(
      await complete(SELECT_PROMPT.replace("{n}", String(n)), listed)
    );
    const picked = new Set(
      parsed.success
        ? (parsed.data.picked ?? []).filter((url): url is string => typeof url === "string")
        : []
    );
    const chosen = candidates.filter(a => picked.has(a.url)).slice(0, n);
    if (chosen.length > 0) {
      // The picker may match fewer than n; top up with the newest remaining.
      if (chosen.length < n) {
        const seen = new Set(chosen.map(a => a.url));
        chosen.push(...candidates.filter(a => !seen.has(a.url)).slice(0, n - chosen.length));
      }
      return chosen;
    }
    console.log("  picker returned nothing usable; using newest posts");
  } catch (error) {
    console.log(`  picker failed (${messageOf(error).slice(0, 100)}); using newest posts`);
  }
  return candidates.slice(0, n);
}

function isDifficulty(value: string): value is Difficulty {
  return value === "beginner" || value === "intermediate" || value === "advanced";
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Coerce raw LLM JSON into a Summary; validates non-empty tldr and keyPoints. */
export function normalizeSummary(
  data: unknown,
  model: string,
  now = Math.floor(Date.now() / 1000)
): Summary {
  if (typeof data !== "object" || data === null) {
    throw new Error("summary is not an object");
  }
  const tldr = "tldr" in data ? toText(data.tldr).trim() : "";
  if (!tldr) throw new Error("summary missing tldr");
  const rawKeyPoints =
    "key_points" in data && Array.isArray(data.key_points)
      ? data.key_points.map(point => toText(point).trim()).filter(Boolean)
      : [];
  const keyPoints = [...new Set(rawKeyPoints)];
  if (keyPoints.length === 0) throw new Error("summary missing key points");

  const rawJargon =
    "jargon" in data && Array.isArray(data.jargon)
      ? data.jargon.filter(
          (entry): entry is { term?: unknown; explanation?: unknown } =>
            typeof entry === "object" && entry !== null
        )
      : [];
  const seenTerms = new Set<string>();
  const jargon: JargonTerm[] = [];
  for (const entry of rawJargon) {
    const term = toText(entry.term).trim();
    const explanation = toText(entry.explanation).trim();
    if (!term || !explanation) continue;
    const lower = term.toLowerCase();
    if (seenTerms.has(lower)) continue;
    seenTerms.add(lower);
    jargon.push({ term, explanation });
  }

  const difficulty =
    "difficulty" in data && typeof data.difficulty === "string"
      ? data.difficulty.trim().toLowerCase()
      : "";
  return {
    tldr,
    keyPoints: keyPoints.slice(0, 8),
    jargon: jargon.slice(0, 12),
    difficulty: isDifficulty(difficulty) ? difficulty : "",
    model,
    generatedAt: now,
    // The model-reported count is unreachable in production: summarizeArticle always
    // overwrites words from the extracted page, so the honest count wins here too.
    words: 0,
  };
}

const inflightSummaries = new Map<string, Promise<Summary>>();

// Cap paid on-demand work per process. The cache budget is still the durable guard.
let activeSummaries = 0;
const summaryWaiters: (() => void)[] = [];

async function withSummarySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSummaries >= MAX_CONCURRENT_SUMMARIES) {
    await new Promise<void>(resolve => summaryWaiters.push(resolve));
  }
  activeSummaries += 1;
  try {
    return await fn();
  } finally {
    activeSummaries -= 1;
    summaryWaiters.shift()?.();
  }
}

/** Fetch the page, summarize it with the LLM, cache it. Returns the summary.
 * On-demand callers draw from a per-day budget (public deploy safety); the daily
 * job passes `ignoreBudget` because it is the legitimate owner of the day's run. */
export async function summarizeArticle(
  url: string,
  options: { ignoreBudget?: boolean } = {}
): Promise<Summary> {
  const existing = inflightSummaries.get(url);
  if (existing) return existing;

  const promise = withSummarySlot(async () => {
    const cache = await loadCache();
    // The server fn is exposed: refuse unknown urls before any paid network call.
    if (!cache.articles.some(article => article.url === url)) {
      throw new Error(`unknown article: ${url}`);
    }
    // Idempotent: loadCache already dropped summaries that fail the schema, so a
    // cached entry answers immediately, before any network call. hasOwn keeps keys
    // like "constructor" from reading through to Object.prototype.
    const cached = Object.hasOwn(cache.summaries, url) ? cache.summaries[url] : undefined;
    if (cached) return cached;
    if (!options.ignoreBudget) {
      const today = dayStamp();
      const spent = Object.values(cache.summaries).filter(
        (entry): entry is Summary =>
          entry !== undefined && dayStamp(new Date(entry.generatedAt * 1000)) === today
      ).length;
      if (spent >= DAILY_SUMMARY_BUDGET) {
        throw new Error("the daily summary budget is spent — it resets tomorrow");
      }
    }
    const resolvedTitle = cache.articles.find(a => a.url === url)?.title ?? url;
    const text = await extractPageText(url);
    const data = await completeJson(PROMPT, `Title: ${resolvedTitle}\n\nTEXT:\n${text}`);
    const summary = normalizeSummary(data, process.env.DIGEST_MODEL?.trim() || DEFAULT_MODEL);
    // The honest read time comes from the extracted page, not the feed teaser.
    summary.words = text.split(/\s+/).filter(Boolean).length;
    // A refresh may have saved while the LLM was thinking, so reload before writing.
    await withCacheLock(async () => {
      const fresh = await loadCache();
      fresh.summaries[url] = summary;
      await saveCache(fresh);
    });
    return summary;
  });

  inflightSummaries.set(url, promise);
  try {
    return await promise;
  } finally {
    inflightSummaries.delete(url);
  }
}

// Concurrent refreshes share one feed scan: later callers join the running refresh
// instead of stacking full feed scans. Only explicit refreshes (manual UI refresh and
// the daily job) reach here; normal page loads read the cache without refreshing.
let inflightRefresh: Promise<void> | null = null;

async function runRefresh(budgetMs?: number): Promise<void> {
  const deadline = budgetMs !== undefined ? Date.now() + budgetMs : undefined;
  const before = await loadCache();
  const sources = sourcesFor(before);
  const knownUrls = new Set(before.articles.map(article => article.url));
  const { articles, feeds, fetchedSources } = await fetchCandidates(sources, knownUrls, deadline);
  // A summary may have been saved while sources were fetching, so reload before writing.
  await withCacheLock(async () => {
    const fresh = await loadCache();
    const preserveUrls = new Set<string>(fresh.pickedUrls ?? []);
    const today = dayStamp();
    for (const [url, summary] of Object.entries(fresh.summaries)) {
      if (!summary) continue;
      const stamp = dayStamp(new Date(summary.generatedAt * 1000));
      if (stamp === today || (fresh.lastDaily && stamp === fresh.lastDaily)) {
        preserveUrls.add(url);
      }
    }
    fresh.articles = mergeArticles(fresh.articles, articles, preserveUrls);
    // Keep the old status for sources a manual refresh did not reach.
    const sourceNames = new Set(sources.map(source => source.name));
    const fetchedNames = new Set(fetchedSources.map(source => source.name));
    const staleFeeds = fresh.feeds.filter(
      feed => sourceNames.has(feed.name) && !fetchedNames.has(feed.name)
    );
    fresh.feeds = [...feeds, ...staleFeeds];
    fresh.sources = updateSourceHealth(
      sourcesFor(fresh),
      fetchedSources,
      feeds.slice(0, fetchedSources.length)
    );
    if (fetchedSources.length > 0) {
      fresh.fetchedAt = nowSec();
      fresh.lastForced = fresh.fetchedAt;
    }
    await saveCache(fresh);
  });
}

/** Refresh feeds unless a refresh ran within the cooldown window. The daily job passes
 * `ignoreCooldown` to bypass it. `budgetMs` bounds a manual request. */
export async function refresh(
  options: { ignoreCooldown?: boolean; budgetMs?: number } = {}
): Promise<void> {
  const cache = await loadCache();
  const now = Math.floor(Date.now() / 1000);
  // Bounds sweep abuse on a public deploy: a forced sweep at most once per window.
  if (!options.ignoreCooldown && now - (cache.lastForced ?? 0) < FORCE_REFRESH_COOLDOWN_SECONDS) {
    return;
  }
  const running = inflightRefresh;
  if (running) {
    await running;
    return;
  }
  inflightRefresh = runRefresh(options.budgetMs);
  try {
    await inflightRefresh;
  } catch (error) {
    console.error(`digest refresh failed: ${messageOf(error)}`);
    throw error;
  } finally {
    inflightRefresh = null;
  }
}

/** The UI payload: every article with its cached summary, if any. */
export function toPayload(cache: DigestCache): DigestPayload {
  return {
    articles: cache.articles.map(article => {
      const raw =
        (Object.hasOwn(cache.summaries, article.url) ? cache.summaries[article.url] : null) ?? null;
      // Legacy summaries predate the word count. A 0 renders as "unknown", never as noise.
      const summary = raw ? { ...raw, words: raw.words ?? 0 } : null;
      return {
        ...article,
        summary,
        picked:
          cache.pickedUrls !== undefined
            ? cache.pickedUrls.includes(article.url)
            : summary !== null &&
              cache.lastDaily !== undefined &&
              dayStamp(new Date(summary.generatedAt * 1000)) === cache.lastDaily,
      };
    }),
    feeds: cache.feeds,
    fetchedAt: cache.fetchedAt,
  };
}

/** Digest for the loader. Normal loads read the cached digest directly; forceRefresh runs an explicit refresh. */
export async function loadDigest(forceRefresh = false): Promise<DigestPayload> {
  if (forceRefresh) {
    await refresh({ budgetMs: MANUAL_REFRESH_BUDGET_MS });
    return toPayload(await loadCache());
  }
  return toPayload(await loadCache());
}

export function resolvePickCount(raw: string | undefined = process.env.DIGEST_PICK_COUNT): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) return DEFAULT_PICK_COUNT;
  return Math.max(1, parsed);
}

/** The SGT (UTC+8) YYYY-MM-DD stamp for the daily guard and the local-day budget. */
export function dayStamp(now = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/** Summarize each pick in order. A 401/403 stops the rest. The key is dead,
 * so further attempts only waste calls. The function returns the success count. */
export async function summarizePicked(
  picked: CandidateArticle[],
  summarize: (article: CandidateArticle) => Promise<unknown> = article =>
    summarizeArticle(article.url, { ignoreBudget: true })
): Promise<number> {
  let ok = 0;
  for (const [index, article] of picked.entries()) {
    console.log(`  [${index + 1}/${picked.length}] ${article.blog}: ${article.title.slice(0, 70)}`);
    try {
      // The loop runs in order on purpose. Progress reads top-down, and providers rate-limit calls.
      // oxlint-disable-next-line no-await-in-loop
      await summarize(article);
      ok += 1;
    } catch (error) {
      if (error instanceof UpstreamAuthError) {
        console.log(`    auth failed, aborting the rest: ${messageOf(error).slice(0, 160)}`);
        break;
      }
      console.log(`    failed: ${messageOf(error).slice(0, 160)}`);
    }
  }
  return ok;
}

/** One daily run. It refreshes feeds, then picks and summarizes the interesting posts without summaries.
 * The result lets the job fail when every summary attempt failed. */
export async function daily(force = false): Promise<{ summarized: number; pending: number }> {
  const cache = await loadCache();
  const today = dayStamp();
  if (!force && cache.lastDaily === today) {
    console.log(`digest already built today (${today}); use --force to run again`);
    return { summarized: 0, pending: 0 };
  }
  console.log("fetching feeds...");
  await refresh({ ignoreCooldown: true });
  const fresh = await loadCache();
  const todo = fresh.articles.filter(article => fresh.summaries[article.url] === undefined);
  console.log(`${fresh.articles.length} articles cached, ${todo.length} without a summary`);
  let ok = 0;
  let picked: CandidateArticle[] = [];
  if (todo.length > 0) {
    const datedTodo = todo.filter(a => a.published > 0);
    // mergeArticles keeps fresh undated discoveries ahead of the historical
    // backlog, so the limited undated slots go to this run's new posts.
    const undatedTodo = todo.filter(a => a.published <= 0);
    const maxUndated = Math.min(undatedTodo.length, 8);
    const candidateSlice = [
      ...datedTodo.slice(0, CANDIDATE_POOL - maxUndated),
      ...undatedTodo.slice(0, maxUndated),
    ];
    picked = await selectInteresting(candidateSlice, resolvePickCount());
    console.log(`picked ${picked.length} for today:`);
    ok = await summarizePicked(picked);
  }
  // Stamp the day only after progress. Then a failed run retries on the next run.
  if (ok > 0 || todo.length === 0) {
    let succeededPicks: CandidateArticle[] = [];
    await withCacheLock(async () => {
      const stamped = await loadCache();
      const succeededUrls = picked
        .map(a => a.url)
        .filter(
          url => Object.hasOwn(stamped.summaries, url) && stamped.summaries[url] !== undefined
        );
      succeededPicks = picked.filter(article => succeededUrls.includes(article.url));
      if (succeededUrls.length > 0) {
        stamped.pickedUrls =
          stamped.lastDaily === today && stamped.pickedUrls
            ? [...new Set([...stamped.pickedUrls, ...succeededUrls])]
            : succeededUrls;
      }
      stamped.lastDaily = today;
      await saveCache(stamped);
    });
    if (succeededPicks.length > 0) {
      try {
        await learnSources(succeededPicks);
      } catch (error) {
        // A source-list write must never turn a successful digest into a failed run.
        console.error(`source learning failed: ${messageOf(error)}`);
      }
    }
  }
  if (todo.length === 0) console.log("nothing new — done");
  else if (ok > 0) console.log(`done: ${ok}/${picked.length} summarized`);
  else console.log("nothing succeeded — will retry on the next run");
  return { summarized: ok, pending: todo.length };
}
