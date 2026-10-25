# eng-digest

A daily digest of engineering blog posts with summaries, key points, and decoded jargon. The app uses TanStack Start on Bun. It collects posts from RSS feeds, sitemaps, HTML index pages, and the Hacker News front page. Tavily extracts the article text. An LLM picks the most interesting posts and summarizes them.

The source list starts from seeds in `config.ts`. It grows from the posts that the picker likes and is stored in the cache. There is no relational database and no accounts. Locally, the cache is a JSON file under `data/`.

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

   Open `.env` and enter `OPENROUTER_API_KEY` and `TAVILY_API_KEY`. For details, refer to the [Environment Variables Reference](./docs/DEVELOPMENT.md#environment-variables) in the Development Guide.

3. **Start the dev server**

   ```bash
   bun run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

### Daily digest job

The digest backend (`src/features/digest`) needs `OPENROUTER_API_KEY` and `TAVILY_API_KEY` in `.env`. Then run:

```bash
bun scripts/digest-daily.ts --dry-run   # source configuration check, writes nothing
bun run digest:daily                    # daily job (also accepts --force)
```

In production, `.github/workflows/digest-daily.yml` runs `bun run digest:daily` every day at **07:00 Singapore time (SGT), 23:00 UTC**. The workflow also supports manual `workflow_dispatch` with an optional `force` input. The job writes directly to Upstash Redis. It does not send a request to the Vercel web app. A successful run marks the day as complete, and the script does not run again that day unless you pass `--force`. A run that has articles to summarize but no successful summary does not mark the day as complete, so the next run retries.

A source refresh fetches only the tracked sources and the Hacker News front page. It spends no API credits. On-demand summaries spend Tavily and OpenRouter credits, with a fixed per-day budget (50). The app allows one forced refresh per 10 minutes. A forced refresh stops after 6 seconds. The daily job completes the full sweep.

These limits keep the worst-case spend of a public deploy in cents per day. For a public URL, deploy to Vercel. Refer to [Deployment](#deployment). For personal use, run the app locally.

For complete workflow instructions, the script catalog, testing guidelines, and environment configuration, refer to the [Development Guide](./docs/DEVELOPMENT.md).

## Deployment

### Vercel Hobby + GitHub Actions daily cron

Local runs (`bun run dev` and `bun run digest:daily`) keep using `data/cache.json`. The steps below do not change them. On Vercel, the web app reads the cached digest from Upstash Redis on page load. Manual refreshes and on-demand article summaries write back to Redis. The daily job runs in GitHub Actions (`.github/workflows/digest-daily.yml`) at **07:00 Singapore time (23:00 UTC)**. It writes directly to the same Upstash Redis store.

1. Run `bunx vercel login`. Then run `bunx vercel link` in this directory.
2. Install Upstash Redis from the Vercel Marketplace. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for the project. The Upstash names `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` also work. You can also set the `UPSTASH_*` pair manually.
3. Run `bunx vercel env add OPENROUTER_API_KEY`. Run `bunx vercel env add TAVILY_API_KEY`. Add optional `DIGEST_MODEL` to change the summary model. These variables enable on-demand summaries on the deployed site. `DIGEST_PICK_COUNT` applies to the daily job only. Set it as a GitHub repository variable.
4. Add these GitHub repository secrets for the deploy and preview jobs: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`. The two IDs come from `.vercel/project.json` after `bunx vercel link`.
5. Disable the Vercel project's Git integration if it is enabled. `cd.yml` and the preview job are the deploy paths.
6. Merge to `main`. Continuous integration (CI) runs first. `cd.yml` then runs `bun run build:vercel` in GitHub Actions. It deploys with `bunx vercel deploy --prebuilt --prod`. For a manual production deploy, run `bun run deploy:vercel`.

`cd.yml` starts after CI succeeds on `main`. It does not deploy after a failed CI run. You can also start it with `workflow_dispatch`. A manual run does not wait for CI. The job checks the three Vercel secrets and the production Vercel environment for `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, and the Upstash keys. A missing value stops the job with an error.

The `preview` job in `ci.yml` deploys a Vercel preview for a pull request to `main` from this repository. It runs after CI passes. The job does not run for a draft pull request. The workflow ignores Markdown and `docs/` changes, so it does not deploy a preview for a docs-only pull request. It creates or updates one pull request comment with the preview URL.

Set the same runtime variables for the Vercel Preview environment as for Production. Previews share the production Upstash database. Preview URLs require a Vercel login. The production site at [https://eng-digest.vercel.app](https://eng-digest.vercel.app) is public.

For the `.github/workflows/digest-daily.yml` daily job, configure these GitHub repository secrets: `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, and `KV_REST_API_URL` with `KV_REST_API_TOKEN`. You can use `UPSTASH_REDIS_REST_URL` with `UPSTASH_REDIS_REST_TOKEN` instead. You can also set optional repository variables `DIGEST_MODEL` and `DIGEST_PICK_COUNT`.

Without the Upstash variables on Vercel, the app stops with a clear configuration error. It does not write to the short-lived filesystem.

## Documentation

- [Development](./docs/DEVELOPMENT.md) describes local setup, the script catalog, testing, and tooling.
- [Architecture](./docs/ARCHITECTURE.md) describes the project structure, the data flow, and observability.
- [Design System](./docs/DESIGN.md) describes the visual style and the design tokens.
- [Agents Guide](./AGENTS.md) gives the rules for coding agents that work in this repository.
