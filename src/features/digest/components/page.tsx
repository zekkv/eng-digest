import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { getDigest, summarizeArticle } from "#/features/digest/server-fns";
import type { DigestArticle, DigestPayload, FeedStatus, JargonTerm } from "#/features/digest/types";
import { Button } from "#/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "#/components/ui/sheet";
import { Skeleton } from "#/components/ui/skeleton";

/** This is the words-per-minute rate for the read-time estimate. It affects display only. */
const WORDS_PER_MINUTE = 220;

/** One grid string for the scan list and the reading surface. The skeleton shares it. */
const READING_GRID =
  "mt-6 grid gap-6 md:grid-cols-[20rem_minmax(0,1fr)] lg:grid-cols-[22rem_minmax(0,1fr)]";

const READ_KEY = "digest:read:v1";
const SELECTED_KEY = "digest:selected:v1";
const MAX_STORED_READS = 500;

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

/** Honest read time from the extracted page text. The value is "" when the count is unknown (legacy entry). */
export function readTime(words: number | null | undefined): string {
  if (!words) return "";
  return `${Math.max(1, Math.round(words / WORDS_PER_MINUTE))} min read`;
}

function readStoredList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : [];
    return list.slice(-MAX_STORED_READS);
  } catch {
    return [];
  }
}

function writeStoredList(key: string, value: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value.slice(-MAX_STORED_READS)));
  } catch {
    // In private mode the digest still works, but it stores nothing.
  }
}

interface SummarizeControls {
  /** URL of the article for the active summary request, or of one that just failed. Null otherwise. */
  target: string | null;
  pending: boolean;
  failed: boolean;
  error?: string;
  run: (url: string) => void;
}

