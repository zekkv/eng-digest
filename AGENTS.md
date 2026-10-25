# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Where things are documented

Read these files instead of deriving the facts again. Do not duplicate their content here.

- `docs/ARCHITECTURE.md` describes the stack, the directory map, the data flow, and observability config.
- `docs/DEVELOPMENT.md` describes local setup, environment variables, scripts, testing, and tooling.
- `README.md` gives the overview, the quickstart, and the daily digest job.

## Running a single test

`package.json` exposes only whole-suite scripts. To target one test, pass the path through:

```bash
bun run vitest run tests/unit/digest.test.ts            # one file
bun run vitest run tests/unit/digest.test.ts -t "merges mocked"   # one case
bun run playwright test tests/e2e/digest.test.ts     # one E2E file
```

## Test layout gotchas

- `bun run test` runs the Vitest suite (`tests/unit/`, `jsdom` environment).
- Unit tests must not rely on external network services. `tests/setup.ts` supplies dummy API keys, so test runs never depend on the developer's `.env`.
- Coverage is `enabled: true` in `vitest.config.ts`, so test runs rewrite `coverage/`.

## File naming inside `src/features/`

- Server functions exported via `createServerFn` and consumed by routes are compiled for the client environment. TanStack Start strips `.handler(...)` bodies but keeps all other `export` declarations.
- Never statically import server-only dependencies (`node:` built-ins, `*.server` modules) at module level in a route-imported module. The import keeps the dependency in the AST. Dead Code Elimination cannot remove it, so server code leaks into client bundles.
- Instead, load server dependencies dynamically inside `.handler()` via `await import("#/features/digest/pipeline.server")`, and import server types with `import type`.
- Do **not** name either kind `<feature>.server.ts`. `@tanstack/start-plugin-core`'s import-protection plugin denies `**/*.server.*` in the client environment, so the first route that imports it fails `bun run build`; `tests/unit/client-bundle-safety.test.ts` also flags a static `.server` import from the shared directories that it scans. Reserve that suffix for modules that no client-reachable file imports.
- Do not use a `-model` suffix, and do not repeat the entity name (`notes/notes-fns.ts`). A helper with one caller lives in that caller's file. This holds even when a unit test imports and tests it: export it from the caller's file for the test. Extract a helper into its own file only when two or more application callers use it.
- Server-function validation lives in the Zod schema. Parse with `safeParse` and rethrow `issues[0].message`. Never let a raw `ZodError` reach a route.
- A server function refuses by throwing an `Error` with the message for the UI. Never return or throw a `Response` for a refusal. TanStack Start resolves such a `Response` as a value in the browser instead of rejecting it.

## Imports

`#/...` is the only alias for `src/`. Three places declare it and must stay in sync: `tsconfig.json` `paths`, `package.json` `imports`, and the `alias` block in `vitest.config.ts`. Adding another alias means changing all three. Otherwise the code typechecks and then fails under test. `components.json` already generates `#/`, so shadcn output needs no rewriting.

## Adding an environment variable

Two places are required. Add a commented entry in `.env.example`. Update `README.md` when the variable changes setup steps. Server code reads `process.env` directly.
