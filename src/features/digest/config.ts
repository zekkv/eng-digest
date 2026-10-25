/** Client-safe digest constants: feeds, prompts, and limits. No runtime imports. */

export interface DigestFeed {
  name: string;
  url: string;
  /** Defaults to RSS. Learned sources may be a sitemap or an HTML index. */
  kind?: "rss" | "sitemap" | "html";
  /** Sitemap or index path to keep, e.g. `/news/`. */
  prefix?: string;
  /** Reverse a date-less sitemap whose document order is oldest-first. */
  reverse?: boolean;
  /** Fetch each selected sitemap entry's page title. Use when URLs are slugs. */
  hydrateTitles?: boolean;
}

/** Cold-start sources. The cache learns more; this list is not the live source list.
 * Company and open-source blogs both belong here. */
export const SEED_SOURCES: DigestFeed[] = [
  { name: "AI2", url: "https://allenai.org/rss.xml" },
  { name: "Bun", url: "https://bun.com/rss.xml" },
  { name: "Cloudflare", url: "https://blog.cloudflare.com/rss/" },
  { name: "Chrome for Developers", url: "https://developer.chrome.com/blog/feed.xml" },
  { name: "Cohere", url: "https://cohere.com/blog", kind: "html", prefix: "/blog/" },
  { name: "Netflix", url: "https://netflixtechblog.com/feed" },
  { name: "Meta", url: "https://engineering.fb.com/feed/" },
  { name: "AWS", url: "https://aws.amazon.com/blogs/architecture/feed/" },
  { name: "GitHub", url: "https://github.blog/engineering/feed/" },
  { name: "Stripe", url: "https://stripe.com/blog/feed.rss" },
  { name: "Slack", url: "https://slack.engineering/feed/" },
  { name: "Figma", url: "https://www.figma.com/blog/feed/atom.xml" },
  { name: "Discord", url: "https://discord.com/blog/rss.xml" },
  { name: "Dropbox", url: "https://dropbox.tech/feed" },
  { name: "Spotify", url: "https://engineering.atspotify.com/feed/" },
  { name: "Pinterest", url: "https://medium.com/feed/pinterest-engineering" },
  { name: "Airbnb", url: "https://medium.com/feed/airbnb-engineering" },
  { name: "Shopify", url: "https://shopify.engineering/blog.atom" },
  { name: "Databricks", url: "https://www.databricks.com/feed" },
  { name: "Datadog", url: "https://www.datadoghq.com/blog/index.xml" },
  {
    name: "DeepSeek",
    url: "https://api-docs.deepseek.com/sitemap.xml",
    kind: "sitemap",
    prefix: "/news/",
    reverse: true,
    hydrateTitles: true,
  },
  { name: "Grab", url: "https://engineering.grab.com/feed.xml" },
  { name: "Stack Overflow", url: "https://stackoverflow.blog/feed/" },
  { name: "Allegro Tech", url: "https://blog.allegro.tech/feed.xml" },
  {
    name: "Anthropic",
    url: "https://www.anthropic.com/sitemap.xml",
    kind: "sitemap",
    prefix: "/news/",
  },
  { name: "Apple ML", url: "https://machinelearning.apple.com/rss.xml" },
  { name: "AWS ML", url: "https://aws.amazon.com/blogs/machine-learning/feed/" },
  { name: "Dan Luu", url: "https://danluu.com/atom.xml" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml" },
  { name: "Deno", url: "https://deno.com/feed" },
  { name: "Duolingo", url: "https://blog.duolingo.com/feed/" },
  { name: "Elastic", url: "https://www.elastic.co/blog/feed" },
  { name: "Etsy Code as Craft", url: "https://codeascraft.com/feed/" },
  { name: "Go", url: "https://go.dev/blog/feed.atom" },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { name: "Google Cloud", url: "https://cloudblog.withgoogle.com/rss/" },
  { name: "Google Developers", url: "https://developers.googleblog.com/feeds/posts/default" },
  { name: "Google Research", url: "https://research.google/blog/rss/" },
  { name: "Grafana", url: "https://grafana.com/blog/index.xml" },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { name: "InfoQ", url: "https://feed.infoq.com/" },
  { name: "Julia Evans", url: "https://jvns.ca/atom.xml" },
  { name: "Kubernetes", url: "https://kubernetes.io/feed.xml" },
  { name: "Lyft Engineering", url: "https://eng.lyft.com/feed" },
  { name: "Martin Fowler", url: "https://martinfowler.com/feed.atom" },
  { name: "Microsoft DevBlogs", url: "https://devblogs.microsoft.com/feed/" },
  { name: "Microsoft Research", url: "https://www.microsoft.com/en-us/research/feed/" },
  { name: "Mistral AI", url: "https://mistral.ai/news/rss" },
  {
    name: "Moonshot AI",
    url: "https://platform.kimi.ai/blog",
    kind: "html",
    prefix: "/blog/posts/",
  },
  { name: "Mozilla Hacks", url: "https://hacks.mozilla.org/feed/" },
  { name: "Node.js", url: "https://nodejs.org/en/feed/blog.xml" },
  { name: "NVIDIA Developer", url: "https://developer.nvidia.com/blog/feed" },
  { name: "OpenAI", url: "https://openai.com/blog/rss.xml" },
  { name: "Python", url: "https://blog.python.org/feeds/posts/default?alt=rss" },
  { name: "Qwen", url: "https://qwenlm.github.io/blog/index.xml" },
  { name: "React", url: "https://react.dev/rss.xml" },
  { name: "Reddit", url: "https://www.reddit.com/r/RedditEng/.rss" },
  { name: "Redis", url: "https://redis.io/blog/feed/" },
  { name: "Rust", url: "https://blog.rust-lang.org/feed.xml" },
  { name: "ScyllaDB", url: "https://www.scylladb.com/feed/" },
  { name: "Square", url: "https://developer.squareup.com/blog/rss.xml" },
  { name: "Stability AI", url: "https://stability.ai/news-updates?format=rss" },
  { name: "Supabase", url: "https://supabase.com/rss.xml" },
  { name: "Svelte", url: "https://svelte.dev/blog/rss.xml" },
  { name: "The New Stack", url: "https://thenewstack.io/feed/" },
  { name: "Together AI", url: "https://www.together.ai/blog/rss.xml" },
  { name: "Vercel", url: "https://vercel.com/blog/rss.xml" },
  { name: "Vite", url: "https://vite.dev/blog.rss" },
  { name: "WebKit", url: "https://webkit.org/feed/" },
  { name: "xAI", url: "https://x.ai/news", kind: "html", prefix: "/news/" },
];

/** Learned sources beyond this count are evicted least-recently-successful first. */
export const MAX_LEARNED_SOURCES = 50;
/** Consecutive fetch failures before a learned source is dropped. */
export const SOURCE_FAILURE_LIMIT = 3;
/** New sources one daily run may try to discover. Bounds post-run network time. */
export const MAX_NEW_SOURCES_PER_RUN = 3;
/** Child sitemaps read from one sitemap index. */
export const SITEMAP_CHILD_LIMIT = 5;
/** Sitemap entries older than this are ignored, so evicted posts cannot resurface. */
export const SITEMAP_LOOKBACK_DAYS = 60;
/** Shared by RSS, sitemap, index-page, and discovery fetches. */
export const FETCH_TIMEOUT_MS = 30_000;
/** Discovery is best-effort and runs after the digest; keep it short. */
export const DISCOVERY_TIMEOUT_MS = 10_000;
/** HTML index and discovery pages are parsed with regexes; larger responses are refused. */
export const PAGE_MAX_BYTES = 2_000_000;
/** RSS and sitemap XML are not cut mid-document; they get a larger byte ceiling. */
export const FEED_MAX_BYTES = 10_000_000;

/** Hosts that never identify one blog, so they are never learned as sources. */
export const BLOCKED_HOSTS: string[] = [
  "arxiv.org",
  "dev.to",
  "github.com",
  "gist.github.com",
  "linkedin.com",
  "medium.com",
  "news.ycombinator.com",
  "npmjs.com",
  "pypi.org",
  "reddit.com",
  "stackoverflow.com",
  "twitter.com",
  "wikipedia.org",
  "x.com",
  "youtube.com",
  "youtu.be",
];

/** Newest entries kept per source. */
export const MAX_PER_FEED = 15;
/** Sources fetched per wave: bounds concurrency so slow sources do not queue behind connection limits. */
export const FEED_BATCH = 12;
/** Newest unsummarized posts shown to the picker (bounds prompt size). */
export const CANDIDATE_POOL = 40;
/** Posts summarized per daily run; env override DIGEST_PICK_COUNT. */
export const DEFAULT_PICK_COUNT = 10;
/** Newest articles kept in the cache. */
export const KEEP_ARTICLES = 200;
/** Page text chars sent to the summarizer. */
export const MAX_CHARS = 60_000;
/** Hard cap on LLM summaries per local day: bounds spend on a public, unauthenticated deploy.
 * The daily job ignores it; on-demand callers (and anyone else) are capped by it. */
export const DAILY_SUMMARY_BUDGET = 50;
/** Per-process cap on concurrent on-demand summaries. Cross-instance overrun still
 * needs an atomic store counter. */
export const MAX_CONCURRENT_SUMMARIES = 2;
/** Forced refreshes are rate-limited to one per this window (bounds feed sweeps). */
export const FORCE_REFRESH_COOLDOWN_SECONDS = 10 * 60;
/** Manual refresh returns before a serverless request limit. The daily job is unbounded
 * and completes the sweep. */
export const MANUAL_REFRESH_BUDGET_MS = 6_000;
/** A manual sweep caps one source so a slow source does not consume the whole budget. */
export const MANUAL_SOURCE_TIMEOUT_MS = 2_500;
/** Blurb chars kept per article. */
export const BLURB_CHARS = 280;

export const DEFAULT_MODEL = "meta/muse-spark-1.3-contributor";
/** Cloud LLMs answer in seconds; 300s is a generous ceiling, not a target. */
export const LLM_TIMEOUT_MS = 300_000;
export const LLM_MAX_TOKENS = 8000; // muse-spark reasons before answering; leave budget for the JSON
/** Per-call ceiling for Tavily; the legacy port used 30s so refresh never hangs. */
export const TAVILY_TIMEOUT_MS = 30_000;

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

/** Hacker News front page via Algolia: one call per refresh, filtered to stories
 * with an external link at or above this score. Set to 0 to disable. */
export const HN_MIN_POINTS = 150;
/** Most Hacker News stories kept per refresh. */
export const HN_MAX_STORIES = 15;
export const HN_FRONT_PAGE_URL =
  "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50";

export const PROMPT = `You summarize engineering blog posts for a software developer who understands the basics but is new to advanced topics.

Return ONLY valid JSON matching this shape:
{"tldr": "...", "key_points": ["..."], "jargon": [{"term": "...", "explanation": "..."}], "difficulty": "beginner|intermediate|advanced"}

Rules:
- tldr: 2-4 plain-language sentences on what the post does and why it matters.
- key_points: 3-6 concrete takeaways (design decisions, tradeoffs, numbers).
- jargon: the terms a generalist engineer likely does not know, each explained in 1-2 simple sentences, optionally with an analogy. Skip common terms. Empty list if none.
- difficulty: how hard the post is for a generalist software engineer.
- Use ONLY the post text. Never invent facts or numbers.`;

export const SELECT_PROMPT = `You pick the most interesting posts for a backend-leaning generalist
developer who is learning advanced engineering topics.

Return ONLY valid JSON of this shape: {"picked": ["<url>", ...]}
Pick at most {n} urls from the candidates. Prefer deep dives, design writeups and
war stories. Pick an announcement only when it carries real engineering substance:
a major release, a significant design or architecture change, a new capability
explained with technical detail, or measured results. Skip routine product
marketing, funding news, minor version bumps, and listicles. Spread picks across
different blogs.`;
