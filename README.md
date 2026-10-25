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

These limits keep the worst-case spend of a public deploy in cents per day. For a public URL, refer to the [Deployment Guide](./docs/DEPLOYMENT.md). For personal use, run the app locally.

For complete workflow instructions, the script catalog, testing guidelines, and environment configuration, refer to the [Development Guide](./docs/DEVELOPMENT.md).

## Deployment

Refer to the [Deployment Guide](./docs/DEPLOYMENT.md) for the Vercel and GitHub Actions setup.

## Documentation

- [Development](./docs/DEVELOPMENT.md) describes local setup, the script catalog, testing, and tooling.
- [Architecture](./docs/ARCHITECTURE.md) describes the project structure, the data flow, and observability.
- [Deployment](./docs/DEPLOYMENT.md) describes the Vercel and GitHub Actions setup.
- [Design System](./docs/DESIGN.md) describes the visual style and the design tokens.
- [Agents Guide](./AGENTS.md) gives the rules for coding agents that work in this repository.
