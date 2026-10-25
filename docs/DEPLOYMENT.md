# Deployment

## Vercel Hobby + GitHub Actions daily cron

Local runs (`bun run dev` and `bun run digest:daily`) keep using `data/cache.json`. The steps below do not change them. On Vercel, the web app reads the cached digest from Upstash Redis on page load. Manual refreshes and on-demand article summaries write back to Redis. The daily job runs in GitHub Actions (`.github/workflows/digest-daily.yml`) at **07:00 Singapore time (23:00 UTC)**. It writes directly to the same Upstash Redis store.

1. Run `bunx vercel login`. Then run `bunx vercel link` in the repository root.
2. Install Upstash Redis from the Vercel Marketplace. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for the project. The Upstash names `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` also work. You can also set the `UPSTASH_*` pair manually.
3. Run `bunx vercel env add OPENROUTER_API_KEY`. Run `bunx vercel env add TAVILY_API_KEY`. Add optional `DIGEST_MODEL` to change the summary model. These variables enable on-demand summaries on the deployed site. `DIGEST_PICK_COUNT` applies to the daily job only. Set it as a GitHub repository variable.
4. Add these GitHub repository secrets for the deploy and preview jobs: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`. The two IDs come from `.vercel/project.json` after `bunx vercel link`.
5. Disable the Vercel project's Git integration if it is enabled. `cd.yml` and the preview job are the deploy paths.
6. Merge to `main`. Continuous integration (CI) runs first. `cd.yml` then runs `bun run build:vercel` in GitHub Actions. It deploys with `bunx vercel deploy --prebuilt --prod`. For a manual production deploy, run `bun run deploy:vercel`.

`cd.yml` starts after CI succeeds on `main`. It does not deploy after a failed CI run. You can also start it with `workflow_dispatch`. A manual run does not wait for CI. The job checks the three Vercel secrets and the production Vercel environment for `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, and the Upstash keys. A missing value stops the job with an error.

The `preview` job in `ci.yml` deploys a Vercel preview for a pull request to `main` from this repository. It runs after CI passes. The job does not run for a draft pull request. The workflow ignores Markdown and `docs/` changes, so it does not deploy a preview for a docs-only pull request. It creates or updates one pull request comment with the preview URL.

Set the same runtime variables for the Vercel Preview environment as for Production. Previews share the production Upstash database. Preview URLs require a Vercel login.

For the `.github/workflows/digest-daily.yml` daily job, configure these GitHub repository secrets: `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, and `KV_REST_API_URL` with `KV_REST_API_TOKEN`. You can use `UPSTASH_REDIS_REST_URL` with `UPSTASH_REDIS_REST_TOKEN` instead. You can also set optional repository variables `DIGEST_MODEL` and `DIGEST_PICK_COUNT`.

Without the Upstash variables on Vercel, the app stops with a clear configuration error. It does not write to the short-lived filesystem.
