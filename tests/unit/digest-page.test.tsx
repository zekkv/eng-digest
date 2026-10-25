import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Toaster } from "#/components/ui/sonner";
import {
  DigestPage,
  formatClock,
  markUp,
  readTime,
  timeAgo,
} from "#/features/digest/components/page";
import { getDigest, summarizeArticle } from "#/features/digest/server-fns";
import type { DigestArticle, DigestPayload, JargonTerm, Summary } from "#/features/digest/types";

const mockInvalidate = vi.fn<() => void>();

// DigestPage needs only useRouter (for router.invalidate after a mutation).
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: mockInvalidate }),
}));

vi.mock("#/features/digest/server-fns", () => ({
  getDigest: vi.fn<(options: { data: { refresh?: boolean } }) => Promise<DigestPayload>>(),
  summarizeArticle: vi.fn<(options: { data: { url: string } }) => Promise<Summary>>(),
}));

function article(overrides: Record<string, unknown> = {}): DigestArticle {
  return {
    url: "https://example.com/a",
    title: "t",
    blog: "B",
    published: 0,
    blurb: "",
    summary: null,
    ...overrides,
  } as DigestArticle;
}

function payload(articles: DigestArticle[], feeds: DigestPayload["feeds"] = []): DigestPayload {
  return { articles, feeds, fetchedAt: 0 };
}

function renderPage(data: DigestPayload) {
  return render(
    <ThemeProvider attribute="class" defaultTheme="light">
      <Toaster />
      <DigestPage data={data} />
    </ThemeProvider>
  );
}

function html(text: string, terms: JargonTerm[], used = new Set<number>()): string {
  return renderToStaticMarkup((<>{markUp(text, terms, used)}</>) as ReactElement);
}

describe("timeAgo", () => {
  it("says nothing for missing timestamps instead of 'never'", () => {
    expect(timeAgo(null)).toBe("");
    expect(timeAgo(undefined)).toBe("");
    expect(timeAgo(0)).toBe("");
  });

  it("renders minutes, hours, days, then a date", () => {
    const now = Date.now() / 1000;
    expect(timeAgo(now - 300)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3600)).toBe("3h ago");
    expect(timeAgo(now - 3 * 86400)).toBe("3d ago");
    expect(timeAgo(now - 60 * 86400)).toMatch(/\d/);
  });

  it("floors instead of rounding, so 59m59s never reads '60m ago'", () => {
    const now = Date.now() / 1000;
    expect(timeAgo(now - 3599)).toBe("59m ago");
    expect(timeAgo(now - 86399)).toBe("23h ago");
    expect(timeAgo(now - 29 * 86400)).toBe("29d ago");
  });
});

describe("readTime", () => {
  it("says nothing when the word count is unknown", () => {
    expect(readTime(undefined)).toBe("");
    expect(readTime(null)).toBe("");
    expect(readTime(0)).toBe("");
  });

  it("estimates at 220 wpm with a 1-minute floor", () => {
    expect(readTime(100)).toBe("1 min read");
    expect(readTime(220)).toBe("1 min read");
    expect(readTime(440)).toBe("2 min read");
  });
});

describe("formatClock", () => {
  it("renders a short clock time, or admits it does not know", () => {
    expect(formatClock(0)).toBe("time unknown");
    expect(formatClock(1791908418)).toMatch(/\d/);
  });
});

