import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "#": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    clearMocks: true,
    restoreMocks: true,
    include: ["tests/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    environment: "jsdom",
    globals: true,
    setupFiles: [path.resolve(import.meta.dirname, "./tests/setup.ts")],
    coverage: {
      reporter: ["text", "json", "html"],
      enabled: true,
      // Measure the hand-written source tree only: generated files, vendored shadcn primitives,
      // and the bootstrap entrypoints are not what these tests exercise.
      include: [
        "src/*.{ts,tsx}",
        "src/components/**/*.{ts,tsx}",
        "src/features/**/*.{ts,tsx}",
        "src/routes/api/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.d.ts",
        "src/components/ui/**",
        "src/routeTree.gen.ts",
        "src/router.tsx",
        "src/server.ts",
        "src/start.ts",
      ],
      thresholds: {
        lines: 50,
        functions: 45,
        branches: 45,
        statements: 50,
      },
    },
    // A project that collected nothing is a wiring failure, not a pass.
    passWithNoTests: false,
    reporters: ["dot", "github-actions"],
  },
});
