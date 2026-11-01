/** Prompt variants under test. The baseline is imported from the shipped config so the
 * eval always measures what production actually sends. */

import { PROMPT, SELECT_PROMPT } from "#/features/digest/config";

export interface PromptVariant {
  id: string;
  note: string;
  text: string;
}

/** Picker prompt variants. `{n}` is replaced with the pick count, as production does. */
export const SELECT_VARIANTS: PromptVariant[] = [
  {
    id: "select-baseline",
    note: "Shipped prompt.",
    text: SELECT_PROMPT,
  },
  {
    id: "select-rubric",
    note: "Ordered criteria, explicit reject list, one post per blog, no padding.",
    text: `You pick the most interesting posts for a backend-leaning generalist developer who is learning advanced engineering topics. You see only the title, blog, and teaser, so judge by topic and depth, not by hype.

Return ONLY valid JSON of this shape: {"picked": ["<url>", ...]}

Pick at most {n} urls, best first, using these criteria in order:
1. Depth: a design writeup, architecture deep dive, debugging war story, measured benchmark, or postmortem that teaches something transferable.
2. Substance: specific mechanisms, tradeoffs, numbers, or failures. Prefer first-hand engineering over commentary about engineering.
3. Novelty: something the reader is unlikely to already know from general news.

Reject:
- product news, changelogs, feature previews, version bumps, pricing or availability updates
- funding, hiring, partnerships, policy, governance, and executive announcements
- listicles, roundups, "X ways to...", "N lessons", interviews, podcasts, and conference recaps
- vendor case studies whose main claim is that the product worked
- posts outside software engineering

Pick at most one post per blog. If two candidates cover the same news event, pick the one with more technical detail. Return fewer than {n} only when fewer candidates meet the bar.`,
  },
  {
    id: "select-contrast",
    note: "Few-shot contrastive examples, shortest instructions.",
    text: `You pick the most interesting posts for a backend-leaning generalist developer who is learning advanced engineering topics.

Good picks look like: an incident postmortem with a root cause; a storage, scheduler, or crypto design doc with tradeoffs; a benchmark that changes a default; a security writeup with a working exploit path; a first-hand account of a migration that went wrong.

Bad picks look like: "Introducing X", "X is now generally available", "X v2.4 released", "How company Y uses Z", "N ways to...", funding, hiring, partnerships, policy, conference recaps, and anything outside software engineering.

Return ONLY valid JSON of this shape: {"picked": ["<url>", ...]}
Pick at most {n} urls, best first, at most one per blog.`,
  },
  {
    id: "select-score-strict",
    note: "Private scoring plus an explicit off-topic rule and a duplicate-event rule.",
    text: `You pick the most interesting posts for a backend-leaning generalist developer who is learning advanced engineering topics.

First score each candidate privately, without writing the scores out: depth (0-3), substance (0-3), and novelty (0-3).

Score 0 on depth, whatever the company or Hacker News score:
- changelogs, release notes, feature previews, version bumps, pricing or availability updates
- funding, hiring, partnerships, policy, governance, and executive announcements
- listicles, roundups, "X ways to...", interviews, podcasts, conference recaps
- vendor case studies whose main claim is that the product worked
- posts outside software engineering: mathematics, physics, biology, business, careers

If two candidates cover the same release or news event, count them as one pick and keep the one with more technical detail. Pick at most one post per blog.

Then pick the {n} highest-scoring posts, best first, breaking ties toward the less famous blog.

Return ONLY valid JSON of this shape: {"picked": ["<url>", ...]}`,
  },
];

/** Summary prompt variants. The user message is `Title: ...\n\nTEXT:\n...` as in production. */
export const SUMMARY_VARIANTS: PromptVariant[] = [
  {
    id: "summary-baseline",
    note: "Shipped prompt.",
    text: PROMPT,
  },
  {
    id: "summary-tight",
    note: "Same shape, tighter rules on grounding, jargon, and difficulty calibration.",
    text: `You summarize engineering blog posts for a backend-leaning generalist developer who understands the basics but is new to advanced topics.

Return ONLY valid JSON matching this shape:
{"tldr": "...", "key_points": ["..."], "jargon": [{"term": "...", "explanation": "..."}], "difficulty": "beginner|intermediate|advanced"}

Rules:
- tldr: 2-4 sentences. Start with the concrete thing the post does or found, never "This post" or "The author". Include the single most important number or result when the post has one.
- key_points: 3-6 takeaways. Each must stand alone, name the mechanism or decision, and carry its cost or tradeoff. Prefer names, numbers, and failure modes over generalities.
- jargon: 0-5 terms a generalist engineer likely does not know, each explained in 1-2 sentences, optionally with an analogy. Only terms that appear in the post. Skip general programming terms.
- difficulty: beginner if a mid-level engineer can follow it without prior domain knowledge, intermediate if it needs one domain, advanced if it needs deep specialisation.
- Use ONLY the post text. Every number must appear in the post. Never invent facts, benchmarks, or quotes.`,
  },
  {
    id: "summary-minimal",
    note: "Shortest prompt; tests whether the long rule list is scaffolding the model does not need.",
    text: `Summarize this engineering blog post for a generalist developer learning advanced topics.

Return ONLY JSON: {"tldr": "2-4 sentences", "key_points": ["3-6 concrete takeaways"], "jargon": [{"term": "...", "explanation": "1-2 sentences"}], "difficulty": "beginner|intermediate|advanced"}

Ground every claim in the text. Explain terms a generalist would not know. No filler.`,
  },
];
