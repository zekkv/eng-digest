import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, createLogger } from "vite";

const logger = createLogger();
const originalWarn = logger.warn.bind(logger);

logger.warn = (msg, options) => {
  if (msg.includes("Failed to load source map")) return;
  originalWarn(msg, options);
};

const config = defineConfig(({ mode }) => {
  return {
    customLogger: logger,
    server: {
      watch: {
        // build/test artifacts rewritten during dev must not trigger reloads
        ignored: [
          "**/coverage/**",
          "**/.output/**",
          "**/.tanstack/**",
          "**/playwright-report/**",
          "**/test-results/**",
        ],
      },
    },
    plugins: [
      nitro({
        // `bun run build` stays on the bun preset (local dev and the daily script
        // keep the filesystem store); `bun run build:vercel` switches to Vercel.
        preset: mode === "vercel" ? "vercel" : "bun",
        routeRules: {
          "/assets/**": {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
            },
          },
        },
      }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
  };
});

export default config;
