// oxlint-disable node/no-process-env, no-console
import { daily, fetchCandidates, sourcesFor } from "#/features/digest/pipeline.server";
import { loadCache } from "#/features/digest/store.server";

/** Fetch the tracked sources and print counts/statuses. Writes nothing, makes no LLM calls. */
export async function dryRun(): Promise<void> {
  const cache = await loadCache();
  const { articles, feeds } = await fetchCandidates(
    sourcesFor(cache),
    new Set(cache.articles.map(article => article.url))
  );
  const healthy = feeds.filter(feed => feed.ok);
  console.log(`feeds: ${healthy.length}/${feeds.length} ok`);
  for (const feed of feeds) {
    console.log(
      `  ${feed.ok ? "ok" : "FAIL"} ${feed.name}: ${feed.ok ? `${feed.count} articles` : feed.error}`
    );
  }
  const undated = articles.filter(article => article.published === 0).length;
  console.log(
    `candidates: ${articles.length} (${articles.length - undated} dated, ${undated} undated)`
  );
}

function fail(error: unknown): never {
  console.error("digest daily failed:", error);
  process.exit(1);
}

if (import.meta.main) {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--dry-run")) {
    dryRun()
      .then(() => process.exit(0))
      .catch(fail);
  } else {
    daily(flags.has("--force"))
      .then(result => process.exit(result.summarized === 0 && result.pending > 0 ? 1 : 0))
      .catch(fail);
  }
}
