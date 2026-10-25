# Architecture

This app builds a daily engineering digest. It collects RSS/Atom feeds, sitemaps, and HTML index pages for blogs without feeds. It also collects the Hacker News front page. An LLM picks and summarizes the posts.

The source list starts from seeds in `config.ts`. It grows from successful picks and is stored in the cache. The app renders on the server with TanStack Start and Nitro on Bun. There is no relational database and no authentication. Locally, the cache is a JSON file under `data/`.

## Core Stack

- **Framework**: The framework is [TanStack Start](https://tanstack.com/start). It provides full-stack React with TanStack Router, server functions, and server-side rendering (SSR).
- **Server**: The server is [Nitro](https://nitro.unjs.io/). It runs the server-side logic and supports deployment presets.
- **Digest backend**: The digest backend parses RSS/Atom feeds with [rss-parser](https://github.com/briancmcdonald/rss-parser). It reads sitemaps and HTML index pages for blogs without feeds. It extracts page text with [Tavily](https://tavily.com/). It reads popular stories from the [Hacker News Algolia API](https://hn.algolia.com/api). It picks and summarizes with [OpenRouter](https://openrouter.ai/).
- **Theme**: The theme uses [next-themes](https://github.com/pacocoursey/next-themes). It sets a class on `html`. A client toggle switches the theme after mount.

## Directory Structure

```
.
├── .github/
│   └── workflows/
│       ├── ci.yml            # Checks, then deploys same-repository previews
│       ├── cd.yml            # Deploys after CI succeeds on `main`, or by manual dispatch
│       └── digest-daily.yml  # Runs `bun run digest:daily` at 07:00 SGT (23:00 UTC)
├── docs/
│   ├── ARCHITECTURE.md   # This file
│   ├── DESIGN.md         # Visual system notes
│   └── DEVELOPMENT.md    # Local setup, scripts, and testing guide
├── AGENTS.md             # Developer guide for coding agents
├── data/
│   └── cache.json        # Digest cache: articles, summaries, feed statuses
├── scripts/
│   └── digest-daily.ts   # Daily job entrypoint (`--dry-run`, `--force`)
├── src/
│   ├── components/
│   │   ├── layout/       # Header and document shell
│   │   ├── pages/        # Error and not-found boundaries
│   │   └── ui/           # Reusable UI primitives (button, sheet, skeleton, sonner)
│   ├── features/
│   │   └── digest/       # The whole feature: config, clients, pipeline, store, server fns, view
│   ├── routes/           # TanStack Router routes
│   │   ├── __root.tsx    # App shell
│   │   └── index.tsx     # Digest page (loader: getDigest)
│   ├── start.ts          # TanStack Start instance (CSRF middleware for server fns)
│   └── globals.css       # Global styles (Tailwind CSS v4)
├── tests/                # Vitest unit suite and Playwright E2E specs
├── components.json       # shadcn/ui configuration
├── package.json
└── vercel.json           # Build command for a Vercel-side build
```

## Data Flow

1. **Routing**: TanStack Router manages routing. `src/routes/__root.tsx` composes the shell, the header, and the page outlet.
2. **SSR**: TanStack Start handles the initial HTML render on the server via Nitro.
3. **Digest page**: `src/routes/index.tsx` loads through the `getDigest` server function. It passes the payload as props to `DigestPage` (`src/features/digest/components/page.tsx`). As a result, the view renders in tests without a router. The functions are public, and there are no sessions. The cross-site request forgery (CSRF) middleware in `src/start.ts` guards same-origin calls. `summarizeArticle` summarizes one URL on demand.
4. **Pipeline** (`pipeline.server.ts`): This module is server-only. Handlers reach it through dynamic `import()`. Normal page loads (`loadDigest(false)`) read the cached digest directly and never refresh feeds. Manual refreshes (`loadDigest(true)`) call `refresh`. `refresh` fetches the tracked sources and applies a 10-minute cooldown and a 6-second budget. The daily job bypasses both limits and completes the full sweep. The tracked list contains the seed sources from `config.ts` and the learned sources stored in the cache. The app adds a learned source after a successful daily pick from Hacker News. It resolves the picked post's host to its RSS feed, sitemap, or HTML index page. The app drops a learned source after three consecutive fetch failures. Seeds stay. `daily` refreshes sources, picks the interesting posts without summaries, summarizes them in order, and then records the successful picks as sources. `summarizeArticle` returns the cached summary when one exists. Otherwise it extracts the page text and caches the new summary.
5. **Cache** (`store.server.ts`): Locally, the cache is `data/cache.json`. The write uses a temporary file and a rename, so a write completes fully or not at all. A read treats a missing file as a fresh start. It drops invalid entries. It moves a corrupt file aside and loads an empty cache. The cache also holds the tracked source list, so adding a blog needs no code change or deploy.
6. **Refresh and summarize**: Plain async handlers track pending state with `useState`. After a mutation the route calls `router.invalidate()`, and the loader runs again.

### Runtimes (local vs Vercel)

Local development runs on Bun and uses the filesystem cache at `data/cache.json`. `bun run build:vercel` switches Nitro to the `vercel` preset.

On Vercel, the cache is one Upstash Redis blob. The key is `cache`. The app uses the Upstash REST API. The app reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`. The names `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` also work.

The Upstash cache uses the same self-healing rules as the filesystem cache. A malformed or missing blob becomes an empty cache. The file lock is a passthrough because Upstash has no compare-and-swap. Callers reload the cache before they write.

If `VERCEL=1` is set and the Upstash variables are missing, the app stops with a clear configuration error. The filesystem cache is short-lived on each Vercel instance.

Normal page loads (`loadDigest(false)`) read the cached digest and do not refresh feeds. Manual refreshes (`loadDigest(true)`) and on-demand summaries (`summarizeArticle`) still work. The daily job runs from `.github/workflows/digest-daily.yml` at 07:00 Singapore time (23:00 UTC). It uses Upstash Redis directly and does not use a Vercel Cron HTTP endpoint.

## Styling

The app styles with **Tailwind CSS v4** through `@tailwindcss/vite`. Theme switching sets a class on the `html` element through `next-themes`.

## Observability

`console.log` and `console.error` are enough for one local app. There is no request logger and no log library.
