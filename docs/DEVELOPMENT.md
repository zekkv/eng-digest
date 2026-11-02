# Development Guide

This guide covers the local development environment, scripts catalog, environment variables, and testing practices for this project.

## Prerequisites

- Install **[Bun](https://bun.sh/)** version 1.4.4 or later.
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
| `DIGEST_MODEL`       | Optional                | Overrides the summariser model. The default is `meta/muse-spark-1.3-contributor`.    |
| `DIGEST_PICK_MODEL`  | Optional                | Overrides the picker model. The default is `anthropic/claude-haiku-5.5`.             |
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

## LLM Evals (`evals/`)

Digest quality depends on two prompts and one model choice. `evals/` measures them instead of guessing. It is a standalone Bun script: not part of the Vitest suite, and it never runs in CI.

- `evals/data/pools.json` — 160 real candidates frozen from `data/cache.json` in four pools of 40. That is the production pool shape: 32 dated posts plus 8 undated discoveries.
- `evals/data/labels.json` — hand-written gold labels (`pick`, `trap`, or unlisted for neutral) with a reason for each. They were written from title + teaser only, which is all the picker sees. Do not edit them to fit a result.
- `evals/data/summary-cases.json` and `evals/data/text/` — six articles with Tavily-extracted text frozen on disk, plus the must-mention facts for each.
- `evals/prompts.ts` — the prompt variants. The baseline imports the shipped prompt, so the eval always measures what production sends.
- `evals/run.ts` — the runner. Writes `evals/results/<suite>-<stage>-<stamp>.{json,md}`.

```bash
bun run eval picker --stage screen
bun run eval picker --stage prompts --configs "anthropic/claude-haiku-5.5#low" --repeats 3
bun run eval summary --stage screen
bun run eval summary --stage prompts --configs "..." --judge false
bun run eval --extract-texts   # re-fetch the six article bodies (gitignored)
```

Article bodies are not committed. `--extract-texts` refills `evals/data/text/` from the frozen URLs with Tavily.

Config ids are `model#effort`; `#none` sends no `reasoning` field. `--repeats` controls samples per cell and defaults to 2.

Picker metrics: `utility = (gold - trap) / n`, precision, recall, distinct blogs, duplicate-topic picks, under-picks (production tops a short list up with the newest post, so under-picking costs quality), and invalid JSON. Summary metrics: must-mention fact coverage, numeric grounding against the source, jargon terms that actually appear in the source, schema shape, and a blind judge score on five axes. The judge runs `deepseek/deepseek-v4.1-flash-1017` at its `max` effort, on shuffled anonymous summaries. It shares a family with one candidate model, so treat it as a ranking aid; fact coverage and grounding are deterministic and do not depend on it.

A full screen costs a few dollars. `--judge false` skips the judge calls.

### Results (2026-11-02)

Picker, 24 samples per cell (4 pools x 6 repeats). `utility = (gold - trap) / 10`:

| picker model               | effort | prompt                | utility         | trap rate | under-pick |
| -------------------------- | ------ | --------------------- | --------------- | --------- | ---------- |
| claude-haiku-5.5           | low    | scoring (now shipped) | **0.63 ± 0.07** | 0.11      | 0.0        |
| claude-haiku-5.5           | low    | previous prompt       | 0.51 ± 0.05     | 0.17      | 0.5        |
| claude-haiku-5.5           | low    | contrastive           | 0.58 ± 0.08     | 0.15      | 1.3        |
| claude-haiku-5.5           | low    | stricter scoring      | 0.45 ± 0.08     | 0.24      | 0.7        |
| muse-spark-1.3-contributor | low    | scoring               | 0.53            | 0.18      | 0.0        |
| muse-spark-1.3-contributor | low    | previous prompt       | 0.40            | 0.25      | 0.4        |

Higher reasoning effort did not help picking: muse improved only 0.40 -> 0.44 at 2.7x the latency, while haiku (0.59 -> 0.51) and gemini (0.49 -> 0.36) got worse. The picker now runs at `low` on haiku.

Summaries, 12 samples per cell, blind judge (1-5):

| summary model              | effort | judge      | facts    | jargon ok | p50 |
| -------------------------- | ------ | ---------- | -------- | --------- | --- |
| muse-spark-1.3-contributor | low    | 4.55       | 0.88     | 0.79      | 17s |
| muse-spark-1.3-contributor | medium | **4.73**   | **0.91** | **0.89**  | 27s |
| muse-spark-1.3-contributor | high   | 4.80       | 0.89     | 0.86      | 41s |
| deepseek-v4.1-flash        | high   | 4.73       | 0.90     | 0.77      | 39s |
| gemini-3.8-flash           | high   | 4.38       | 0.81     | 0.71      | 28s |
| claude-haiku-5.5           | medium | not judged | 0.83     | 0.60      | 11s |

Summaries want more reasoning than picking does: medium is the knee. Haiku is not used for summaries because its jargon quality was far worse (0.60 vs 0.89) and its low and high efforts produced malformed summaries (valid 0.83 and 0.75). Those haiku cells are not judge-scored, so that verdict rests on the deterministic metrics.

Two findings came from the eval rather than the models:

- The picker silently lost picks when a model rewrote a URL (`www.` stripped, `utm_*` dropped). `selectInteresting` now matches on `pickKey` and keeps the candidate's own URL.
- The `select-score-strict` variant, which added more prohibitions, scored worse than the simpler scoring prompt. More rules is not automatically better.

The remaining prompt variants (`summary-tight`, `summary-minimal`) are untested: the OpenRouter key hit its spend cap before they ran.

---

## Code Quality and Git Hooks

### Linting and Formatting

- **[Oxlint](https://oxc.rs/docs/guide/usage/linter.html)**: a fast linter. It treats warnings as errors through `--deny-warnings`.
  ```bash
  bun run lint:check
  bun run lint:fix
  ```
- **[`bun fmt`](https://bun.com/docs/format)**: Bun's built-in formatter for code and Markdown. It reads `.oxfmtrc.json` and prints the same output as oxfmt.
  ```bash
  bun run format:check
  bun run format:fix
  ```
- **[`bun check`](https://bun.com/docs/runtime/check)**: Bun's built-in type checker. It reads `tsconfig.json` and reports the same errors as `tsc` from TypeScript 7.
  ```bash
  bun run type:check
  ```

### Pre-commit Hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs automatically on `git commit`. It runs `oxlint --fix` and `bun fmt` on staged files:

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
