// oxlint-disable node/no-process-env, no-await-in-loop
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Redis } from "@upstash/redis";
import { z } from "zod";

import { KEEP_ARTICLES } from "#/features/digest/config";
import type { CandidateArticle, DigestCache, Summary } from "#/features/digest/types";
import { isHttpUrl } from "#/features/digest/url";

const KV_KEY = "cache";

/** Thrown when Vercel has no persistent cache. The filesystem cache is short-lived on each instance there. */
export const EPHEMERAL_FS_MESSAGE =
  "configure the Upstash Redis integration (or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN env vars): the filesystem cache is ephemeral on Vercel";

/** True on Vercel Functions. The filesystem cache is short-lived on each instance there. */
export function onVercel(): boolean {
  return process.env.VERCEL === "1";
}

interface UpstashConfig {
  url: string;
  token: string;
}

/** Upstash REST credentials. The Marketplace KV_* names win, and the Upstash UPSTASH_* names also work. */
function upstashConfig(): UpstashConfig | null {
  const url =
    process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim() || "";
  const token =
    process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || "";
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/** True when either Upstash env pair is present. */
export function upstashConfigured(): boolean {
  return upstashConfig() !== null;
}

async function redisClient(): Promise<Redis> {
  const config = upstashConfig();
  if (!config) throw new Error(EPHEMERAL_FS_MESSAGE);
  const { Redis } = await import("@upstash/redis");
  return new Redis({ url: config.url, token: config.token, automaticDeserialization: false });
}

/** Error text with the token removed, so a message can never leak it. */
function redact(message: string): string {
  const config = upstashConfig();
  return config ? message.split(config.token).join("[redacted]") : message;
}

function upstashError(action: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : "unknown error";
  return new Error(`Upstash ${action} failed: ${redact(message).slice(0, 300)}`);
}

/** Read the single cache blob. The result is null when nothing was ever written. */
export async function readUpstashBlob(): Promise<string | null> {
  const redis = await redisClient();
  try {
    return await redis.get<string>(KV_KEY);
  } catch (error) {
    throw upstashError("read", error);
  }
}

/** Overwrite the single cache blob. */
export async function writeUpstashBlob(text: string): Promise<void> {
  const redis = await redisClient();
  try {
    await redis.set(KV_KEY, text);
  } catch (error) {
    throw upstashError("write", error);
  }
}

export const CACHE_FILE = path.join(process.cwd(), "data", "cache.json");

function emptyCache(): DigestCache {
  return { fetchedAt: 0, articles: [], summaries: {}, feeds: [] };
}

// The code validates element shapes, not just containers: {"keyPoints":[null]} must
// never reach SSR. Entries that fail their schema are dropped on load.
export const CandidateArticleSchema = z.object({
  url: z.string().refine(isHttpUrl, { message: "must be an http or https url" }),
  title: z.string(),
  blog: z.string(),
  published: z.number(),
  blurb: z.string(),
  source: z.enum(["feed", "search", "hn"]).optional(),
});

export const TrackedSourceSchema = z.object({
  host: z.string().min(1),
  name: z.string().min(1),
  url: z.string().refine(isHttpUrl, { message: "must be an http or https url" }),
  kind: z.enum(["rss", "sitemap", "html"]),
  origin: z.enum(["seed", "learned"]),
  prefix: z.string().optional(),
  reverse: z.boolean().optional(),
  hydrateTitles: z.boolean().optional(),
  addedAt: z.number(),
  lastOkAt: z.number(),
  misses: z.number().min(0),
});

export const SummarySchema = z.object({
  tldr: z.string().min(1),
  keyPoints: z.array(z.string()).max(50),
  jargon: z.array(z.object({ term: z.string(), explanation: z.string() })).max(50),
  difficulty: z.enum(["", "beginner", "intermediate", "advanced"]),
  model: z.string(),
  generatedAt: z.number(),
  words: z.number().optional(),
});

const FeedStatusSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  count: z.number().optional(),
  error: z.string().optional(),
});

/** Validate an unknown blob into a DigestCache. Malformed input heals to empty
 * and never throws. Both the filesystem backend and the KV backend share this function. */
