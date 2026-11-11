# LANDING-REDESIGN-20261111 — multi-exam front door with honest availability

Execution `LANDING-REDESIGN-20261111-A`, base `0d71231` (main, after PR #185), branch
`codex/landing-redesign-20261111`.

## Why

The preserved working tree carried an uncommitted landing-page redesign that added an exam
catalogue (Deutsch B1/B2, English B1–B2, TOEFL/IELTS). It was a product-direction page with a
truthfulness problem: `server/preparation-contract.mjs:20` still defines
`ENABLED_EXAM_IDS = ['telc-deutsch-b1']`, and the DTZ package ships no listening content and no
complete timed form. The draft also *removed* the honest line "Der Pilot startet mit telc Deutsch
B1" in favour of a promise to switch between German and English in the account, and its metadata was
73 characters of title and 344 of description against the repo's recorded 25–160 rule.

## What this slice does

1. **Keeps the redesign** — hero, offer tiles and the new exam catalogue are landed as designed.
2. **Marks availability.** Every card states its status: `Jetzt verfügbar` (telc Deutsch B1) or
   `In Vorbereitung` (all others). The catalogue heading/intro now say the pilot starts with telc
   Deutsch B1 and the other exams are not yet selectable in the account.
3. **Moves the planned B1 exams** (DTZ, Goethe B1) out of the "available" card into the
   in-preparation card, so the green marker is true for exactly the exams it lists.
4. **Restores the truthful framing** in hero, offer section and FAQ: German only, telc B1, and
   "offizielle telc-Aufgaben" / telc independence. The `du`-free German register is unchanged.
5. **Fixes the metadata**: title 73 → 50 characters, description 344 → 144 (German), image alts
   exam-neutral (the capture is a telc sample), and the telc overview description 182 → 134.
6. **Adds seo-check leg S13** — every public page with a canonical must keep title 15–70 and
   description 25–160 characters. The old metadata would have failed it.

Five locales (`de/en/uk/ar/tr`) are updated in `public/assets/i18n/public-messages.js`; inline German
defaults match the catalogue (i18n-register-check R2).

## Not in this slice

- The DTZ overview page (`public/dtz-a2-b1.html`) stays unpublished and unlinked; `/dtz-a2-b1`
  remains a 404 until the exam is selectable (task `task-1` covers enablement).
- No server, content, schema or catalogue-enablement change.
- The parked DTZ copy corrections are not committed here.

## Evidence

- Nine AGENTS.md baseline commands pass on the branch snapshot: repository-check (867 files),
  design-check, retired-surface-check, seo-check **13/13** (S13 included), server-origin-check,
  keymask-check, owned-api-check (35/35 memory), owned-client-check (32/32), i18n-register-check
  (0 findings).
- Served page: `/` 200, canonical `https://hatoove.com/`, `Jetzt verfügbar` and `In Vorbereitung`
  present, no `/dtz-a2-b1` link, sitemap still exactly two URLs.
- Rendered evidence, true viewports over CDP: `.qa/landing-redesign-20261111/desktop-1440-real.png`
  and `mobile-390-real.png`; layout metrics `innerWidth 390 / scrollWidth 390` and
  `1440 / 1440` — no horizontal overflow.
- Local `.qa/` evidence is deliberately not committed.

## Risks / open

- Physical iPhone/Android checks and native translation review remain outstanding, as for every UI
  slice in this repository; the five translations were authored here and need qualified review.
- The page still lists planned exams; the honest signal is the per-card marker, and it must move to
  "available" only when the catalogue actually enables each exam.
- Main auto-deploys on merge; merge and deployment need Ron's explicit approval.
