# Product

## Register

brand

## Users

Data hobbyists and climate-curious tinkerers. They land here because they want to scrub a date and a city and see, with their own eyes, where today sits inside a century of weather. Context is usually a desktop browser or phone, opened from a link a friend shared. They are comfortable reading a chart; they expect to learn something by playing.

The job to be done: "show me where today's temperature falls in the historical record for this place, in a way I can keep poking at."

The feeling on first paint: exploratory delight. Quietly impressive. Worth screenshotting.

## Product Purpose

How Hot Was It is a one-page historical weather explorer. Pick a place, pick a date, and the interface plots that day's reading against every year on record for the same place. Success looks like: a visitor stays past the first chart, changes the date, changes the city, and forwards the URL to one other person.

It is not a forecast tool, not a climate-policy site, not a dashboard. It is a single artifact that happens to be interactive.

## Brand Personality

Scientific. Precise. Archival.

Voice: present-tense, restrained, no marketing adjectives. Numbers and units do the talking. Labels read like a chart in a research paper, not like a product surface. No exclamation. No "explore your data!" copy.

Emotional goal: the calm authority of an instrument, with just enough warmth that scrubbing the controls feels rewarding rather than clinical.

## Anti-references

- **Crypto/AI neon-on-dark.** No glowing accents on near-black. No "futuristic" gradients.
- **Weather-app cliche.** No sun/cloud iconography. No giant animated temperature numerals. No saturated blue weather-gradient.
- **Corporate climate-report.** No stock photography. No navy-and-teal infographic palette. No "global warming hero stat" template.
- **Generic SaaS dashboard.** No equal-sized card grids. No Inter + blue + soft-shadow defaults.

## Design Principles

1. **The chart is the page.** Chrome serves the chart. If a control, label, or panel competes with the data, it loses.
2. **Instrument, not interface.** Controls should feel like turning a dial on a piece of measuring equipment: immediate, precise, no confirmation needed. The auto-fetch on date/location change already commits to this.
3. **Tufte over Stripe.** Borrow from scientific print, not from SaaS. Thin rules, generous margin, restrained palette, typographic hierarchy over boxes and shadows.
4. **Numbers are typography.** Tabular figures, careful units, mono for readouts. A temperature is a designed object on this page, not a label.
5. **Earn every pixel of color.** Color encodes data (hot/cold, this-year/historical), never decoration. One restrained palette across UI, chart, and readouts — no separate "brand color" sitting on top.

## Accessibility & Inclusion

Target WCAG AA. Honor `prefers-reduced-motion` for any chart entry animation or transition. Do not encode meaning with color alone — pair every hot/cold hue with position, shape, or label so the chart still reads for colorblind users. Body copy stays at body-line-length (≤75ch); chart labels and numeric readouts use tabular-figure fonts so columns of numbers line up.