export function parseCache(parsed: unknown): DigestCache {
  if (typeof parsed !== "object" || parsed === null) return emptyCache();
  // Entries that fail their schema are dropped. A half-written cache still loads.
  // Object.fromEntries defines own properties. So a hostile "__proto__" key stays
  // data and never becomes a prototype write.
  const entries: [string, Summary][] = [];
  if ("summaries" in parsed && typeof parsed.summaries === "object" && parsed.summaries !== null) {
    for (const [key, value] of Object.entries(parsed.summaries)) {
      const summary = SummarySchema.safeParse(value);
      if (summary.success) entries.push([key, summary.data]);
    }
  }
  const summaries: Record<string, Summary | undefined> = Object.fromEntries(entries);
  const articles =
    "articles" in parsed && Array.isArray(parsed.articles)
      ? parsed.articles.flatMap(article => {
          const result = CandidateArticleSchema.safeParse(article);
          return result.success ? [result.data] : [];
        })
      : [];
  const feeds =
    "feeds" in parsed && Array.isArray(parsed.feeds)
      ? parsed.feeds.flatMap(feed => {
          const result = FeedStatusSchema.safeParse(feed);
          return result.success ? [result.data] : [];
        })
      : [];
  const pickedUrls =
    "pickedUrls" in parsed && Array.isArray(parsed.pickedUrls)
      ? parsed.pickedUrls.filter((u): u is string => typeof u === "string")
      : undefined;
  const sources =
    "sources" in parsed && Array.isArray(parsed.sources)
      ? parsed.sources.flatMap(source => {
          const result = TrackedSourceSchema.safeParse(source);
          return result.success ? [result.data] : [];
        })
      : undefined;
  return {
    fetchedAt: "fetchedAt" in parsed && typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
    articles,
    summaries,
    feeds,
    lastDaily:
      "lastDaily" in parsed && typeof parsed.lastDaily === "string" ? parsed.lastDaily : undefined,
    lastForced:
      "lastForced" in parsed && typeof parsed.lastForced === "number"
        ? parsed.lastForced
        : undefined,
    pickedUrls,
    ...(sources !== undefined ? { sources } : {}),
  };
}

/** Load the cache. A missing file means a fresh start. A corrupt file is quarantined, and an empty cache loads. */
export async function loadCache(file = CACHE_FILE): Promise<DigestCache> {
  if (upstashConfigured()) return parseCache(await readUpstashJson());
  if (onVercel()) throw new Error(EPHEMERAL_FS_MESSAGE);
  let raw: string;
  for (let attempt = 0; ; attempt += 1) {
    try {
      raw = await readFile(file, "utf-8");
      break;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return emptyCache();
      }
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if ((code === "EPERM" || code === "EBUSY") && attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantine(file);
    return emptyCache();
  }
  if (typeof parsed !== "object" || parsed === null) {
    await quarantine(file);
    return emptyCache();
  }
  return parseCache(parsed);
}

/** Parse the Upstash blob to unknown. A missing or malformed blob heals to null,
 * which parses to an empty cache. It never throws. Transport and envelope errors from
 * the REST client still throw. They mean misconfiguration, not a corrupt cache. */
async function readUpstashJson(): Promise<unknown> {
  const blob = await readUpstashBlob();
  if (blob === null) return null;
  try {
    return JSON.parse(blob);
  } catch {
    return null;
  }
}

/** A corrupt cache is quarantined aside, so the next load starts fresh. The rename
 * stays outside withCacheLock on purpose. loadCache also runs inside locked
 * sections, so a nested lock here would deadlock. The rename is atomic
 * and idempotent. A racing second quarantine gets ENOENT and is ignored, so the
 * exception is safe. */
async function quarantine(file: string): Promise<void> {
  await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined);
}

// advisory file lock. It covers cooperating local writers.
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 700;

