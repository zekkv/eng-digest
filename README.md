# eng-digest

A daily digest of engineering blog posts with summaries, key points, and decoded jargon. The app is built with TanStack Start on Bun. It collects posts from RSS, sitemap, and HTML index sources and the Hacker News front page. The source list starts from seeds in config and grows from the posts the picker likes; it lives in the cache, not in code. Tavily extracts the article text. An LLM picks the most interesting posts and summarizes them. There is no database and no accounts. The cache is a JSON file under `data/`.

## Getting Started

### Prerequisites

- Install [Bun](https://bun.sh/) version 1.4.2 or later.
- Get an [OpenRouter](https://openrouter.ai/) API key and a [Tavily](https://tavily.com/) API key.

### Setup

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Open `.env` and enter `OPENROUTER_API_KEY` and `TAVILY_API_KEY`. For details, see the [Environment Variables Reference](./docs/DEVELOPMENT.md#environment-variables) in the Development Guide.

3. **Start the dev server**

   ```bash
   bun run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

### Daily digest job

The digest backend (`src/features/digest`) needs `OPENROUTER_API_KEY` and `TAVILY_API_KEY` in `.env`. Then run:

```bash
bun scripts/digest-daily.ts --dry-run   # source wiring check, writes nothing
bun run digest:daily                    # daily job (also accepts --force)
```

In production, `.github/workflows/digest-daily.yml` runs `bun run digest:daily` every day at **07:00 SGT (23:00 UTC)** (and supports manual `workflow_dispatch` with an optional `force` toggle), writing directly to Upstash Redis without waking up the Vercel web app. The script runs at most once per day unless `--force` is passed.

Refreshing sources only refetches feeds and spends no API credits. On-demand summaries spend Tavily and OpenRouter credits, with a fixed per-day budget (50). Forced refreshes accept at most one run per 10 minutes and stop after a 6-second budget; the daily job completes the full sweep. These limits keep the worst-case spend of a public deploy in cents per day. For a public URL, deploy to Vercel (see [Deployment](#deployment)). For personal use, serve the app to yourself (and your LAN).

For complete workflow instructions, the script catalog, testing guidelines, and environment configuration, see the [Development Guide](./docs/DEVELOPMENT.md).

## Deployment

### Vercel Hobby + GitHub Actions daily cron

Local runs (`bun run dev` and `bun run digest:daily`) keep using `data/cache.json`. The steps below do not change them. On Vercel, the web app reads the cached digest from Upstash Redis on page load, while manual UI refreshes and on-demand article summaries write back to Redis. The daily job runs in GitHub Actions (`.github/workflows/digest-daily.yml`) at **07:00 SGT (23:00 UTC)** and writes directly to the same Upstash Redis store.

1. Run `bunx vercel login`, then run `bunx vercel link` in this directory.
2. Install Upstash Redis from the Vercel Marketplace. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for the project. The Upstash names `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` also work. Or set the `UPSTASH_*` pair manually.
3. Run `bunx vercel env add OPENROUTER_API_KEY` and `bunx vercel env add TAVILY_API_KEY` (plus optional `DIGEST_MODEL` and `DIGEST_PICK_COUNT`) so manual UI refreshes and on-demand summaries work on the deployed site.
4. Run `bun run deploy:vercel`. It builds with the `vercel` preset through `bunx` and then deploys with `--prebuilt`. The Vercel CLI is not a project dependency.

The `cd.yml` workflow deploys every push to `main`. Add three repository secrets before you enable it: `VERCEL_TOKEN` (create one at vercel.com/account/tokens), `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`. The `bunx vercel link` command in step 1 writes the two IDs into `.vercel/project.json`.

For the `.github/workflows/digest-daily.yml` daily job, configure these GitHub repository secrets: `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, and `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`). You can also set optional repository variables `DIGEST_MODEL` and `DIGEST_PICK_COUNT`. Without the Upstash variables on Vercel, the app stops with a clear configuration error instead of writing to the short-lived filesystem.

## Documentation

- [Development](./docs/DEVELOPMENT.md) describes local setup, the script catalog, testing, and tooling.
- [Architecture](./docs/ARCHITECTURE.md) describes the project structure, the data flow, and observability.
- [Design System](./docs/DESIGN.md) describes the visual style and the design tokens.
- [Agents Guide](./AGENTS.md) gives the rules for coding agents that work in this repo.
