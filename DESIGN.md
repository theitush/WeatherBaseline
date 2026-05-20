# Design

Visual system for How Hot Was It. Register is `brand` (see PRODUCT.md). Reference lane: scientific print (Tufte). All tokens live in `frontend/src/index.css` as CSS custom properties — that file is the source of truth; this document explains the why.

## Theme

Light by default; dark via `prefers-color-scheme`. The physical scene: a curious reader on a phone or laptop, daylight or warm desk lamp, comparing today's temperature to a century of data. Paper-on-screen, not glowing-on-dark. No theme toggle is offered — the OS preference decides.

## Color

Strategy: **Restrained, plus one committed accent.** The accent (`--hot`) is also the data signal for heat, so it earns its weight twice. Cold gets a matching slate. Everything else is tinted neutrals.

| Token | Light | Role |
|---|---|---|
| `--paper` | `oklch(96.5% 0.012 70)` | Page background. Warm off-white, never `#fff`. |
| `--paper-deep` | `oklch(93% 0.015 70)` | Hover/selected surfaces, suggestion list highlight. |
| `--ink` | `oklch(22% 0.015 60)` | Primary text. Warm near-black, never `#000`. |
| `--ink-mute` | `oklch(45% 0.012 60)` | Secondary text, axis labels, eyebrow labels. |
| `--ink-soft` | `oklch(60% 0.01 60)` | Tertiary; rarely used. |
| `--rule` | `oklch(85% 0.012 70)` | Hairline rules between sections. |
| `--rule-strong` | `oklch(70% 0.014 70)` | Input baselines, button frames. |
| `--hot` | `oklch(55% 0.16 35)` | Heat signal. Also the readout colour and focus ring. |
| `--cold` | `oklch(50% 0.09 240)` | Cold signal. Slate blue, not weather-app blue. |
| `--mark` | `oklch(28% 0.025 50)` | Target-date marker. Warm dark, distinct from `--ink`. |
| `--focus` | `oklch(55% 0.16 35)` | Single focus ring across the whole app. Same as `--hot`. |

Dark mode lifts lightness and bumps chroma slightly on the hot/cold pair so they survive on the dark paper. Tokens are listed in `index.css` under the `prefers-color-scheme: dark` block.

**Chart palette** lives in `frontend/src/utils/config.ts` as hex (d3 needs hex). Keep it in sync with `--hot` / `--cold`: max temperature uses the OKLCH-derived oxide red, min temperature uses the slate blue. Don't reintroduce the old `#FF8C42` / `#4A90E2` — they read as SaaS-default and weather-app-cliche respectively (see PRODUCT.md anti-references).

Never use color alone to encode meaning; the chart already pairs hue with position and the target-date marker pairs colour with shape.

## Typography

| Family | Source | Use |
|---|---|---|
| Spectral | Google Fonts | Headings, chart titles, the readout description sentence. Italic 500 by default for the masthead. |
| Geist | Google Fonts | UI text, body copy. |
| Geist Mono | Google Fonts | All numeric readouts, axis labels, eyebrow labels, button text on small controls. `font-variant-numeric: tabular-nums`. |

None of these are on the impeccable reflex-reject list. Don't swap to Inter, IBM Plex, Newsreader, Fraunces, Cormorant, or any other entry in the list in `.agents/skills/impeccable/reference/brand.md`.

Scale uses ≥1.25 between steps. Tokens in `index.css`:

| Token | Size | Use |
|---|---|---|
| `--step--1` | 13px | Mono labels, fine print, tooltip body. |
| `--step-0` | 15px | Body, inputs. |
| `--step-1` | 18px | Sub-headings. |
| `--step-2` | 24px | Chart title, readout description. |
| `--step-3` | 32px | Section heading (reserved). |
| `--step-4` | `clamp(2.5rem, 6vw, 4.25rem)` | Masthead. |

Tabular figures are enforced via `.num`, `code`, and `.mono` utility classes plus direct `font-variant-numeric: tabular-nums` on inputs and readouts. Numbers should always line up vertically.

## Layout

- **Page width:** `max-width: 72rem` (1152px), generous side padding via `clamp()`.
- **No cards.** Sections are separated by hairline rules (`--rule`) rather than padded boxes with shadows. The masthead is bounded below by a single 1px `--ink` rule.
- **Asymmetric:** left-aligned masthead with a small uppercase mono eyebrow on the right baseline. Controls live in a single horizontal strip between two hairline rules.
- **Spacing rhythm:** vary deliberately. `2.5rem` between major sections, `1rem` inside groups, `0.25rem` between a label and its input. Same padding everywhere is monotony.

## Components

### Inputs (city, latitude, longitude, date)

Read as instrument readouts, not SaaS form fields:

- No box, no rounded corners. Just a 1px baseline rule (`--rule-strong`).
- Label sits above the input as an uppercase mono eyebrow at 0.6875rem with 0.1em letter-spacing.
- Focus: the baseline rule turns `--hot`. The shared `:focus-visible` ring (2px `--focus`) layers on top.
- Mono font for everything except `#city-search` (which can contain non-numeric city names).

### Metric selector

Segmented control with hairline border, no rounded corners. Active button is `--ink` background with `--paper` text — high contrast, no colour-bleed from the data palette. Buttons are mono uppercase 0.75rem.

### Temperature readout

The hero of the page. Two-column grid: oversize mono temperature on the left (clamp 2.75rem → 4rem), italic Spectral description sentence on the right, mono uppercase percentile and ranking lines stacked below the description. The number is `--hot`. No card around it — top and bottom hairlines frame it as a print-style pull quote.

Collapses to a single column at ≤480px.

### Charts

CSS in `MainChart.css` / `HistogramChart.css` styles the axes and tooltip; data marks are styled in d3 inline (`MainChart.tsx`, `HistogramChart.tsx`). Axis text uses Geist Mono at 10px with `--ink-mute`. Tooltip is paper-on-paper with a hairline border, no rounded corners, no dark fill.

There is still hard-coded `#555` / `#333` / `#666` inside the d3 code in the chart files — a follow-up pass should swap those for `var(--ink-mute)` / `var(--ink)` / `var(--rule-strong)` so the charts pick up dark mode properly.

### Loading overlay

Backdrop is `color-mix(in oklch, var(--paper) 88%, transparent)` with a 2px blur. A 32px hairline ring with a `--hot` arc rotates at 900ms ease-in-out. Label is mono uppercase 0.6875rem: "Reading the record" — instrument voice, not "Loading…". Honors `prefers-reduced-motion` (ring stops, arc remains visible).

## Motion

- Transitions ease out with `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quint). No bounce, no elastic.
- Default duration: 140–200ms for state changes, 200ms for the loading-overlay fade-in.
- No animation on layout properties.
- `prefers-reduced-motion` zeroes all transitions/animations (`*` rule in `index.css`).

## Iconography

There are no icons currently. If one becomes necessary, draw it as a thin-stroke 1.5px SVG line — instrument register, not Lucide-default. No emoji. No sun/cloud weather pictograms (see PRODUCT.md anti-references).

## What this is NOT

- Not Stripe-minimal cards on cream. Not navy-and-gold finance. Not neon-on-dark. Not editorial-typographic (display serif + italic kicker + mono labels + rules) — we lean *typographic* but not into that saturated lane.
- Not a SaaS dashboard. There is one accent color, applied where it earns meaning (heat), and a hairline grid. If a future feature wants a coloured pill or a soft-shadow card, push back: the answer is almost always "use the rule and the mono label."
