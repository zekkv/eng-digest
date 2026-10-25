/** Shared digest shapes. Safe for the client: types only, no runtime imports. */

// Epoch timestamps below are integers. They use the legacy cache's unit, which is seconds.
export type Difficulty = "" | "beginner" | "intermediate" | "advanced";

export interface JargonTerm {
  term: string;
  explanation: string;
}

export interface Summary {
  tldr: string;
  keyPoints: string[];
  jargon: JargonTerm[];
  difficulty: Difficulty;
  model: string;
  generatedAt: number;
  /** Honest word count of the extracted page text. Absent on legacy entries, where the count is unknown. */
  words?: number;
}

/** A feed or search candidate before it is summarized. */
export interface CandidateArticle {
  url: string;
  title: string;
  blog: string;
  published: number;
  blurb: string;
  /** Where the candidate came from. Absent on entries cached before this field existed. */
  source?: "feed" | "search" | "hn";
}

export type SourceKind = "rss" | "sitemap" | "html";

/** A source in the cache. Seeds come from config; learned sources are added after a pick. */
export interface TrackedSource {
  /** Normalized host, without `www.`. The learning key. */
  host: string;
  name: string;
  /** Feed URL, sitemap URL, or index page URL. */
  url: string;
  kind: SourceKind;
  origin: "seed" | "learned";
  /** Path prefix for sitemap and index-page sources, e.g. `/blog/`. */
  prefix?: string;
  /** Reverse a date-less sitemap whose document order is oldest-first. */
  reverse?: boolean;
  /** Fetch each selected sitemap entry's page title. */
  hydrateTitles?: boolean;
  addedAt: number;
  /** Last successful fetch. Learned-source eviction uses this. */
  lastOkAt: number;
  /** Consecutive fetch failures. */
  misses: number;
}

export interface DigestArticle extends CandidateArticle {
  summary: Summary | null;
  /** True when the article's summary was generated on the cache's lastDaily local day. */
  picked: boolean;
}

export interface FeedStatus {
  name: string;
  ok: boolean;
  count?: number;
  error?: string;
}

export interface DigestPayload {
  articles: DigestArticle[];
  feeds: FeedStatus[];
  fetchedAt: number;
}

/** This is the on-disk cache shape for `data/cache.json`. */
export interface DigestCache {
  fetchedAt: number;
  articles: CandidateArticle[];
  summaries: Record<string, Summary | undefined>;
  feeds: FeedStatus[];
  lastDaily?: string;
  /** Epoch seconds of the last forced (user-triggered) refresh. It bounds forced-refresh abuse. */
  lastForced?: number;
  pickedUrls?: string[];
  /** Seeds plus sources learned from picked posts. Absent means "seed from config". */
  sources?: TrackedSource[];
}