describe("markUp", () => {
  const terms: JargonTerm[] = [
    { term: "Durable Object", explanation: "one database, one actor" },
    { term: "control plane", explanation: "the back office" },
  ];

  it("leaves prose alone when nothing matches", () => {
    expect(markUp("hello world", [], new Set())).toBe("hello world");
    expect(html("hello world", terms)).toBe("hello world");
  });

  it("numbers the first occurrence in glossary order and skips repeats", () => {
    const used = new Set<number>();
    const out = html(
      "The control plane manages each Durable Object, and the control plane never sleeps",
      terms,
      used
    );
    expect(out).toContain("control plane<sup");
    expect(out).toContain("Durable Object<sup");
    expect(out.match(/<sup/g)).toHaveLength(2);
    // Glossary order, not occurrence order. Durable Object is term 0.
    expect(out.indexOf(">1<")).toBeGreaterThan(-1);
    expect(out.indexOf(">2<")).toBeGreaterThan(-1);
    expect(used).toEqual(new Set([0, 1]));
  });

  it("honors already-used terms and matches case-insensitively", () => {
    const out = html("Postgres holds the ledger", [{ term: "postgres", explanation: "e" }]);
    expect(out).toContain(">1</sup>");
    const used = new Set([0]);
    expect(html("Postgres holds the ledger", [{ term: "postgres", explanation: "e" }], used)).toBe(
      "Postgres holds the ledger"
    );
  });

  it("skips stub terms and overlapping matches keep the longest", () => {
    expect(html("a b", [{ term: "a", explanation: "e" }])).toBe("a b");
    const out = html("object storage it is", [
      { term: "object", explanation: "short" },
      { term: "object storage", explanation: "long" },
    ]);
    expect(out.match(/<sup/g)).toHaveLength(1);
    expect(out).toContain(">2</sup>");
  });

  it("never marks a term inside its plural", () => {
    expect(html("Durable Objects scale well", terms)).toBe("Durable Objects scale well");
  });

  it("marks the first clean occurrence when an early one sits mid-word", () => {
    const out = html("Durable Objects are many; a Durable Object is one", terms);
    expect(out.match(/<sup/g)).toHaveLength(1);
    expect(out).toContain("Durable Object<sup");
  });

  it("still marks a term followed by punctuation", () => {
    const out = html("Each Durable Object, isolated by design", terms);
    expect(out).toContain("Durable Object<sup");
  });
});