export function DigestPage({ data }: { data: DigestPayload }) {
  const { articles, feeds, fetchedAt } = data;
  const router = useRouter();
  const [scope, setScope] = useState<"today" | "all">("today");
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [readUrls, setReadUrls] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [summarizing, setSummarizing] = useState<{
    url: string;
    failed: boolean;
    error?: string;
  } | null>(null);
  const isHydrated = useRef(false);

  const sorted = articles.toSorted((a, b) => b.published - a.published);
  const picks = sorted.filter(a => a.picked);
  const primary = scope === "today" ? picks : sorted;
  const rest = sorted.filter(a => !a.picked);

  const selected = sorted.find(a => a.url === selectedUrl) ?? picks.at(0) ?? sorted.at(0) ?? null;
  const isInRest = scope === "today" && rest.some(a => a.url === selected?.url);
  const currentList = isInRest ? rest : primary;
  const currentIndex = currentList.findIndex(a => a.url === selected?.url);

  // Restore once. The loader already resolved, so this is a mount-time read of browser
  // storage. localStorage has no SSR-safe read at render time.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setReadUrls(readStoredList(READ_KEY));
    try {
      const last = window.localStorage.getItem(SELECTED_KEY);
      if (last && articles.some(a => a.url === last)) setSelectedUrl(last);
    } catch {
      // In private mode the digest still works, but it stores nothing.
    }
    // Mount-only. Re-applying a stored selection after every revalidate would
    // overwrite the row that the reader just picked.
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // Persistence lives here and follows the state. Never persist inside a state updater.
  // Guard the persistence effect to skip the initial mount commit before hydration flushes.
  useEffect(() => {
    if (!isHydrated.current) {
      isHydrated.current = true;
      return;
    }
    writeStoredList(READ_KEY, readUrls);
  }, [readUrls]);

  useEffect(() => {
    if (selectedUrl === null) return;
    try {
      window.localStorage.setItem(SELECTED_KEY, selectedUrl);
    } catch {
      // Private mode. Store nothing and report nothing.
    }
  }, [selectedUrl]);

  // Close the mobile sheet when window width is >= 768px.
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = (event: MediaQueryListEvent) => {
      if (event.matches) setDetailOpen(false);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const payload = await getDigest({ data: { refresh: true } });
      const seen = new Set(articles.map(a => a.url));
      const fresh = payload.articles.filter(a => !seen.has(a.url)).length;
      if (fresh > 0) toast.success(`Fresh scan: ${fresh} new ${fresh === 1 ? "post" : "posts"}.`);
      else toast.success("Scan updated — no new posts in this pass.");
      await router.invalidate();
    } catch {
      toast.error("Refresh failed — the scan did not finish. Try again.");
    } finally {
      setRefreshing(false);
    }
  };

  const summarize: SummarizeControls = {
    target: summarizing?.url ?? null,
    pending: summarizing !== null && !summarizing.failed,
    failed: summarizing?.failed ?? false,
    error: summarizing?.error,
    run: url => {
      setSummarizing({ url, failed: false });
      void summarizeArticle({ data: { url } })
        .then(async () => {
          await router.invalidate();
          setSummarizing(prev => (prev?.url === url ? null : prev));
          return null;
        })
        .catch((error: unknown) => {
          const raw =
            error instanceof Error && error.message
              ? error.message
              : "the page may have blocked the reader";
          const message = raw.endsWith(".") ? raw : `${raw}.`;
          setSummarizing(prev =>
            prev?.url === url ? { url, failed: true, error: message } : prev
          );
        });
    },
  };

  const select = (url: string, openSheet = true) => {
    setSelectedUrl(url);
    setReadUrls(previous => {
      const next = previous.includes(url) ? previous : [...previous, url];
      return next.length > MAX_STORED_READS ? next.slice(-MAX_STORED_READS) : next;
    });
    if (openSheet && window.matchMedia("(max-width: 767px)").matches) {
      setDetailOpen(true);
    }
  };

  const step = (delta: -1 | 1) => {
    if (currentIndex === -1) return;
    const targetIndex = currentIndex + delta;
    if (targetIndex >= 0 && targetIndex < currentList.length) {
      select(currentList[targetIndex].url);
    }
  };

  const read = new Set(readUrls);
  const statusText = selected
    ? `Loaded: ${selected.title} — ${selected.summary ? `summary, ${readTime(selected.summary.words) || "read time unknown"}` : "no summary yet"}`
    : "No article selected";

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      {sorted.length > 0 && (
        <a
          href="#digest-reading"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-paper focus:px-4 focus:py-2 focus:font-notes focus:text-editor max-md:hidden"
        >
          Skip to summary
        </a>
      )}
      <output className="sr-only">{statusText}</output>

      <header>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            Today&apos;s picks{picks.length > 0 && ` (${picks.length})`}
          </h1>
          {/* Relative time can change between SSR and hydration. The mismatch is cosmetic only. */}
          <p suppressHydrationWarning className="font-notes text-sm text-soft tabular-nums">
            {picks.length} picked of {articles.length} scanned
            {fetchedAt ? ` · scanned ${timeAgo(fetchedAt)}` : ""}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <FeedsAlert feeds={feeds} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? (
                <>
                  <Loader2 aria-hidden="true" className="animate-spin" />
                  Scanning…
                </>
              ) : (
                "Refresh"
              )}
            </Button>
          </div>
        </div>
        <FeedFailures feeds={feeds} />
        <fieldset className="mt-4 inline-flex rounded-md border border-proof/15 p-1">
          <legend className="sr-only">Scope</legend>
          {(["today", "all"] as const).map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
              className={
                scope === value
                  ? "rounded bg-proof px-3 py-1 text-sm font-medium text-paper transition-colors duration-150"
                  : "rounded px-3 py-1 text-sm text-soft transition-colors duration-150 hover:text-proof"
              }
            >
              {value === "today" ? "Today" : "All"}
            </button>
          ))}
        </fieldset>
      </header>

      {sorted.length === 0 ? (
        <div className="mt-6 max-w-xl border border-proof/15 bg-paper p-6">
          <h2 className="font-heading text-2xl font-semibold tracking-tight">
            Nothing on the desk yet
          </h2>
          <p className="mt-3 leading-relaxed text-soft">
            Every morning this digest scans your engineering feeds, picks the posts worth your time,
            and decodes the jargon in them. Run the first scan to get started.
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? (
              <>
                <Loader2 aria-hidden="true" className="animate-spin" />
                Scanning…
              </>
            ) : (
              "Scan the feeds"
            )}
          </Button>
        </div>
      ) : (
        <div className={READING_GRID}>
          {/* `relative` keeps the absolute sr-only note labels inside the scroll clip. */}
          <section
            aria-label="Articles"
            aria-busy={refreshing}
            className="relative min-h-0 md:h-[calc(100dvh-17rem)] md:overflow-y-auto md:overscroll-contain"
          >
            {scope === "today" && picks.length === 0 ? (
              <div className="border border-proof/15 p-6">
                <p className="font-heading text-lg font-semibold">No picks yet today</p>
                <p className="mt-2 text-sm leading-relaxed text-soft">
                  The morning scan hasn&apos;t chosen anything. Browse everything instead.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setScope("all")}
                >
                  Browse all {articles.length} posts
                </Button>
              </div>
            ) : (
              <ScanList
                items={primary}
                selectedUrl={selected?.url ?? null}
                read={read}
                onSelect={select}
              />
            )}
            {scope === "today" && rest.length > 0 && (
              <details className="mt-4 border border-proof/15">
                <summary className="cursor-pointer px-4 py-3 font-notes text-sm text-soft hover:text-proof">
                  Scanned, not picked ({rest.length})
                </summary>
                <ul className="border-t border-proof/15">
                  {rest.map(a => {
                    const active = a.url === selected?.url;
                    return (
                      <li key={a.url} className="border-b border-proof/15 last:border-b-0">
                        <button
                          type="button"
                          aria-current={active ? true : undefined}
                          onClick={() => select(a.url)}
                          className={
                            active
                              ? "block w-full border-l-2 border-l-proof bg-wash px-4 py-2 text-left transition-colors duration-150"
                              : "block w-full border-l-2 border-l-transparent px-4 py-2 text-left transition-colors duration-150 hover:bg-wash/60 active:bg-wash"
                          }
                        >
                          <span
                            className={
                              active ? "block text-sm font-semibold" : "block text-sm font-medium"
                            }
                          >
                            <span className={read.has(a.url) && !active ? "text-soft" : undefined}>
                              {a.title}
                            </span>
                          </span>
                          <span className="mt-0.5 block font-notes text-xs text-soft">
                            {a.blog}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </section>

          <article
            id="digest-reading"
            tabIndex={-1}
            className="relative hidden min-w-0 md:block md:h-[calc(100dvh-17rem)] md:overflow-y-auto md:overscroll-contain"
          >
            {selected && (
              <div key={selected.url}>
                <DetailBody article={selected} summarize={summarize} />
              </div>
            )}
          </article>
        </div>
      )}

      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="max-h-[92dvh] w-full overflow-y-auto">
          <SheetHeader className="sr-only">
            <SheetTitle>{selected?.title ?? "Article"}</SheetTitle>
          </SheetHeader>
          {selected && (
            <div
              key={selected.url}
              className="min-h-full bg-paper/95 px-5 py-6 text-proof backdrop-blur-xl"
            >
              <DetailBody
                article={selected}
                summarize={summarize}
                onBack={() => setDetailOpen(false)}
                nav={
                  currentIndex > -1
                    ? {
                        index: currentIndex,
                        total: currentList.length,
                        onPrev: () => step(-1),
                        onNext: () => step(1),
                      }
                    : undefined
                }
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}

/** Scan list with one tab stop. Plain buttons with roving tabindex. Arrow keys move, and Home and End jump. */
function ScanList({
  items,
  selectedUrl,
  read,
  onSelect,
}: {
  items: DigestArticle[];
  selectedUrl: string | null;
  read: Set<string>;
  onSelect: (url: string, openSheet?: boolean) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIndex = Math.max(
    0,
    items.findIndex(a => a.url === selectedUrl)
  );

  const move = (event: KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = items.at(next);
    if (target) {
      onSelect(target.url, false);
      buttons.current[next]?.focus();
    }
  };

  return (
    <ul>
      {items.map((a, index) => {
        const active = a.url === selectedUrl;
        const preview = a.summary?.tldr || a.blurb;
        return (
          <li key={a.url} className="border-b border-proof/15 last:border-b-0">
            <button
              ref={node => {
                buttons.current[index] = node;
              }}
              type="button"
              tabIndex={index === focusIndex ? 0 : -1}
              aria-current={active ? true : undefined}
              onClick={() => onSelect(a.url, true)}
              onKeyDown={event => move(event, index)}
              className={
                active
                  ? "block w-full border-l-2 border-l-proof bg-wash px-4 py-3 text-left transition-colors duration-150"
                  : "block w-full border-l-2 border-l-transparent px-4 py-3 text-left transition-colors duration-150 hover:bg-wash/60 active:bg-wash"
              }
            >
              <span
                className={active ? "block text-sm font-semibold" : "block text-sm font-medium"}
              >
                <span className={read.has(a.url) && !active ? "text-soft" : undefined}>
                  {a.title}
                </span>
              </span>
              {preview && (
                <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-soft">
                  {preview}
                </span>
              )}
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-notes text-xs text-soft tabular-nums">
                <span>{a.blog}</span>
                {a.summary && (a.summary.words ?? 0) > 0 && (
                  <span>{readTime(a.summary.words)}</span>
                )}
                {a.published > 0 && <span suppressHydrationWarning>{timeAgo(a.published)}</span>}
                {a.summary?.difficulty && <Tier difficulty={a.summary.difficulty} />}
              </span>
              {a.summary && a.summary.jargon.length > 0 && (
                <span className="mt-1 block font-notes text-xs text-editor">
                  {a.summary.jargon.slice(0, 3).map((j, i) => (
                    <span key={j.term}>
                      {i > 0 && <span aria-hidden="true"> · </span>}
                      <sup aria-hidden="true">{i + 1}</sup> {j.term}
                    </span>
                  ))}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Tier mark. Pencil red marks only "advanced". Everything else stays soft. */
function Tier({ difficulty }: { difficulty: string }) {
  return (
    <span className={difficulty === "advanced" ? "font-semibold text-pencil" : undefined}>
      {difficulty}
    </span>
  );
}

/** Feed health shows only failures, as a compact chip. The details render under the header. */
function FeedsAlert({ feeds }: { feeds: FeedStatus[] }) {
  const failed = failedFeeds(feeds);
  if (failed.length === 0) return null;
  return (
    <span className="rounded-md border border-pencil/40 bg-pencil/10 px-2.5 py-1 font-notes text-xs text-pencil">
      {downLabel(failed.length)}
    </span>
  );
}

/** One quiet line per failure. The line truncates long upstream errors and shows the full text on hover. */
function FeedFailures({ feeds }: { feeds: FeedStatus[] }) {
  const failed = failedFeeds(feeds);
  if (failed.length === 0) return null;
  return (
    <div className="mt-2 max-w-2xl">
      {/* The output carries the implicit status role. It announces, without taking list semantics. */}
      <output className="sr-only">
        {downLabel(failed.length)}: {failed.map(f => f.name).join(", ")}
      </output>
      <ul className="space-y-0.5 font-notes text-xs">
        {failed.map(f => (
          <li key={f.name} className="flex gap-2">
            <span className="shrink-0 font-semibold text-pencil">{f.name}</span>
            <span className="min-w-0 truncate text-soft" title={f.error ?? "failed"}>
              {f.error ?? "failed"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function downLabel(count: number): string {
  return count === 1 ? "1 source down" : `${count} sources down`;
}

/** Failed feeds, one per source. Legacy caches briefly held several entries per source. */
function failedFeeds(feeds: FeedStatus[]): FeedStatus[] {
  return [...new Map(feeds.filter(f => !f.ok).map(f => [f.name, f])).values()];
}

function DetailBody({
  article,
  summarize,
  onBack,
  nav,
}: {
  article: DigestArticle;
  summarize: SummarizeControls;
  onBack?: () => void;
  nav?: { index: number; total: number; onPrev: () => void; onNext: () => void };
}) {
  const summary = article.summary;
  const active = summarize.target === article.url;
  const used = new Set<number>();
  return (
    <div>
      {(onBack || nav) && (
        <div className="mb-4 flex items-center gap-2">
          {onBack && (
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              ← All articles
            </Button>
          )}
          {nav && (
            <span className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={nav.index <= 0}
                onClick={nav.onPrev}
              >
                ← Prev
              </Button>
              <span className="font-notes text-xs text-soft">
                {nav.index + 1}/{nav.total}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={nav.index >= nav.total - 1}
                onClick={nav.onNext}
              >
                Next →
              </Button>
            </span>
          )}
        </div>
      )}
      <h2 className="font-heading text-2xl font-semibold tracking-tight md:text-3xl">
        {article.title}
      </h2>
      <p suppressHydrationWarning className="mt-2 font-notes text-sm text-soft tabular-nums">
        {article.blog}
        {article.published > 0 && <> · {timeAgo(article.published)}</>}
        {summary && (summary.words ?? 0) > 0 && <> · {readTime(summary.words)}</>}
        {article.summary?.difficulty && (
          <>
            {" · "}
            <Tier difficulty={article.summary.difficulty} />
          </>
        )}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          nativeButton={false}
          render={
            <a href={article.url} target="_blank" rel="noreferrer">
              Read the original ↗
            </a>
          }
        />
        {!summary && !(active && (summarize.pending || summarize.failed)) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => summarize.run(article.url)}
          >
            Summarize this post
          </Button>
        )}
      </div>

      {summary ? (
        <div className="mt-6 xl:grid xl:grid-cols-[minmax(0,65ch)_11rem] xl:gap-10">
          <div className="min-w-0">
            {summary.tldr && (
              <p className="max-w-[65ch] text-lg leading-relaxed">
                {markUp(summary.tldr, summary.jargon, used)}
              </p>
            )}
            {summary.keyPoints.length > 0 && (
              <div>
                <h3 className="font-heading mt-8 text-lg font-semibold tracking-tight">
                  Key points
                </h3>
                <ul className="mt-2 max-w-[65ch] space-y-2 text-base leading-relaxed">
                  {summary.keyPoints.map(point => (
                    <li key={point} className="flex gap-2">
                      <span aria-hidden="true" className="font-notes text-editor">
                        →
                      </span>
                      <span>{markUp(point, summary.jargon, used)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.jargon.length > 0 && <NotesSection jargon={summary.jargon} />}
            <footer className="mt-10 border-t border-proof/15 pt-4 font-notes text-xs text-soft">
              <span title={summary.model}>generated {formatClock(summary.generatedAt)}</span>
            </footer>
          </div>
          {summary.jargon.length > 0 && (
            <aside aria-label="Decoded jargon" className="hidden min-w-0 xl:block">
              <ol className="space-y-4">
                {summary.jargon.map((j, i) => (
                  <Note key={j.term} index={i} term={j.term} explanation={j.explanation} compact />
                ))}
              </ol>
            </aside>
          )}
        </div>
      ) : active && summarize.pending ? (
        <output className="shimmer mt-6 block max-w-[65ch] leading-relaxed">
          Reading the full post and writing notes… this can take a minute.
        </output>
      ) : active && summarize.failed ? (
        <div className="mt-6 max-w-[65ch]">
          <p role="alert" className="leading-relaxed">
            Couldn&apos;t summarize this post —{" "}
            {summarize.error || "the page may have blocked the reader."}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            onClick={() => summarize.run(article.url)}
          >
            Try again
          </Button>
        </div>
      ) : (
        <div className="mt-6 max-w-[65ch]">
          <p className="leading-relaxed text-soft">
            No notes on this one yet — the morning scan didn&apos;t pick it.
          </p>
        </div>
      )}
    </div>
  );
}

/** An ASCII word character is a letter, a digit, or an underscore. */
function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

/**
 * Editor marks. A jargon term that the summarizer returned receives a superscript
 * number at its first clean occurrence in the prose. Occurrences inside code or links
 * never count, because this prose is plain text. A match counts only when both neighbours
 * are non-word characters, so "Durable Objects" never marks the singular "Durable Object".
 * Numbering follows the glossary order. Tests import this function.
 */
export function markUp(text: string, terms: JargonTerm[], used: Set<number>): ReactNode {
  const lower = text.toLowerCase();
  const hits: { start: number; end: number; index: number }[] = [];
  terms.forEach((entry, index) => {
    if (used.has(index)) return;
    const needle = entry.term.trim().toLowerCase();
    if (needle.length < 2) return;
    let from = 0;
    while (from + needle.length <= lower.length) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? "" : lower[at - 1];
      const after = at + needle.length >= lower.length ? "" : lower[at + needle.length];
      if (!isWordChar(before) && !isWordChar(after)) {
        hits.push({ start: at, end: at + needle.length, index });
        break;
      }
      from = at + 1;
    }
  });
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: typeof hits = [];
  for (const hit of hits) {
    if (kept.every(done => hit.start >= done.end || hit.end <= done.start)) kept.push(hit);
  }
  if (kept.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  kept.forEach(hit => {
    if (hit.start > cursor) nodes.push(text.slice(cursor, hit.start));
    nodes.push(text.slice(hit.start, hit.end));
    nodes.push(
      <sup key={hit.index} className="font-notes text-editor" title={terms[hit.index].term}>
        {hit.index + 1}
      </sup>
    );
    used.add(hit.index);
    cursor = hit.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function NotesSection({ jargon }: { jargon: JargonTerm[] }) {
  return (
    <div className="xl:hidden">
      <h3 className="font-heading mt-8 text-lg font-semibold tracking-tight">Decoded jargon</h3>
      <ol className="mt-2 max-w-[65ch] space-y-3">
        {jargon.map((j, i) => (
          <Note key={j.term} index={i} term={j.term} explanation={j.explanation} />
        ))}
      </ol>
    </div>
  );
}

function Note({
  index,
  term,
  explanation,
  compact,
}: {
  index: number;
  term: string;
  explanation: string;
  compact?: boolean;
}) {
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className="font-notes text-sm font-bold text-editor">
        {index + 1}
      </span>
      <div className={compact ? "text-xs leading-relaxed" : "text-sm leading-relaxed"}>
        <p className="font-medium">
          <span className="sr-only">Note {index + 1}: </span>
          {term}
        </p>
        <p className="mt-0.5 text-soft">{explanation}</p>
      </div>
    </li>
  );
}

/** Small human-readable provenance ("generated 06:12"). The model id lives in a title attribute. */
export function formatClock(ts: number): string {
  if (!ts) return "time unknown";
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DigestPageSkeleton() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6" aria-busy="true">
      <output className="sr-only">Loading digest</output>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Today&apos;s picks</h1>
        <Skeleton className="h-5 w-56" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      </header>
      <div className={READING_GRID}>
        <div className="space-y-2">
          {[0, 1, 2, 3, 4, 5].map(row => (
            <Skeleton key={row} className="h-16 w-full" />
          ))}
        </div>
        <div className="hidden md:block">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="mt-3 h-4 w-1/2" />
          <Skeleton className="mt-6 h-24 w-full" />
          <Skeleton className="mt-4 h-24 w-full" />
        </div>
      </div>
    </main>
  );
}
