import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { DigestPayload, Summary } from "#/features/digest/types";
import { isHttpUrl } from "#/features/digest/url";

/**
 * Routes import this module, so it stays free of any static server import.
 * Handlers reach `./pipeline.server` through dynamic imports, which TanStack Start
 * strips from the client build.
 *
 * The digest is public reading with no sessions. The CSRF middleware in
 * `src/start.ts` guards same-origin calls. Validation lives in the Zod schema.
 * A refusal is a plain thrown `Error` with `issues[0].message`.
 */
const GetDigestInput = z.object({ refresh: z.boolean().optional() });

export function parseGetDigest(data: unknown) {
  const parsed = GetDigestInput.safeParse(data);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return parsed.data;
}

const SummarizeInput = z.object({
  url: z
    .string()
    .trim()
    .min(1, "url is required")
    .max(2048, "url is too long")
    .url("url must be a valid url")
    .refine(isHttpUrl, "url must be a valid http or https url"),
});

export function parseSummarize(data: unknown) {
  const parsed = SummarizeInput.safeParse(data);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return parsed.data;
}

/** refresh:true forces a feed refresh. Otherwise the cached digest is returned directly. */
export const getDigest = createServerFn({ method: "GET" })
  .validator(parseGetDigest)
  .handler(async ({ data }): Promise<DigestPayload> => {
    const { loadDigest } = await import("#/features/digest/pipeline.server");
    return loadDigest(data.refresh === true);
  });

export const summarizeArticle = createServerFn({ method: "POST" })
  .validator(parseSummarize)
  .handler(async ({ data }): Promise<Summary> => {
    const pipeline = await import("#/features/digest/pipeline.server");
    return pipeline.summarizeArticle(data.url);
  });
