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
73 characters of title and 344 of description against the 25–160 description bound the repo records.

## What this slice does

1. **Keeps the redesign** — hero, offer tiles and the new exam catalogue are landed as designed.
2. **Marks availability.** The available card says `Jetzt verfügbar` and lists telc Deutsch B1 only.
   Every other card says `Geplant` — not "in preparation", because only DTZ has a package artifact
   (internal, no listening, no complete timed form) and the other nine have no artifact at all; the
   repo cannot evidence preparation work for them. The section intro says the pilot starts with telc
   Deutsch B1 and the others are planned and not yet selectable in the account.
3. **Moves DTZ and Goethe B1** out of the available card into the planned card, which now spans
   `Deutsch A2–B2`, so the green marker is true for exactly the exams it lists.
4. **Restores the truthful framing** in hero, offer section and FAQ: German only, telc B1, and
   "offizielle telc-Aufgaben" / telc independence. The `du`-free German register is unchanged.
5. **Fixes the metadata**: title 73 → 50 characters, description 344 → 144 (German), image alts
   exam-neutral (the capture is a telc sample), and the telc overview description 182 → 137.
6. **Adds seo-check legs**:
   - **S13** — every public `*.html` carrying a canonical, and every locale in the catalogue
     (`site.js` rewrites title/description from it), must keep title 15–70 and description 25–160;
     the German catalogue value must equal the static page. Derived from the tree, so the drafted
     DTZ page would be covered the day it is published.
   - **S14** — the card marked `Jetzt verfügbar` must list exactly `ENABLED_EXAM_IDS`, so enabling
     an exam or marking a card available for an unselectable exam both fail the check.

Five locales (`de/en/uk/ar/tr`) are updated in `public/assets/i18n/public-messages.js`; inline German
defaults match the catalogue (i18n-register-check R2). Review fixes included an Ukrainian pronoun
correction (`її`, not `їх`), a missing `.chips` flex/gap rule, the `DE·EN` hero badge returned to
`DE` while English is unavailable, and English copy using the official exam name `telc Deutsch B1`.

## Not in this slice

- The DTZ overview page (`public/dtz-a2-b1.html`) stays unpublished and unlinked; `/dtz-a2-b1`
  remains a 404 until the exam is selectable (task `task-1` covers enablement).
- No server, content, schema or catalogue-enablement change.
- The parked DTZ copy corrections are not committed here.

## Open dependency

PR **#179** (`codex/seo-meta-20261021`) is still open and touches the same four files with a
description-length check. This slice supersedes it: S13 covers titles, descriptions, all locales and
all canonical public pages; #179's German-catalogue match is part of S13. Recommend closing #179 as
superseded once this lands, or landing #179 first and rebasing if it is preferred.

## Evidence

- Nine AGENTS.md baseline commands pass on the branch snapshot: repository-check (868 files),
  design-check, retired-surface-check, seo-check **14/14** (S13 and S14 included), server-origin-check,
  keymask-check, owned-api-check (35/35 memory), owned-client-check (32/32), i18n-register-check
  (0 findings).
- Served page: `/` 200, canonical `https://hatoove.com/`, `Jetzt verfügbar` and `Geplant` present,
  no `/dtz-a2-b1` link, sitemap still exactly two URLs.
- Rendered evidence, true viewports over CDP: `.qa/landing-redesign-20261111/desktop-1440-real.png`
  and `mobile-390-real.png`; layout metrics `innerWidth 390 / scrollWidth 390` and
  `1440 / 1440` — no horizontal overflow. Re-rendered after the `.chips` fix at 320/390/1101/1440.
- Local `.qa/` evidence is deliberately not committed.

## Risks / open

- Physical iPhone/Android checks and native translation review remain outstanding, as for every UI
  slice in this repository; the five translations were authored here and need qualified review.
- The page still lists planned exams under a `Geplant` marker; it must move to available only when
  S14's enabled set actually contains them.
- Main auto-deploys on merge; merge and deployment need Ron's explicit approval.
