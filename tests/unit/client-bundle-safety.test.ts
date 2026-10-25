import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Every module under the client-reachable shared directories falls in scope:
 * `src/features` and `src/components`. This holds whether or not the module declares
 * a server function or imports a server module today. The old code selected on `createServerFn(`.
 * That left a hole. A pure module that a route imports reaches the client bundle just the
 * same. `src/routes` stays out of scope, because the TanStack import-protection plugin and
 * `route-module-boundaries.test.ts` already cover route files.
 *
 * `*.server.ts` modules are exempt. The other side holds them instead:
 * `@tanstack/start-plugin-core` denies them in the client environment at build time.
 */
function getModules(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getModules(fullPath));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * The server-only specifiers in this repo are `node:*` built-ins,
 * the `bun` runtime, the server entrypoint of `@tanstack/react-start`, and
 * `*.server` modules. A static import of any of these from a client-reachable
 * module keeps server code in the client bundle. Such an import never fails
 * `bun run build`, so this test is the only guard between that mistake and production.
 */
const SERVER_ONLY_IMPORT =
  /^(?:node:[^"']*|bun(?::[^"']*)?|@tanstack\/react-start\/server(?:\/[^"']*)?|[^"']*\.server(?:\.[cm]?[jt]sx?)?)$/;

/**
 * A static `import`/`export … from` statement with its module specifier captured. The match
 * runs over the whole file, not line by line, so a wrapped import reads the same as a
 * single-line one. `import type` is excluded, because compilation erases it before bundling,
 * and a dynamic `import(` has no space after the keyword, so it never matches.
 */
const STATIC_IMPORT_SOURCE = /^[ \t]*(?:import|export)\s+(?!type\b)[^;]*?["']([^"']+)["']/gm;

/** The server-only specifiers that a module statically imports at top level. */
function serverOnlyImports(content: string): string[] {
  return Array.from(content.matchAll(STATIC_IMPORT_SOURCE))
    .map(match => match[1])
    .filter(specifier => SERVER_ONLY_IMPORT.test(specifier));
}

const GUARDED_DIRS = ["src/features", "src/components"];

describe("Client-Reachable Module Client Safety", () => {
  const guardedModules = GUARDED_DIRS.flatMap(dir =>
    getModules(path.resolve(process.cwd(), dir))
  ).filter(filePath => !/\.server\.tsx?$/.test(filePath));

  it("finds client-reachable modules to guard", () => {
    expect(guardedModules.length).toBeGreaterThan(0);
  });

  guardedModules.forEach(filePath => {
    const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");

    it(`${relPath} does not statically import server-only modules at top level`, () => {
      const content = fs.readFileSync(filePath, "utf-8");
      expect(serverOnlyImports(content)).toEqual([]);
    });
  });
});

describe("Client-safety scan (self-test)", () => {
  it.each([
    `import { SQL } from "bun";`,
    `import { setResponseStatus } from "@tanstack/react-start/server";`,
    `import fs from "node:fs";`,
    `import { records } from "./records.server";`,
    `import { records } from "./records.server.ts";`,
  ])("flags server-only import: %s", source => {
    expect(serverOnlyImports(source)).toHaveLength(1);
  });

  it("does not flag client-safe, type-only, or dynamic imports", () => {
    expect(serverOnlyImports(`import { z } from "zod";`)).toEqual([]);
    expect(serverOnlyImports(`import type { Stats } from "node:fs";`)).toEqual([]);
    expect(serverOnlyImports(`const fs = await import("node:fs");`)).toEqual([]);
  });
});