/** Run fn while holding an exclusive cross-process lock on the directory of the file. */
export async function withCacheLock<T>(fn: () => Promise<T>, file = CACHE_FILE): Promise<T> {
  // Upstash has no compare-and-swap. So the lock is a passthrough, and concurrent
  // writers overwrite each other with the last write. Callers reload before writing, which narrows the window.
  if (upstashConfigured()) return fn();
  if (onVercel()) throw new Error(EPHEMERAL_FS_MESSAGE);
  await mkdir(path.dirname(file), { recursive: true });
  const lock = path.join(path.dirname(file), "cache.lock");
  const token = crypto.randomUUID();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(lock, "wx");
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          const staleRenamed = `${lock}.stale-${Date.now()}`;
          await rename(lock, staleRenamed).catch(() => undefined);
          await unlink(staleRenamed).catch(() => undefined);
        }
      } catch {
        // The lock vanished between open and stat. Retry immediately.
      }
      if (attempt + 1 >= LOCK_RETRIES) {
        throw new Error(`digest cache lock busy: ${lock}`, { cause: error });
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    // Best-effort ownership. Unlink only our own lock, never a successor's.
    const current = await readFile(lock, "utf-8").catch(() => null);
    if (current === token) await unlink(lock).catch(() => undefined);
  }
}

// Each write uses a unique temporary file. The server and the daily script write at the same
// time, and a Windows rename over an existing file can fail while a reader holds the file.
export async function saveCache(cache: DigestCache, file = CACHE_FILE): Promise<void> {
  // Prune summaries for articles no longer in the cache
  const activeUrls = new Set(cache.articles.map(article => article.url));
  for (const url of Object.keys(cache.summaries)) {
    if (!activeUrls.has(url)) {
      delete cache.summaries[url];
    }
  }

  if (upstashConfigured()) {
    await writeUpstashBlob(JSON.stringify(cache));
    return;
  }
  if (onVercel()) throw new Error(EPHEMERAL_FS_MESSAGE);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache), "utf-8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if ((code === "EPERM" || code === "EBUSY") && attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}

/** Dedupe by url. Refreshed metadata wins, preserving published dates and blogs for undated hits.
 * Articles in preserveUrls are protected from eviction. */
export function mergeArticles(
  old: CandidateArticle[],
  fresh: CandidateArticle[],
  preserveUrls?: Iterable<string>
): CandidateArticle[] {
  const byUrl = new Map<string, CandidateArticle>();
  for (const article of old) byUrl.set(article.url, article);
  for (const article of fresh) {
    const existing = byUrl.get(article.url);
    if (existing && existing.published > 0 && article.published <= 0) {
      byUrl.set(article.url, {
        ...article,
        published: existing.published,
        blog: existing.blog,
        source: existing.source ?? article.source,
      });
    } else {
      byUrl.set(article.url, article);
    }
  }

  const dated = [...byUrl.values()]
    .filter(article => article.published > 0)
    .toSorted((a, b) => b.published - a.published);
  // Fresh undated discoveries win the reserved slots, without reversing the
  // historical backlog on every refresh.
  const freshUrls = new Set(fresh.map(article => article.url));
  const undated = [...byUrl.values()]
    .filter(article => article.published <= 0)
    .toSorted((a, b) => Number(freshUrls.has(b.url)) - Number(freshUrls.has(a.url)));

  const preservedSet = new Set(preserveUrls ?? []);
  // Reserve space for up to 40 undated discoveries when dated items crowd the cache
  const reservedUndated = dated.length >= KEEP_ARTICLES ? Math.min(undated.length, 40) : 0;
  const maxDated = Math.min(dated.length, KEEP_ARTICLES - reservedUndated);
  const remainingSlots = Math.max(0, KEEP_ARTICLES - maxDated);
  const candidatePool = [...dated.slice(0, maxDated), ...undated.slice(0, remainingSlots)];

  if (preservedSet.size === 0) {
    return candidatePool;
  }

  const result: CandidateArticle[] = [];
  const selectedUrls = new Set<string>();

  // 1. Always keep preserved articles
  for (const article of byUrl.values()) {
    if (preservedSet.has(article.url)) {
      result.push(article);
      selectedUrls.add(article.url);
    }
  }

  // 2. Fill up to KEEP_ARTICLES from candidatePool
  for (const article of candidatePool) {
    if (result.length >= KEEP_ARTICLES) break;
    if (!selectedUrls.has(article.url)) {
      result.push(article);
      selectedUrls.add(article.url);
    }
  }

  const resDated = result
    .filter(a => a.published > 0)
    .toSorted((a, b) => b.published - a.published);
  const resUndated = result.filter(a => a.published <= 0);
  return [...resDated, ...resUndated];
}
