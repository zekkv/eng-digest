import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Route modules hold routing, and nothing else.
 *
 * A route file that carries its whole view (inline components, local helpers, `useState`)
 * makes the page impossible to render without a router. Views live under
 * `src/features/<feature>/components/`, or under `src/components/pages/` for static pages.
 * These assertions stop the next view from moving back into a route file. Nothing else in the
 * suite would notice such a move, because a page that renders correctly renders correctly
 * wherever it is declared.
 *
 * The checks are textual on purpose. They check where a declaration sits. That is a property
 * of the file, not of the running application. A file read is the cheapest way to hold
 * a boundary that no rendering can check.
 */
const routesDir = path.resolve(process.cwd(), "src/routes");

function routeModules(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeModules(fullPath);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [fullPath] : [];
  });
}

function relative(filePath: string): string {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

/** A top-level `function`, `const`, `class`, or `type` declaration, identified by the name it binds. */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** React state and lifecycle. A route module that uses these renders instead of routing. */
const VIEW_HOOK =
  /\buse(?:State|Effect|LayoutEffect|Ref|Memo|Callback|Reducer|Transition|ImperativeHandle)\s*\(/;

describe("Route module boundaries", () => {
  const allRoutes = routeModules(routesDir);
  // The rendering routes. Each one is a `.tsx` file that hosts a view.
  const renderingRoutes = allRoutes.filter(filePath => filePath.endsWith(".tsx"));

  it("finds the route modules to hold", () => {
    expect(renderingRoutes.length).toBeGreaterThan(0);
  });

  renderingRoutes.forEach(filePath => {
    const relPath = relative(filePath);
    const content = fs.readFileSync(filePath, "utf-8");

    it(`${relPath} declares the route and nothing else`, () => {
      const declared = content
        .split("\n")
        .map(line => TOP_LEVEL_DECLARATION.exec(line)?.[1])
        .filter((name): name is string => name !== undefined);

      expect(declared).toEqual(["Route"]);
    });

    it(`${relPath} keeps view state out of the route`, () => {
      expect(VIEW_HOOK.test(content)).toBe(false);
    });
  });
});
