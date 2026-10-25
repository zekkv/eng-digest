# Design: eng-digest

The page looks like a marked proof of the day's engineering reading. The ground is cool paper and the text is graphite ink. Margin numbers use editor blue. One tier uses pencil red.

## Overview

The pipeline reads each post and marks it. Numbered notes sit in the prose. Terms are circled. The day's picks receive visual weight. The jargon glossary is the center of the page, because no RSS reader provides it.

- **One decision:** numbered editor marks. A jargon term that the summarizer returned receives a superscript number at its first use in the tldr and in the key points. The glossary is a numbered note rail beside the prose on wide screens. On phones it is a notes section. The numbers follow the glossary order. They carry meaning and are not decoration.
- **Restraint elsewhere:** flat paper grounds, ink rules, and one tally line. Pencil red appears only on the "advanced" tier and on feed failures.
- **Audience:** one generalist software engineer who learns advanced topics. The page has one task. It lets the reader scan today's picks and absorb the best ones quickly, often on a phone.

## Colors

The ground is cool paper, never cream. Light is the default theme. The dark theme uses a graphite ground with paper text and a lighter blue, so marks stay legible.

- **Proof (#0F1418):** ink for headlines, the active row rule, and primary text.
- **Paper (#F1F3F4):** ground for the page, the sheet, and popovers.
- **Soft (#5C646E):** muted text for bylines, previews, and provenance.
- **Editor (#1B4AC4):** marks only: note numbers, term chips, key-point arrows, and selection.
- **Wash (#E7ECF7):** note ground for the active row and row hovers, and nothing else.
- **Pencil (#AE3A24):** for the "advanced" tier and feed failures.

In the dark theme: proof is #EDEFF1, paper is #141A1F, soft is #9AA3AD, editor is #8FABFF, wash is #1E2A4A, and pencil is #DE8266.

Text contrast stays at or above 4.5:1 in both themes. This includes small muted text.

## Typography

Three voices, each with one task. `--font-sans` is the body face, so prose needs no class. `font-heading` and `font-notes` mark the other two roles.

- **Display:** Zilla Slab, 600, for headlines, the wordmark, and section titles. It has a typed-report voice. Use it with restraint, never for body copy.
- **Body:** Literata Variable for the tldr (18px), key points (16px), and all prose. It suits screen reading. The line length never exceeds about 65ch.
- **Notes/utility:** Recursive Variable, CASL subset, for note numbers, term chips, bylines, the tally, and provenance. It contrasts with the slab voice. IBM Plex Mono is the fallback. It is the only face for code and model strings.

## Layout

Picks come first. The page opens on "Today's picks (N)" with an exact tally ("N picked of M scanned") and a Today | All segmented control. The 200-row scan list is a collapsed "scanned, not picked" tier one click away. It is never the primary structure.

- **Desktop:** the scan list and the reading surface scroll independently
  (`h-[calc(100dvh-17rem)]`, each `overflow-y-auto`). The reading surface is one column of about
  65ch with a narrow numbered note rail at `xl`.
- **Phone:** rows accept taps and show term chips. The detail is an edge-to-edge bottom sheet.
  Previous and Next step through the visible list.
- **Active row:** an ink left rule, a wash ground, and a semibold title. It never uses a tint alone.

## Do and Do Not

- Do mark only terms that the summarizer returned. Mark only their first occurrence. Never mark inside code.
- Do use pencil red only for the "advanced" tier and feed failures. Do not invent new accent uses.
- Do keep prose at about 65ch with 16–18px body. Do not set key points smaller than the intro.
- Do keep text contrast at or above 4.5:1 in both themes.
- Do render read time only from `summary.words`, which keeps the count honest. Never use the feed teaser.
- Do keep the feeds indicator silent when all feeds work. Show a destructive chip only on failure.
- Do keep motion out. The loading-text shimmer is the one exception. It is a token gradient sweep
  that freezes under reduced motion. Do not add reveals, charts, or ops frames.
- Do put new treatments in feature-local digest components. Do not restyle `src/components/ui/*`
  at call sites. Use token classes and layout classes only.

## Lint rules

`@shadcn/lint` enforces this system through six Oxlint rules. Each rule reports the approved fix, and `settings.shadcn.note` in `.oxlintrc.json` points back to this file.

| Rule                            | Enforces                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `shadcn/no-restyle`             | Components own their appearance. Call sites pass only `layout` classes. The `Skeleton` contract also allows `rounded-full`. |
| `shadcn/no-raw-colors`          | Use theme tokens instead of raw palette classes such as `bg-pink-500`.                                                      |
| `shadcn/no-arbitrary-values`    | Use the theme scale instead of one-off values such as `p-[13px]`. `layout` values are exempt.                               |
| `shadcn/no-inline-styles`       | Do not use `style={}` props or `<style>` elements. Keep styling in Tailwind classes.                                        |
| `shadcn/no-unknown-classes`     | Use only classes that the project's Tailwind setup can generate.                                                            |
| `shadcn/require-static-classes` | Write class strings that the linter can read. Do not build class names such as `` `bg-${color}` ``.                         |

The `overrides` array of `.oxlintrc.json` holds the approved exceptions. `src/components/ui/**` has
its own block. Those files are upstream shadcn components, and this design system does not own them.
Individual upstream components allowlist or disable `no-unknown-classes` and `no-inline-styles`
where static analysis cannot read their internals.