describe("DigestPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockInvalidate.mockReset();
    vi.mocked(getDigest).mockReset();
    vi.mocked(summarizeArticle).mockReset();
  });

  it("moves selection and focus with arrow keys", async () => {
    const user = userEvent.setup();
    renderPage(
      payload([
        article({ url: "https://example.com/1", title: "First", published: 200, picked: true }),
        article({ url: "https://example.com/2", title: "Second", published: 100, picked: true }),
      ])
    );

    expect(screen.getByRole("heading", { name: "First" })).toBeTruthy();
    const list = within(screen.getByRole("region", { name: "Articles" }));
    const [, second] = list.getAllByRole("button");

    list.getAllByRole("button")[0].focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("heading", { name: "Second" })).toBeTruthy();
    expect(document.activeElement).toBe(second);
  });

  it("filters Today picks versus All posts", async () => {
    const user = userEvent.setup();
    renderPage(
      payload([
        article({ url: "https://example.com/1", title: "Picked post", picked: true }),
        article({ url: "https://example.com/2", title: "Skipped post", picked: false }),
      ])
    );

    expect(screen.getByText("Scanned, not picked (1)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "All" }));

    const list = within(screen.getByRole("region", { name: "Articles" }));
    expect(list.getByText("Skipped post")).toBeTruthy();
    expect(screen.queryByText(/Scanned, not picked/)).toBeNull();
  });

  it("positions the scroll containers for the absolute sr-only notes", () => {
    const { container } = renderPage(payload([article({ picked: true })]));
    expect(screen.getByRole("region", { name: "Articles" }).className).toContain("relative");
    expect(container.querySelector("#digest-reading")?.className).toContain("relative");
  });

  it("announces refresh completion", async () => {
    const user = userEvent.setup();
    vi.mocked(getDigest).mockResolvedValue(
      payload([article({ url: "https://example.com/new", title: "Fresh", picked: true })])
    );
    renderPage(payload([article({ url: "https://example.com/1", title: "Old", picked: true })]));

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Fresh scan: 1 new post.")).toBeTruthy();
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("shows a retry when summarizing fails", async () => {
    vi.mocked(summarizeArticle).mockRejectedValue(new Error("blocked"));
    renderPage(
      payload([article({ url: "https://example.com/1", title: "Unnoted", picked: true })])
    );

    // fireEvent keeps the click synchronous with the pending state it triggers.
    fireEvent.click(screen.getByRole("button", { name: "Summarize this post" }));
    expect(await screen.findByText(/Couldn't summarize this post/)).toBeTruthy();
  });

  it("announces failed feeds and stays silent when all feeds are fine", () => {
    const failed = renderPage(
      payload(
        [article({ url: "https://example.com/1", title: "Post", picked: true })],
        [{ name: "Cloudflare", ok: false, error: "503" }]
      )
    );
    expect(screen.getByText("1 source down")).toBeTruthy();
    expect(screen.getByText("Cloudflare")).toBeTruthy();
    expect(screen.getByText("503")).toBeTruthy();
    // output/status takes no accessible name from its contents, so read the text.
    const announcements = screen.getAllByRole("status").map(s => s.textContent ?? "");
    expect(announcements.some(text => text.includes("1 source down: Cloudflare"))).toBe(true);
    failed.unmount();

    renderPage(
      payload(
        [article({ url: "https://example.com/1", title: "Post", picked: true })],
        [{ name: "Cloudflare", ok: true, count: 3 }]
      )
    );
    expect(screen.queryByText(/sources? down/)).toBeNull();
    const quiet = screen.getAllByRole("status").map(s => s.textContent ?? "");
    expect(quiet.every(text => !/sources? down/.test(text))).toBe(true);
  });

  it("preserves readUrls from localStorage on mount without wiping them", () => {
    window.localStorage.setItem("digest:read:v1", JSON.stringify(["https://example.com/1"]));
    renderPage(
      payload([
        article({ url: "https://example.com/1", title: "Read Post", picked: true }),
        article({ url: "https://example.com/2", title: "Unread Post", picked: true }),
      ])
    );
    expect(window.localStorage.getItem("digest:read:v1")).toBe(
      JSON.stringify(["https://example.com/1"])
    );
  });

  it("caps readUrls in localStorage to 500 entries", async () => {
    const user = userEvent.setup();
    const stored = Array.from({ length: 505 }, (_, i) => `https://example.com/old-${i}`);
    window.localStorage.setItem("digest:read:v1", JSON.stringify(stored));
    renderPage(
      payload([
        article({ url: "https://example.com/new-article", title: "New Article", picked: true }),
      ])
    );
    await user.click(screen.getByRole("button", { name: /New Article/ }));
    const saved = JSON.parse(window.localStorage.getItem("digest:read:v1") ?? "[]") as string[];
    expect(saved.length).toBeLessThanOrEqual(500);
    expect(saved).toContain("https://example.com/new-article");
  });

  it("displays server error message when summarizing fails", async () => {
    vi.mocked(summarizeArticle).mockRejectedValue(
      new Error("the daily summary budget is spent — it resets tomorrow")
    );
    renderPage(
      payload([article({ url: "https://example.com/1", title: "Unnoted", picked: true })])
    );

    fireEvent.click(screen.getByRole("button", { name: "Summarize this post" }));
    expect(
      await screen.findByText(
        /Couldn't summarize this post — the daily summary budget is spent — it resets tomorrow/
      )
    ).toBeTruthy();
  });

  it("supports selection and active styling in 'Scanned, not picked' list", async () => {
    const user = userEvent.setup();
    renderPage(
      payload([
        article({ url: "https://example.com/1", title: "Picked", picked: true }),
        article({ url: "https://example.com/2", title: "Not Picked", picked: false }),
      ])
    );

    const button = screen.getByRole("button", { name: /Not Picked/ });
    expect(button.getAttribute("aria-current")).toBeNull();
    await user.click(button);
    expect(button.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("heading", { name: "Not Picked" })).toBeTruthy();
  });
});
