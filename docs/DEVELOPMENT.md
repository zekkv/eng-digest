# Development Guide

This guide covers the local development environment, scripts catalog, environment variables, and testing practices for this project.

## Prerequisites

- Install **[Bun](https://bun.sh/)** version 1.4.2 or later.
- Get an **OpenRouter** API key and a **Tavily** API key. The digest backend needs them.

## Local Setup

1. **Clone the repository and install dependencies**:

   ```bash
   bun install
   ```

2. **Configure the environment variables**:

   ```bash
   cp .env.example .env
   ```

   Enter `OPENROUTER_API_KEY` and `TAVILY_API_KEY`. The app needs them only for summarizing and extracting article text. The cached digest renders without them.

3. **Start the local development server**:

   ```bash
   bun run dev
   ```

   The application starts on [http://localhost:3000](http://localhost:3000).

4. **Check the digest configuration**. The check writes nothing and makes no LLM calls:

   ```bash
   bun scripts/digest-daily.ts --dry-run
   ```

5. **Run the daily job**. Production runs it from `.github/workflows/digest-daily.yml` at 07:00 Singapore time (SGT), 23:00 UTC. To run it locally, use the following command. Append `--force` to run it again today:

   ```bash
   bun run digest:daily
   ```

---

## Environment Variables

| Variable             | Required                | Description                                                                          |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY` | ✅                      | Powers the LLM calls that pick and summarize.                                        |
| `TAVILY_API_KEY`     | ✅                      | Extracts article text for summaries.                                                 |
| `DIGEST_MODEL`       | Optional                | Overrides the model. The default is `meta/muse-spark-1.3-contributor`.               |
| `DIGEST_PICK_COUNT`  | Optional                | Overrides the number of candidate articles that the daily run picks (default: `10`). |
| `DIGEST_DNS_CHECK`   | Optional                | Set to `0` to skip DNS checks on fetched hosts. Unit tests set it to `0`.            |
| `KV_REST_API_URL`    | Vercel / GitHub Actions | Upstash Redis REST endpoint for cloud persistence (or `UPSTASH_REDIS_REST_URL`).     |
| `KV_REST_API_TOKEN`  | Vercel / GitHub Actions | Upstash Redis REST token for cloud persistence (or `UPSTASH_REDIS_REST_TOKEN`).      |

In local development, the app uses the filesystem cache at `data/cache.json`. On Vercel, the app uses Upstash Redis. The daily digest job also uses Upstash Redis, so both share the same cloud cache. Refer to `.env.example` for templates.

---

## Scripts Catalog

The scripts are in `package.json`. That file is the catalog. This guide does not repeat it.

---

## Testing Guide

The test suite has two levels:

### 1. Unit Tests (`tests/unit/`)

- The suite is configured in the top-level `test` block in `vitest.config.ts`.
- It uses the `jsdom` environment with `@testing-library/react`.
- **Rule**: Unit tests must test pure logic and isolated components. They **must not** rely on external network services. `tests/setup.ts` supplies dummy API keys, so test runs never depend on the developer's `.env`.

Run the unit tests:

```bash
bun run test
```

### 2. End-to-End Tests (`tests/e2e/`)

- Playwright runs them (`playwright.config.ts`). The `webServer` block starts `bun run dev` on port 3000. Locally, Playwright reuses a server that is already running. In continuous integration (CI), Playwright starts a new server.

Install the Chromium browser before the first end-to-end (E2E) run:

```bash
bunx playwright install chromium
```

Run the E2E tests:

```bash
bun run test:e2e
```

Run Playwright in interactive mode:

```bash
bunx playwright test --ui
```

### Running Targeted Tests

Refer to "Running a single test" in AGENTS.md to target one file or one case.

---

## Code Quality and Git Hooks

### Linting and Formatting

- **[Oxlint](https://oxc.rs/docs/guide/usage/linter.html)**: a fast linter. It treats warnings as errors through `--deny-warnings`.
  ```bash
  bun run lint:check
  bun run lint:fix
  ```
- **[Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html)**: a fast formatter for code and Markdown.
  ```bash
  bun run format:check
  bun run format:fix
  ```
- **TypeScript**:
  ```bash
  bun run type:check
  ```

### Pre-commit Hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs automatically on `git commit`. It runs `oxlint --fix` and `oxfmt --write` on staged files:

```bash
bun run prepare # reinstalls hooks if needed
```

---

## Architecture and Code Conventions

### Server Functions and Bundle Isolation

Client routes import server functions that `createServerFn` creates (TanStack Start). TanStack Start removes the `.handler(...)` bodies from client builds. It keeps all other code in the module.

- **Avoid module-level server imports**: Never import server-only dependencies at the top level of a route-imported module. The test `tests/unit/client-bundle-safety.test.ts` enforces this rule.
- **Use dynamic imports inside handlers**:
  ```ts
  const { loadDigest } = await import("#/features/digest/pipeline.server");
  ```
- **Do not use the `.server.ts` suffix for route-imported files**: `@tanstack/start-plugin-core` blocks files that match `**/*.server.*` from the client environment. Reserve the `.server.ts` suffix for modules that no client route imports.

### Imports and Path Aliases

`#/*` is the sole alias for `src/*`. It is configured in each of these files:

- `tsconfig.json` (`paths`)
- `package.json` (`imports`)
- `vitest.config.ts` (`alias`)

Do not add another alias unless all three files change together.

### Adding Environment Variables

To add an environment variable:

1. Add a commented entry with its description and defaults in `.env.example`. Server code reads `process.env` directly. Keep new variables optional unless the app cannot start without them.
2. If the variable changes setup or prerequisites, describe it in `README.md` and in this guide.
