# Design reference screens — READ THE WARNING BEFORE USING ANYTHING HERE

These 15 files are the supplied Hatoove design, copied from `D:\Hatoover\design` so that a worker on
another host does not need a Windows drive letter. They are **reference material for the design
language**, not a specification of the product.

Every byte is pinned in [`DESIGN-REFERENCE-MANIFEST.json`](../implementation/DESIGN-REFERENCE-MANIFEST.json)
and verified by `node tools/design-assets-check.mjs` (leg D5).

> **Nothing in this folder is a requirement.** The mockups were drawn before the first-release scope
> was settled, and several of them assert product behaviour that has since been **decided against**.
> Copying a screen's wording, controls or numbers into the product would import a removed feature, a
> fixture dressed as data, or a claim we are not allowed to make.

## What is usable here, and what is not

**Usable, and meant to be followed:** the visual language. Warm paper, one orange accent, Bricolage
Grotesque headings, Source Sans body, the card and radius system, the desktop sidebar, the mobile
navigation, light/dark behaviour. The tokens for all of that are curated and shipped in
[`public/assets/design/hatoove.css`](../../public/assets/design/hatoove.css).

**Not usable: the screens' product claims.** Each of these is contradicted by a recorded decision:

| The mockup shows | The recorded decision |
|---|---|
| `login.html` — "Magic link and Google" | Email/password **with an invite code**. No Google and no magic-link button (`MFP-DESIGN-DECISIONS.md` R14). Not merely deferred — not to be built |
| `dashboard.html` — "readiness vs pass line", today's plan | **No** readiness score, pass prediction or study plan. Facts from saved records only |
| `progress.html` — "Estimate over time", "mock history" | A **factual** per-criterion history. No averages presented as a score, no forecast |
| `onboarding.html` — "daily time" | The daily-time setting is **removed** (`MFP-DESIGN-DECISIONS.md` R16), not renamed |
| `review.html` — "Spaced review queue and weak topics" | The adaptive engine and SRS were **dropped**: their items are client-generated, so the server cannot mark them. Keeping them forces forgeable progress |
| `plan.html` — "Week calendar to the exam date" | No study plan in the first release. The exam date is a countdown, not a schedule |
| `upgrade.html` — "Exam Sprint purchase, Einführungspreis, withdrawal consent" | **No checkout in the pilot.** Invite-only with a configured allowance. Prices and promotional dates need real contracts; do not invent terms |
| `listening.html` — "Play-once audio, true/false" | **0 tracked audio files.** Listening is blocked on gate C-04, and browser speech synthesis is explicitly **not** a substitute for a listening assessment (`IMPLEMENTATION_PLAN.md:227`) |
| `index.html` — "Design reference for the React app" | Reference copy, not a decision. The client is small vanilla ES modules under `public/app/`; no framework migration is implied |
| `writing.html` — "criteria bands" | The rubric contract is **open** (R11). Four internal criteria (15/10/12/8) must never be relabelled as telc's three |
| Sample names, dates, totals, streaks, quotas, charts | Fixtures. Never production defaults |

The full screen-to-runtime mapping, including the states each screen is missing, is in
[`DESIGN-WIRE-01.md`](../implementation/DESIGN-WIRE-01.md) and
[`MFP-DESIGN-DECISIONS.md`](../implementation/MFP-DESIGN-DECISIONS.md). Those two records govern how a
mockup is interpreted; this folder is only the pixels.

## Also relevant

- The design is **English**. Shipping chrome is German; only the explanation layer changes with the
  learner's language, and exam material never does.
- The mockups use **inline presentational styles** (112 inline style attributes across the 14
  screens, per `MFP-DESIGN-DECISIONS.md`). They are not to be copied into the client; the tokens are.
- Arabic needs scoped `dir="rtl"` with bidi isolation around German examples, **not** a reversed
  shell. No screen here demonstrates that; the app has never rendered right-to-left text.
- `build.py` is deliberately **not** imported. Do not run the design's builder.
