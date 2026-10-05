# REDESIGN-01 G1 — landing-page graphic: wide candidate and narrow (mobile) variant (revision 3)

**Status: LANDED by the Lead (2026-10-05, commits `c31d08d`, `adabb59`, `fc98e3e`).** This document was written as a
proposal and is kept as the measurement record; the outcome differs from it in three places, all recorded here so
the document is not read as current state:

- **Shipped paths** are `public/assets/landing-item.svg` (wide) and `public/assets/landing-item-narrow.svg` (narrow),
  not the `.qa/` candidate paths named below. Four rasters (`orange-path-*`, 1.63 MB) were deleted.
- **The breakpoint is 1199 px, not 900 px** (§15 recommended 1199; §14 item 3 still says 900 — §15 supersedes it).
  Verified in `tools/app-browser-check.mjs` legs L1d/L1d2, which assert the crop each width is *served*.
- **The alt text in §8 was inverted** (it described a reading item with answer A green; the artwork is a
  Sprachbausteine item with A red and B green). The shipped strings in `publicMessages.artAlt` are the corrected
  ones. §15.7 also records that an SVG loaded through `<img>` may not load its own `@font-face`, so the artwork
  renders in the visitor's system face; §15.7(b) is therefore the behaviour, not §15.7(a).

No tracked file was touched by the teammates who wrote this. Everything below is their record, unedited.

**Revision 3 (task-3, 2026-10-05):** adds the narrow / mobile variant `.qa/redesign-01/landing-graphic-narrow.svg`, render-based on-screen measurements at 360/420/550/630 px slots, the SVG-in-`<img>` font finding, the real slot-width map and the exact markup for the Lead — see §15. The wide candidate is byte-identical to revision 2 (sha256 `770F1FC9…6F22`). §§1–14 are the revision 2 record and stand, except where §15 supersedes them: §12.3 (mobile slot width), §14 item 3 (front-door markup) and §8 (alt strings).
Owner: `landing-graphic` teammate (shared task `task-1`, reopened after Lead review). Date: 2026-10-05. Base: working tree of `D:\Hatoove`.
Revision 2 responds to the Lead's review: the first candidate was a whole practice card (1448×1086, 29 text nodes) whose 28 px text landed at ~11 px in the real slot. This revision is a single-question crop on a 3:2 canvas with a type scale chosen for the rendered size, plus a rasterised social card.
Replaceable asset under discussion: `public/assets/orange-path-1400.jpg` (+ `orange-path-900.webp`, `orange-path-1400.webp`, `orange-path.png`), used once in [public/index.html](../public/index.html#L87) inside `.approach-art`.

## 1. Deliverables

| Artifact | Path | Tracked | Notes |
| --- | --- | --- | --- |
| This proposal | [`work/implementation/REDESIGN-01-LANDING-GRAPHIC.md`](REDESIGN-01-LANDING-GRAPHIC.md) | yes (to commit) | |
| Candidate SVG — one file, one source of truth | `.qa/redesign-01/landing-graphic.svg` | no — `.qa/` is gitignored (`.gitignore:5`) | 8 231 bytes, 35 elements, 12 text nodes, sha256 `770F1FC98F46A18693DF98C155EE99AC7ADAF8A74299CAD3F6909FA0FEEF6F22`, canvas 960×640 (3:2) |
| Page render (native 960×640) | `.qa/redesign-01/landing-graphic.png` | no | the in-page viewBox, Chromium, deviceScaleFactor 1 |
| Page render at the real slot width, 550 px | `.qa/redesign-01/landing-graphic-page-slot-550w.png` | no | 550×367, pixel-exact crop of a 550 px render (no resampling) |
| Page render at the widest expected slot, 630 px | `.qa/redesign-01/landing-graphic-page-slot-630w.png` | no | 630×420, same method |
| **Rasterised social card** | `.qa/redesign-01/og-card-candidate.png` | no | **exactly 1200×630**, 69 788 bytes — the file `public/assets/og-card.png` contract expects. Re-read in revision 3: still 1200×630 (IHDR), sha256 `7C1B3883463BC5ECF43ECDB93E246D5A26AF19FD036A0526211083DD739059EA`, unchanged |
| **Narrow / mobile variant (revision 3)** | `.qa/redesign-01/landing-graphic-narrow.svg` | no | 9 223 bytes, 33 elements, 12 text nodes, sha256 `54BAEDCA1C28896868742AB8F22C13F7FB20911787C4FC55450CDF7006D7E9B7`, canvas 720×480 (3:2 — the same ratio as the wide file, so one `<picture>` can swap them without a layout shift) — §15 |
| Slot renders, native render and harnesses (revision 3) | `.qa/redesign-01/landing-graphic-narrow-*.png`, `.qa/redesign-01/landing-graphic-narrow-{slots,measure,render}.html`, `.qa/redesign-01/landing-graphic-fontprobe.html`, `.qa/redesign-01/landing-graphic-rev3-checks.mjs` | no | Evidence only, not landing assets — §15.5 and §15.10 |

Two renders, one artwork: the in-page `<img>` uses `viewBox="0 0 960 640"`; the social card uses `viewBox="0 48 960 504"` (1.9048:1) of the same file.

## 2. Why the current graphic does not work

* **It says "up", not "Hatoove".** `.approach-art` shows an orange paper strip folded into rising steps with the caption `DEIN NÄCHSTER SCHRITT.` and alt text "Ein orangefarbener Weg aus Papier führt in kleinen Stufen nach oben." Nothing names an exam, German, a task, an answer, feedback or a language. It would fit any learning, fitness or savings app unchanged.
* **It is redundant where it stands.** The same section already renders a numbered how-it-works list (`01`/`02`/`03`). The steps metaphor is carried by that list; the picture repeats it.
* **It leaves the actual promise unpictured.** The page states it twice — `public.understand` = "Verstehen, warum eine Antwort passt." and `public.sampleTitle` = "Eine Aufgabe. Ein Aha." — and has a working practice preview two sections above (`#practice`). The one large image shows none of it.
* **Its visual vocabulary risks a claim the pilot does not make.** Rising steps read as progress/streaks/readiness, which AGENTS.md forbids.
* **It cannot follow the design system.** Photographic orange rather than `--orange`; a raster with three derivatives (JPEG 1400×1050, two webp, PNG 1448×1086 = 1.48 MB in the deploy).

## 3. Directions considered

| # | Direction | Verdict |
| --- | --- | --- |
| A | **"Ein Item, verstanden"** — one telc B1 item with the learner's wrong pick red, the right pick green, and the explanation in the learner's own interface language beside it | **Picked.** It pictures the exact promise using content that already ships on this page, and it is unmistakably an exam item rather than general progress. Revision 2 zooms into *one question* instead of the whole card so the type can be large. |
| B | "Fünf Schnittstellensprachen" — the language selector as the hero | Rejected. It sells a settings surface; the language choice is already visible in the header `<select>`. It survives as the explanation's label `AUF UKRAINISCH`. |
| C | "Was du heute üben kannst" — four area tiles mirroring `#angebot` | Rejected. It duplicates the section directly below, and one tile would have to say "Noch in Vorbereitung", a weak note for the page's largest image. |

## 4. Exact synthetic content shown (and its source)

Every string is published in the repository except the short German chrome labels. No score, no percentage, no readiness, no pass prediction, no streak, no testimonial, no price. Revision 2 uses the **Sprachbausteine (grammar) sample**, whose options are single words — that is what makes a legible one-question crop possible.

| Element in the SVG | Exact string in the art | Source in repo |
| --- | --- | --- |
| Exam label (card top left) | `TELC DEUTSCH B1` | composed from `public.pilot`, [public-messages.js](../public/assets/i18n/public-messages.js) |
| Provenance chip (card top right) | `EIGENES ÜBUNGSBEISPIEL` | new German art chrome, short form of `public.sampleNote` ("Eigenes Übungsbeispiel, keine offizielle telc-Aufgabe.") |
| The task, line 1 | `Das ist der Kollege, mit` | `bank.grammar[0].text` = "Das ist der Kollege, mit ___ ich das Projekt vorbereite.", [public/site.js](../public/site.js#L51), split across two lines for width |
| The gap | orange bottom rule (`.gap` token style, no fill) | the `___` in the same published sentence; the live page renders it as underscores |
| The task, line 2 | `ich das Projekt vorbereite.` | same string, rest of the sentence |
| Option A — the learner's pick | `den` | `bank.grammar[0].options[0]` (verbatim, one word) |
| Option B — the right answer | `dem` | `bank.grammar[0].options[1]` (verbatim); keyed answer is `index 1`, so green is not invented |
| Marks | `DEINE ANTWORT`, `RICHTIG` | new German art chrome (the two words the graphic needs to be non-colour-coded) |
| Explanation island | `«Mit» вимагає давального відмінка.` | first sentence of `grammar0Explanation`[uk], [public-messages.js](../public/assets/i18n/public-messages.js#L121) (verbatim) |
| Panel label | `ERKLÄRUNG · AUF UKRAINISCH` | new German art chrome |

Deliberately **not** in the artwork, all documented rather than faked: option C (`der`), the rest of the explanation ("…Відносний займенник стосується іменника чоловічого роду «der Kollege», тому потрібна форма «dem»."), the section name Sprachbausteine, the five interface-language pills, and the full "keine offizielle telc-Aufgabe" sentence. The provenance chip and the alt text carry the last point; the page's own `.sample-note` already states it in full next to the live sample.

## 5. Real tokens used (names and values read from the repo, not restyled)

Colour, radius and shadow tokens come from [design/assets/hatoove.css](../design/assets/hatoove.css#L6-L16) (`:root`, light theme); the font layer mirrors [public/assets/design/fonts-coverage.css](../public/assets/design/fonts-coverage.css#L20-L37).

| Token | Value | Where the SVG uses it |
| --- | --- | --- |
| `--peach` | `#fff0e7` | full-bleed backdrop, explanation panel |
| `--peach-line` | `#f3dccd` | panel edge, panel hairline |
| `--card` | `#fff` | practice card surface |
| `--canvas` | `#faf9f6` | provenance chip fill (`.chip`) |
| `--line` | `#e8e7e3` | card border, chip border |
| `--ink` | `#242320` | German task, option words, explanation body |
| `--muted` | `#62615c` | provenance chip text (`.chip` colour) |
| `--orange` | `#ff6b2b` | the answer gap rule (`.gap`), closing brand rule |
| `--orange-dark` | `#bd3c0a` | exam label (`.kicker`), panel label |
| `--green` / `--green-bg` | `#225b44` / `#e8f2ec` | right answer: tile border, letter badge, `RICHTIG`, check glyph |
| `--red` / `--red-bg` | `#a3271b` / `#fdecea` | learner's pick: tile border, letter badge, `DEINE ANTWORT`, cross glyph |
| `--display` | `"Bricolage Grotesque","Noto Sans",system-ui,sans-serif` | letter badges `A` / `B` |
| `--font` | `"Source Sans","Noto Sans",system-ui,sans-serif` | all other text |
| `--r` (12), `--r-xl` (24) | `12px / 24px` | letter badges, answer tiles, card |
| `--shadow` | `0 1px 2px #2423200a, 0 8px 24px #6c33100d` | `feDropShadow` pair with the same offsets, blur (stdDeviation 1 / 12) and alpha (3.9 % / 5.1 %) |
| `[lang=uk]` rule | `"Source Sans","Noto Sans",…` | the Ukrainian explanation; the SVG carries the Noto Cyrillic face itself, because Source Sans 3 and Bricolage Grotesque are Latin-1 subsets with **no Cyrillic** |

The SVG declares these as CSS custom properties in its own `<style>` and references them with `var(...)`; a standalone SVG cannot inherit the page stylesheet, so the tokens (and the script-coverage font layer) are re-declared inside the file. Maintenance cost noted in §13.

## 6. Type scale and measured on-screen size

Canvas 960×640 (3:2). `.approach-art` has no fixed size: it is a grid column, so the render width follows the viewport.

| Style | File px | Role | at 550 px slot | at 630 px slot | in the 1200×630 card (×1.25) |
| --- | --- | --- | --- | --- | --- |
| `.task` | 40 | the German sentence (the question) | **22.9 px** | 26.3 px | 50 px |
| `.opt` | 38 | `den` / `dem` | **21.8 px** | 24.9 px | 47.5 px |
| `.ex-body` | 36 | Ukrainian explanation | **20.6 px** | 23.6 px | 45 px |
| `.label`, `.chips`, `.mark`, `.ex-head` | 30 | exam label, provenance chip, `DEINE ANTWORT` / `RICHTIG`, panel label | **17.2 px** | 19.7 px | 37.5 px |

The smallest meaning-bearing style is therefore 17.2 px at a 550 px slot (bar was ~16 px) and 19.7 px at 630 px — verified by rendering, not by arithmetic alone (§9).

## 7. Measured contrast (WCAG 2.x, sRGB, computed not estimated)

| # | Pair (foreground on background) | Where | Ratio | Min | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | `--ink` `#242320` on `--card` `#fff` | German task (40 px), option words (38 px) | **15.72:1** | 4.5 | PASS (AAA) |
| 2 | `--muted` `#62615c` on `--canvas` `#faf9f6` | provenance chip text | **5.89:1** | 4.5 | PASS (AA) |
| 3 | `--orange-dark` `#bd3c0a` on `--card` `#fff` | exam label | **5.51:1** | 4.5 | PASS (AA) |
| 4 | `--ink` on `--green-bg` `#e8f2ec` | `dem` (right answer) | **13.73:1** | 4.5 | PASS (AAA) |
| 5 | `--ink` on `--red-bg` `#fdecea` | `den` (learner's pick) | **13.74:1** | 4.5 | PASS (AAA) |
| 6 | `--green` `#225b44` on `--green-bg` | `RICHTIG`, check glyph, tile border | **6.93:1** | 4.5 / 3 | PASS (AA) |
| 7 | `--red` `#a3271b` on `--red-bg` | `DEINE ANTWORT`, cross glyph, tile border | **6.41:1** | 4.5 / 3 | PASS (AA) |
| 8 | `#fff` on `--green` | badge letter `B` | **7.93:1** | 4.5 | PASS (AAA) |
| 9 | `#fff` on `--red` | badge letter `A` | **7.33:1** | 4.5 | PASS (AAA) |
| 10 | `--green` on `--card` / `--red` on `--card` | tile borders against the card | **7.93:1 / 7.33:1** | 3 | PASS |
| 11 | `--ink` on `--peach` `#fff0e7` | Ukrainian explanation | **14.12:1** | 4.5 | PASS (AAA) |
| 12 | `--orange-dark` on `--peach` | `ERKLÄRUNG · AUF UKRAINISCH` | **4.95:1** | 4.5 | PASS (AA) |

Decorative pairs, measured and explicitly exempted (no meaning rests on them): `--orange` on `--card` **2.84:1** (the answer gap rule — the sentence is still readable without it, and the gap is also the only place where the blank can be), `--orange` on `--peach` **2.55:1** (closing brand rule), `--line` on `--card` **1.24:1** (card border), `--peach-line` on `--peach` **1.18:1** (panel edge).

**Colour is never the only cue** (WCAG 1.4.1): the right answer carries the letter `B`, a check glyph and the word `RICHTIG`; the learner's pick carries the letter `A`, a cross glyph and the words `DEINE ANTWORT`. Remove all colour and the two states are still distinguishable.

## 8. Alt text in all five languages

For `public.artAlt` in [public/assets/i18n/public-messages.js](../public/assets/i18n/public-messages.js#L57) (same five-slot structure as today's entry, `de / en / uk / ar / tr`):

* **de** — `Übungsaufgabe Sprachbausteine: Im Satz „Das ist der Kollege, mit ___ ich das Projekt vorbereite“ ist die richtige Antwort B „dem“ grün markiert, die gewählte Antwort A „den“ rot. Daneben steht die Erklärung auf Ukrainisch: „Mit“ verlangt den Dativ.`
* **en** — `Language-elements practice item: in the sentence “Das ist der Kollege, mit ___ ich das Projekt vorbereite”, answer B “dem” is correct and marked green, the chosen answer A “den” is marked red. Next to it is the explanation in Ukrainian: “mit” takes the dative.`
* **uk** — `Завдання зі Sprachbausteine: у реченні «Das ist der Kollege, mit ___ ich das Projekt vorbereite» правильна відповідь B «dem» позначена зеленим, обрана відповідь A «den» — червоним. Поруч подано пояснення українською: «Mit» вимагає давального відмінка.`
* **ar** — `مهمة من قسم Sprachbausteine: في الجملة «Das ist der Kollege, mit ___ ich das Projekt vorbereite» الإجابة الصحيحة B «dem» مُعلَّمة باللون الأخضر، والإجابة المختارة A «den» مُعلَّمة باللون الأحمر. وبجانبها الشرح باللغة الأوكرانية: «Mit» تتطلب حالة Dativ.`
* **tr** — `Sprachbausteine alıştırma sorusu: “Das ist der Kollege, mit ___ ich das Projekt vorbereite” cümlesinde doğru yanıt B “dem” yeşil, seçilen yanıt A “den” kırmızı işaretli. Yanında Ukraynaca açıklama var: “mit” edatı Dativ gerektirir.`

These are written by an agent and are **not** human-reviewed translations; they need the repo's qualified review before they ship. The `de` string quotes the on-image Ukrainian text as a German translation so a screen-reader user is not left with an untranslated sentence; the other four do the same into their own language. The SVG itself carries the `de` string in `<title>`/`<desc>` for standalone viewing.

Proposed `og:image:alt` (de, shorter for a card): `Hatoove-Übungsaufgabe aus dem Sprachbausteine-Teil: Antwort B „dem“ grün markiert, die gewählte Antwort A „den“ rot, daneben die Erklärung auf Ukrainisch.`

## 9. Social crop and the rasterised PNG

* Crop = `viewBox="0 48 960 504"` of the same file → 960 × 504 = 1.9048:1 = **exactly 1200:630**.
* It contains the whole card except the card's bottom padding (a 20 px peach margin above the card's rounded top edge, the card cut at the frame bottom so it reads as a screenshot) and the closing orange rule. Every text node is inside the band, verified: the lowest text bottom is y=514 against a band bottom of 552.
* Only the exam label, the provenance chip, the task, both picks, both marks and the explanation appear — no extra content was invented for the larger render.
* **How `og-card-candidate.png` was produced:** the SVG was opened in Chromium, its root set to `viewBox="0 48 960 504" width="1200" height="630"` in a 1200×630 viewport with `deviceScaleFactor: 1`, and the screenshot saved directly. No resampling, no scaling: the PNG is a 1:1 rasterisation of the vector at 1200×630, verified on disk as 1200×630 (69 788 bytes).
* `og:image` today is [public/assets/og-card.png](../public/assets/og-card.png) (1200×630), and `tools/seo-check.mjs` S4 checks that the declared `og:image:width/height` match a file that exists in `public/`. `og-card-candidate.png` is the drop-in replacement for that path; social platforms do not render SVG.

## 10. Verification evidence (revision 2)

* **XML/standalone validity**: `System.Xml.XmlDocument` parses the file — XML OK, 35 elements, 12 `<text>` nodes; root `svg`, `viewBox="0 0 960 640"`, `role="img"` with `<title>`/`<desc>`.
* **Renders standalone in a browser**: `file:///D:/Hatoove/.qa/redesign-01/landing-graphic.svg` in Chromium; screenshots at native 960×640, at a 550 px slot (550×367) and at a 630 px slot (630×420) — all saved under `.qa/redesign-01/`, cropped 1:1 from `deviceScaleFactor: 1` screenshots (no resampling).
* **Fonts**: `document.fonts` — `Source Sans [loaded]`, `Bricolage Grotesque [loaded]`, `Noto Sans [loaded]` (Cyrillic subset; the Latin-ext and Arabic faces stay unloaded because this revision uses neither), all five `@font-face` URLs resolve on disk.
* **Geometry**: all 12 text nodes inside the card (card content limit x=864, card 68–574) and inside the canvas; the widest line is the Ukrainian explanation at 126→731.3 px against a panel limit of 834 px; the widest tile line is `DEINE ANTWORT` at 116→360.4 px against a tile limit of 452 px; the check glyph (672–690 px) clear of `dem` (ends 650 px); the provenance chip text (417.7–838.3 px) centred inside its chip (392–864 px).
* **No tracked file changed by this task.** `git status` shows only other teammates' work.
* **Weight**: the SVG is 8 231 bytes uncompressed versus 17 722 / 30 766 bytes for the two webp derivatives it would replace, and it removes the 1 477 962-byte `orange-path.png` from the deploy.

## 11. Constraints honoured

* Synthetic content only; every string traced in §4. No stock or AI imagery — hand-written primitives, no `<image>`, no external references except the repo's own fonts.
* No invented score, percentage, testimonial, price or date; no readiness, no pass prediction, no streak; the item is labelled `EIGENES ÜBUNGSBEISPIEL`.
* No tracked file edited; `public/index.html`, `public/site.css`, `public/assets/*`, `design/assets/hatoove.css` and `public/app/app.css` were read only.
* Exactly one SVG candidate; deterministic (hand-authored, no generator, no randomness).
* Every text/UI colour pair measured in §7; decorative pairs listed with their exemption.
* Alt text in de/en/uk/ar/tr in §8.
* Same write scope as before: the proposal plus `.qa/redesign-01/*`. The extra files in `.qa/redesign-01/` are renders and the rasterised social card requested by the Lead.

## 12. Needs Ron

### 12.1 Dark theme
`.approach-art` hardcodes `background:#fff` ([public/site.css](../public/site.css#L87)) and this candidate is light-theme only, exactly like the asset it replaces. The design system does ship dark tokens (`hatoove.css` `@media (prefers-color-scheme:dark)` and `[data-theme=dark]`), so on a dark page a white card inside a white box will be the brightest object on the screen. **Decision needed:** (a) accept a light-only artwork for the first landing and let the Lead change `.approach-art` to `var(--card)` so the container at least follows the theme, (b) commission a second dark SVG variant swapped with `<picture>` + `prefers-color-scheme`, or (c) leave both as they are. My contrast measurements cover the light theme only; a dark variant would need its own table against the dark tokens (`--ink #f2f0ec`, `--green #7fcfa4`, `--red #f2938a`, `--peach #2c1d15`, …).

### 12.2 Copy consistency
`public.faqUnavailable` (and the matching JSON-LD FAQ answer) says "Live-KI-Bewertung und personalisierte mehrsprachige Erklärungen sind noch nicht freigeschaltet", while the front-door sample *already* renders its fixed explanations in the selected interface language (`grammar0Explanation[5]` in `public-messages.js`) — which is exactly what this graphic depicts, labelled `ERKLÄRUNG · AUF UKRAINISCH`. The graphic shows curated sample explanation text, not AI-personalised feedback, so it does not overstate the pilot; but "personalisiert" is doing a lot of work in that FAQ sentence. **Decision needed:** leave it, or add a half-sentence that fixed sample explanations are already available in de/en/uk/ar/tr. Not changed here.

### 12.3 Mobile slot width — the one place the artwork still fails legibility
**Resolved in §15 (revision 3):** a narrow variant is delivered, its on-screen sizes are measured, the real slot-width map is in §15.6 and the markup is named in §15.8. The table below stays as the measurement that motivated the work, and §15.6 corrects one thing it missed (the two-column band at 641–900 px viewport, where the slot is only 280–410 px).
The Lead's bar (≥ ~16 px on screen) is met at the desktop slot widths and missed on smaller slots, because the on-screen size is `(slot px / 960) × file px` and `.approach-art` shrinks with the viewport:

| Viewport | `.approach-art` width | 30 px style | 36 px style | 40 px sentence |
| --- | --- | --- | --- | --- |
| 1448 px (desktop reference) | ~578 px | 18.1 px | 21.7 px | 24.1 px |
| 1100 px | ~504 px | 15.7 px | 18.9 px | 21.0 px |
| 900 px | ~410 px | **12.8 px** | 15.4 px | 17.1 px |
| 640 px (single column, art capped at 500 px) | 500 px | 15.6 px | 18.8 px | 20.8 px |
| 390 px (phone) | ~358 px | **11.2 px** | 13.4 px | 14.9 px |
| 360 px (phone) | ~328 px | **10.3 px** | 12.3 px | 13.7 px |

So: legible from roughly a 1100 px viewport upward (Ron's front door on a laptop), and **not** legible below that for the 30 px labels and marks — on phones the graphic degrades to an illustration whose meaning sits in the alt text. Options, all needing a decision: (a) accept it, (b) commission a second, tighter mobile variant (e.g. a `viewBox` crop around the sentence + two answer tiles, which would render 40 px type at ~17 px on a 360 px phone but drop the explanation label to ~13 px), or (c) enlarge the slot on small viewports in `site.css` (limited: the art can never exceed the viewport). I did not pick one, because each changes either the deliverable count or tracked CSS.

## 13. Other risks and what I could not do

1. **Tokens are duplicated inside the SVG.** A standalone SVG cannot inherit `hatoove.css`, so the values are re-declared and a token change must be mirrored by hand. Acceptable only if the graphic is treated as a curated asset.
2. **Landing steps are unchanged from revision 1** (see §14) — nothing was landed here.
3. **No device testing.** All evidence is desktop Chromium with an explicit viewport width; AGENTS.md requires real iPhone/Android evidence for UI changes, which needs the landed page.
4. **Alt text and translations are unreviewed** (§8).
5. **Not done:** the landed SVG, `index.html`/`site.css`/`artAlt` changes, deletion of the `orange-path-*` files, replacing `public/assets/og-card.png`, and any repo check run.
6. **Small pre-existing nit** (not touched): [public/index.html](../public/index.html#L87) declares `width="1448" height="1086"` on an `<img>` whose `src` is `orange-path-1400.jpg` (1400×1050). The ratio is identical (4:3), so nothing breaks; the attributes actually describe `orange-path.png`.

## 14. What landing it requires (Lead / Ron decisions, not done here)

1. **Approve or reject revision 2** (§3-A with the §6 type scale). If rejected, this file stays as the record; no tracked change.
2. **Place the asset** (suggestion): `public/assets/landing-item.svg` — outside `public/assets/design/`, because `tools/design-assets-check.mjs` D2 compares every file under `public/assets/design/` against `work/implementation/DESIGN-REFERENCE-MANIFEST.json` digests. Inside the SVG, rewrite the five `@font-face` URLs from `../../design/assets/fonts/…` and `../../public/assets/design/fonts/…` to `/assets/design/fonts/…`.
3. **Replace the front-door figure** in [public/index.html](../public/index.html#L87): drop the `<picture>`/`srcset`/JPEG for a single `<img src="/assets/landing-item.svg" width="960" height="640" loading="lazy" data-i18n-alt="public.artAlt" alt="…de…">`. Decide whether the `orange-path-*` files are deleted in the same change. **Superseded by §15.8 (revision 3): two files behind one `<picture>` with a measured media boundary.**
4. **Update `public.artAlt`** with the five strings in §8 (and, if wanted, `og:image:alt`).
5. **Replace `public/assets/og-card.png`** with the 1200×630 candidate from §9, then run `node tools/seo-check.mjs` (S4 checks that file and its declared dimensions).
6. **Run the offline baseline** from AGENTS.md before pushing: `repository-check`, `design-check`, `retired-surface-check`, `seo-check`, `server-origin-check`, `keymask-check`, `owned-api-check`, `owned-client-check`. `design-check.mjs` / `design-assets-check.mjs` are the ones most likely to react to a new asset under `public/assets/`.
7. **Independent review** by someone who is not the author, plus desktop and mobile evidence on the real page.

## 15. Revision 3 — the narrow variant, the font problem, and the exact markup to land

### 15.1 What was added, and what was not touched

| Artifact | Path | Change | Bytes | sha256 |
| --- | --- | --- | --- | --- |
| Wide candidate | `.qa/redesign-01/landing-graphic.svg` | **not modified by this task, but modified by another writer at 03:04:26 during this session** — `.label` (exam kicker) 30 px → **22 px**, an equal-byte-count edit, which is why the size is unchanged; current sha256 `C4AFCD09CABD3C62E64060DA6FA2BFADC5BCD78DF7FCF2032BFBB4170DE67EAA`. The revision-2 bytes were 8 231 bytes / `770F1FC9…6F22` with the kicker at 30 px, and every wide-variant number in §6 and §15.3–§15.6 was measured against those. The consequence is in §15.12 item 5 | 8 231 | `C4AFCD09CABD3C62E64060DA6FA2BFADC5BCD78DF7FCF2032BFBB4170DE67EAA` |
| **Narrow / mobile variant (new)** | `.qa/redesign-01/landing-graphic-narrow.svg` | new, 720×480 (3:2) | 9 223 | `54BAEDCA1C28896868742AB8F22C13F7FB20911787C4FC55450CDF7006D7E9B7` |
| Social card | `.qa/redesign-01/og-card-candidate.png` | **not modified** — re-read as 1200×630 from IHDR | 69 788 | `7C1B3883463BC5ECF43ECDB93E246D5A26AF19FD036A0526211083DD739059EA` |
| Renders + harnesses | `.qa/redesign-01/landing-graphic-narrow-*.png`, `…-{slots,measure,render}.html`, `landing-graphic-fontprobe.html`, `landing-graphic-rev3-checks.mjs` | new, evidence only | | §15.5, §15.10 |

The write scope of this revision is exactly the proposal plus `.qa/redesign-01/`; nothing under `public/` or `design/` was touched (`.qa/` is gitignored, and this proposal is the only tracked file this task changes), and the wide candidate's bytes and hash are revision 2's.

### 15.2 The narrow variant: what it keeps, what it drops

Same single question, same two options, same explanation, same tokens, same 3:2 canvas ratio — a tighter crop at 25 % larger type relative to the canvas width. It drops only what the narrow slot cannot carry legibly:

| Element | Wide (960×640) | Narrow (720×480) | Why |
| --- | --- | --- | --- |
| Exam kicker | `TELC DEUTSCH B1` 30 px | `TELC DEUTSCH B1` 36 px | kept — it is what makes the picture an exam item |
| Provenance chip | `EIGENES ÜBUNGSBEISPIEL` 30 px | **dropped** | the alt text carries "eigenes Hatoove-Übungsbeispiel, keine offizielle telc-Aufgabe" (§15.7), and the page's own `.sample-note` states it in full next to the live sample |
| The task | `Das ist der Kollege, mit` / gap rule / `ich das Projekt vorbereite.` 40 px | same two strings, 42 px | the same published `bank.grammar[0].text`; the blank is still the orange rule at the start of line 2 |
| Option tiles | side by side, 376 file px each; marks `DEINE ANTWORT` / `RICHTIG` 30 px | side by side, 300 file px each; marks `FALSCH` / `RICHTIG` 36 px | `DEINE ANTWORT` is 289 px with the embedded faces and **321 px in the system fallback** — it cannot fit a 300 px tile (§15.4). `FALSCH` (137 px fallback) and `RICHTIG` (152 px) do |
| Explanation | `ERKLÄRUNG · AUF UKRAINISCH` + one line, 36 px | `ERKLÄRUNG · UKRAINISCH` + the same sentence wrapped over two lines, 36 px | `«Mit» вимагає давального відмінка.` is 602 file px at 36 px against a 576 px panel; the wrap is two hard-coded `<text>` nodes, so it is deterministic, not font-dependent |
| Closing brand rule | below the card | dropped | decorative; the compact canvas has no room under the panel |

Content provenance is unchanged from §4: every string is published in the repo (the German question and both options from `public/site.js` `bank.grammar[0]`, the Ukrainian sentence verbatim from `grammar0Explanation[uk]`); no score, percentage, readiness, streak, price or date.

### 15.3 Measured on-screen size at 360 / 420 / 550 / 630 px slots

Arithmetic is `on-screen = (slot px / 720) × file px`, i.e. the smallest meaning-bearing style is `slot / 20`. The measurements below are **pixel measurements of the actual render**, not arithmetic: the file is loaded as `<img>` at the slot width, drawn to a canvas at its layout size, and the ink box of one text run per region is read from the pixels; the effective size is the median of `s × (artworkInk / rulerInk(s))` over a system-UI ruler at 14–22 px (§15.5).

| Style | File px | Role | 360 slot | 420 slot | 550 slot | 630 slot |
| --- | --- | --- | --- | --- | --- | --- |
| `.label` | 36 | exam kicker | **18.00** | 20.98 | 27.45 | 31.43 |
| `.task` | 42 | the German question | **20.88** | 24.46 | 32.02 | 36.70 |
| `.mark` red | 36 | `FALSCH` | **18.10** | 20.98 | 27.28 | 31.48 |
| `.mark` green | 36 | `RICHTIG` | **18.12** | 20.94 | 27.29 | 31.29 |
| `.ex-body` | 36 | Ukrainian explanation | **17.99** | 21.02 | 27.50 | 31.48 |
| arithmetic, 36 px file | | | 18.00 | 21.00 | 27.50 | 31.50 |
| arithmetic, 42 px file | | | 21.00 | 24.50 | 32.08 | 36.75 |
| **worst deviation vs arithmetic** | | | +0.67 % | −0.29 % | −0.80 % | −0.67 % |

**The smallest meaning-bearing text measures 17.99–18.12 px on screen at a 360 px slot** (bar: 16 px). Calibration of the method on known data, measured against the revision-2 bytes of the wide file (its `.label` was still 30 px then; the file on disk now has 22 px — §15.12 item 5): the wide candidate's 30 px style at a 550 px slot is arithmetically 17.1875 px and **measured 17.22 px** (+0.17 %); its 36 px Ukrainian line at the same slot is arithmetically 20.625 px and its measured ink width is 335 px against a canvas-ruler 335.79 px at 20.625 px. The method returns known values correctly before it is applied to the new file.

### 15.4 The font problem: an SVG in `<img>` cannot load its own `@font-face`

Chrome renders an SVG used as `<img>` in secure static mode, which **blocks external resource loads — including the font files both candidates embed**. The embedded-font layer only fires when the file is a top-level document or is loaded through `<object>`/inline. This is not a `file://` artefact:

`.qa/redesign-01/landing-graphic-fontprobe.html` puts the same file side by side as `<img>` and as `<object>` at 550 px each, screenshots at deviceScaleFactor 1, and diffs the two halves pixel by pixel (`landing-graphic-fontprobe-{v1,http-v1}.png`, `landing-graphic-fontprobe-diff.mjs`):

| Context | Pixels differing between the halves | Ink width of the Ukrainian line (predicted 346.5 embedded / 335.8 system fallback) | Face used |
| --- | --- | --- | --- |
| `file://` | 16 649 / 199 100 = **8.36 %** (max channel delta 245) | 335 px | system fallback |
| same-origin `http://127.0.0.1:8791` | 17 069 / 199 100 = **8.57 %** | 335 px | system fallback |
| `<object>` (own document) | reference | 345 px | Source Sans + Noto Sans, embedded |

What this means for landing:

* The narrow variant is designed and **verified in both contexts**: `.qa/redesign-01/landing-graphic-narrow-measure.html?w=360&pass=fonts` and `?pass=fallback` report **zero problems** — every one of the 12 text nodes inside its tile/panel/card by both ink box and layout box, no glyph overlaps, every shape inside the card and the canvas. The system-UI fallback is 5–11 % wider than the intended faces for these strings; the tightest line in the fallback (`n-task2`) ends at file x 616.7 against a content edge of 668, i.e. 51 px (8 %) of slack, and the tightest overall is the explanation head at 607.6 px against 648 (6.6 %). The design therefore absorbs several more per cent of width growth on other platforms' system faces.
* The numbers in §15.3 come from the `<img>` render — that is the fallback, which is what a visitor actually sees. The same file with its embedded faces at a native 720×480 is `.qa/redesign-01/landing-graphic-narrow-native-720x480.png`.
* **Pre-existing defect in the wide candidate, not introduced here and not fixed here** (the wide file must not change; the numbers in this bullet are the revision-2 bytes, where `.label` was still 30 px — the file on disk now sets 22 px, which removes the collision at a cost recorded in §15.12 item 5): with the embedded faces its 30 px title is 287.6 file px wide and ends at x 383.6, clearing the provenance chip at x 392; in the system fallback it is 302.8 px wide and ends at 398.8, i.e. **6.8 px into the chip**. On the left (`<img>`) half of the probe screenshot the title visibly collides with the chip; on the right (`<object>`) half it does not. Landing the wide file through `<img>` exposes that collision.
* Landing options and their honest costs:
  1. **`<img>` with `<picture>` art direction (recommended)** — simplest, keeps `srcset`/`data-i18n-alt`, both files verified to fit in the fallback. The artwork renders in the visitor's system UI face, so it will not look exactly like the design render.
  2. `<object type="image/svg+xml">` — embedded faces load, but `<object>` has no `<picture>`/`srcset` and no `data-i18n-alt` hook, so the narrow/wide swap and the i18n mechanism would have to be rebuilt in JS.
  3. Inline the SVG into `index.html` — the page's own fonts apply, but it adds ~9 KB of markup, needs a different a11y wiring (`role="img"` + `aria-label`), and mixes artwork into the document.
  4. Outline the text to paths — font-independent and pixel-stable, but needs a converter, adds weight, loses selectable text, and is outside this task.
  With option 1 the five `@font-face` rules are dead weight (~1.4 KB) but harmless, and they keep option 2 open: the file stays self-contained.

### 15.5 Renders and the measurement method

Every render is a 1:1 rasterisation (`deviceScaleFactor: 1`, no resampling). Each slot screenshot shows the same file twice at the slot width: left as `<img>` (the landing shape, system fallback), right as `<object>` (embedded faces).

| Render | Path | Size |
| --- | --- | --- |
| Narrow, native 720×480, embedded faces | `.qa/redesign-01/landing-graphic-narrow-native-720x480.png` | 720×480 |
| Narrow at a 360 px slot (`<img>` + `<object>`) | `.qa/redesign-01/landing-graphic-narrow-slot-360w-img-vs-object.png` | 720×253 |
| Narrow at a 420 px slot | `.qa/redesign-01/landing-graphic-narrow-slot-420w-img-vs-object.png` | 840×293 |
| Narrow at a 550 px slot | `.qa/redesign-01/landing-graphic-narrow-slot-550w-img-vs-object.png` | 1100×383 |
| Narrow at a 630 px slot | `.qa/redesign-01/landing-graphic-narrow-slot-630w-img-vs-object.png` | 1260×433 |
| Wide `<img>` vs `<object>` at 550, font probe | `.qa/redesign-01/landing-graphic-fontprobe-{v1,http-v1}.png` | 1100×380 |

Method (`landing-graphic-narrow-slots.html?w=<slot>`): the SVG is loaded as `<img>` at the slot width, drawn to a canvas at its layout size and the ink box of one text run per region is measured from the pixels (background = modal colour of the region); in the same page a system-UI ruler rasterises the same strings at 14–22 px with the same weight and letter-spacing, and the effective size is `median over sizes of s × (artworkInk / rulerInk(s))` (spread ≤ 0.27 px). Region choice matters: the first attempt counted one antialiased row of the tile's bottom border as ink (a 6.8 % error at a 550 px slot); the regions now stop at file y 302 and every region behind the numbers above reports no ink on its own edge. The geometry harness (`landing-graphic-narrow-measure.html`) is separate and works in file units, so its containment result holds at every slot width (the SVG scales uniformly).

### 15.6 Real slot widths on the page, and which variant belongs where

`.approach-art` is a grid column, so its width follows the viewport ([public/site.css](../public/site.css#L5), lines 86–90 and 111–113). With the CSS exactly as it stands today (`.approach-art` carries a 1 px border, so the artwork's own box is 2 px narrower than the slot — the numbers below are for the slot; measured on the landed page (§15.12) it is 328 px slot / 326 px artwork at a 360 px viewport, i.e. 0.3 % lower):

| Viewport | Slot width | Narrow, 36 px style | Wide, 30 px style |
| --- | --- | --- | --- |
| 1448 px | 577.5 | 28.9 | **18.0** |
| 1240 px | 537.5 | 26.9 | **16.8** |
| 1200 px | 517.5 | 25.9 | **16.2** |
| 1199 px | 517.0 | 25.9 | 16.2 |
| 1101 px | 468.0 | 23.4 | **14.6** |
| 1100 px | 503.5 | 25.2 | **15.7** |
| 900 px | 410.0 | 20.5 | **12.8** |
| 641 px | 280.5 | **14.0** | **8.8** |
| 640–532 px | 500 | 25.0 | 15.6 |
| 420 px | 388 | 19.4 | 12.1 |
| 360 px | 328 | **16.4** | 10.3 |
| 320 px | 288 | 14.4 | 9.0 |

Two consequences:

1. The wide variant clears the 16 px bar only from about a **1190 px viewport** (slot ≥ 512). Below that the narrow variant is the only legible one, so the art-direction boundary is **1200 px viewport**, not 900 px as the task suggested. `media="(max-width: 900px)"` would leave 901–1199 px rendering the wide file at 12.5–15.7 px, i.e. the gap only half closed.
2. **The 641–900 px band is a trap the §12.3 table missed.** At 641–900 px the `.approach` grid is still two columns (`grid-template-columns: 1fr 1fr` from line 86 applies until the ≤640 rule), so the slot is only 280–410 px — narrower than a phone. The narrow variant therefore measures 14.0–20.5 px there. The `.approach` grid already collapses at ≤640 px; collapsing it at ≤900 px as well removes the band. Exact change, inside the existing `@media (max-width: 900px)` block in [public/site.css](../public/site.css#L112): replace `.approach { gap: 32px; }` with

```css
.approach { grid-template-columns: 1fr; gap: 32px; }
.approach-art { max-width: 500px; }
```

With that change the narrow variant's real slots are 500 px (641–900 px viewports, `min(wrap, 500)`), 404–504 px (901–1100 px viewports, still two columns) and `min(viewport − 32, 500)` below — 16.4–25.2 px for the smallest style, and every viewport ≥ 354 px clears 16 px (the 1 px border costs 2 px of artwork: at a 354 px viewport the artwork box is 320 px, the exact threshold). Without it, viewports 641–719 px render the narrow variant at 14.0–16.0 px, and a 320 px viewport renders it at 14.3 px either way — that is the one remaining gap (§15.11).

### 15.7 Alt text in all five languages

The DOM has one `<img>`, so it carries one alt string, while the two variants differ visibly (the wide shows `DEINE ANTWORT` and the provenance chip; the narrow shows `FALSCH` and no chip). Two honest options.

**(a) One shared, variant-neutral string — recommended.** It adds the provenance clause to §8's wording, because the narrow variant no longer shows the chip, and it omits the two mark words, which are the only strings that differ:

* **de** — `Übungsaufgabe Sprachbausteine (eigenes Hatoove-Übungsbeispiel, keine offizielle telc-Aufgabe): Im Satz „Das ist der Kollege, mit ___ ich das Projekt vorbereite“ ist die richtige Antwort B „dem“ grün markiert, die gewählte Antwort A „den“ rot. Daneben steht die Erklärung auf Ukrainisch: „Mit“ verlangt den Dativ.`
* **en** — `Language-elements practice item (a Hatoove practice example, not an official telc task): in the sentence “Das ist der Kollege, mit ___ ich das Projekt vorbereite”, answer B “dem” is correct and marked green, the chosen answer A “den” is marked red. Next to it is the explanation in Ukrainian: “mit” takes the dative.`
* **uk** — `Завдання зі Sprachbausteine (власний приклад Hatoove, не офіційне завдання telc): у реченні «Das ist der Kollege, mit ___ ich das Projekt vorbereite» правильна відповідь B «dem» позначена зеленим, обрана відповідь A «den» — червоним. Поруч подано пояснення українською: «Mit» вимагає давального відмінка.`
* **ar** — `مهمة من قسم Sprachbausteine (مثال تدريبي خاص بـ Hatoove، وليس مهمة telc رسمية): في الجملة «Das ist der Kollege, mit ___ ich das Projekt vorbereite» الإجابة الصحيحة B «dem» مُعلَّمة باللون الأخضر، والإجابة المختارة A «den» مُعلَّمة باللون الأحمر. وبجانبها الشرح باللغة الأوكرانية: «Mit» تتطلب حالة Dativ.`
* **tr** — `Sprachbausteine alıştırma sorusu (Hatoove'un kendi alıştırma örneği, resmî bir telc görevi değil): “Das ist der Kollege, mit ___ ich das Projekt vorbereite” cümlesinde doğru yanıt B “dem” yeşil, seçilen yanıt A “den” kırmızı işaretli. Yanında Ukraynaca açıklama var: “mit” edatı Dativ gerektirir.`

**(b) Exact per-variant strings**, if the Lead prefers the visible mark words to be named. Add `public.artAltNarrow` and swap it in [public/site.js](../public/site.js) when the narrow source is selected (`window.matchMedia('(max-width: 1199px)')` — the same boundary as the markup, so the alt always describes the picture that is on screen). The narrow-only strings:

* **de** — `Übungsaufgabe Sprachbausteine (eigenes Hatoove-Übungsbeispiel, keine offizielle telc-Aufgabe): Im Satz „Das ist der Kollege, mit ___ ich das Projekt vorbereite“ ist die richtige Antwort B „dem“ grün und mit RICHTIG gekennzeichnet, die gewählte Antwort A „den“ rot und mit FALSCH. Darunter steht die Erklärung auf Ukrainisch: „Mit“ verlangt den Dativ.`
* **en** — `Language-elements practice item (a Hatoove practice example, not an official telc task): in the sentence “Das ist der Kollege, mit ___ ich das Projekt vorbereite”, answer B “dem” is correct, marked green and labelled RICHTIG; the chosen answer A “den” is marked red and labelled FALSCH. Below it is the explanation in Ukrainian: “mit” takes the dative.`
* **uk** — `Завдання зі Sprachbausteine (власний приклад Hatoove, не офіційне завдання telc): у реченні «Das ist der Kollege, mit ___ ich das Projekt vorbereite» правильна відповідь B «dem» позначена зеленим і підписом RICHTIG, обрана відповідь A «den» — червоним і підписом FALSCH. Нижче подано пояснення українською: «Mit» вимагає давального відмінка.`
* **ar** — `مهمة من قسم Sprachbausteine (مثال تدريبي خاص بـ Hatoove، وليس مهمة telc رسمية): في الجملة «Das ist der Kollege, mit ___ ich das Projekt vorbereite» الإجابة الصحيحة B «dem» مُعلَّمة باللون الأخضر وبكلمة RICHTIG، والإجابة المختارة A «den» مُعلَّمة باللون الأحمر وبكلمة FALSCH. وفي الأسفل الشرح باللغة الأوكرانية: «Mit» تتطلب حالة Dativ.`
* **tr** — `Sprachbausteine alıştırma sorusu (Hatoove'un kendi alıştırma örneği, resmî bir telc görevi değil): “Das ist der Kollege, mit ___ ich das Projekt vorbereite” cümlesinde doğru yanıt B “dem” yeşil ve RICHTIG olarak, seçilen yanıt A “den” kırmızı ve FALSCH olarak işaretli. Altında Ukraynaca açıklama var: “mit” edatı Dativ gerektirir.`

Both sets are agent-written and **not human-reviewed** (§8 applies). `og:image:alt` is unchanged — the card still comes from the wide variant (§9). The narrow file's own `<title>`/`<desc>` carry the German string, so a standalone view (or an `<object>` landing) is described too.

### 15.8 Exact markup to land

```html
<!-- public/index.html, replacing the <picture> inside .approach-art (line 88 today) -->
<picture>
  <source media="(max-width: 1199px)" srcset="/assets/landing-item-narrow.svg" type="image/svg+xml">
  <img src="/assets/landing-item.svg" width="960" height="640" loading="lazy"
       data-i18n-alt="public.artAlt" alt="Übungsaufgabe Sprachbausteine (eigenes Hatoove-Übungsbeispiel, keine offizielle telc-Aufgabe): Im Satz „Das ist der Kollege, mit ___ ich das Projekt vorbereite“ ist die richtige Antwort B „dem“ grün markiert, die gewählte Antwort A „den“ rot. Daneben steht die Erklärung auf Ukrainisch: „Mit“ verlangt den Dativ.">
</picture>
```

Why this shape:

* Both files are 3:2 (960×640 and 720×480), so **one** `width="960" height="640"` pair describes either source: no layout shift when the narrow source is selected, and `.approach-art img { width: 100%; height: auto }` needs no change.
* `media="(max-width: 1199px)"` is the measured boundary from §15.6 (the wide file's 30 px style drops below 16 px under a 512 px slot, i.e. under about a 1190 px viewport), not a guess. The task's suggested `(max-width: 900px)` is the smaller change but leaves 901–1199 px on the wide file at 12.5–15.7 px; recorded here as an explicit decision rather than a silent one.
* The `<img>` is the wide file, so it stays the default and the social-card source (§9) does not move.

Landing steps (this section supersedes §14 item 3):

1. Copy `.qa/redesign-01/landing-graphic.svg` → `public/assets/landing-item.svg` and `.qa/redesign-01/landing-graphic-narrow.svg` → `public/assets/landing-item-narrow.svg`. Both go outside `public/assets/design/`, which `tools/design-assets-check.mjs` D2 compares against the manifest digests (§14 item 2).
2. In both landed files, rewrite the five `@font-face` URLs to `/assets/design/fonts/…` (the candidates sit in `.qa/redesign-01/` and use `../../design/assets/fonts/…` and `../../public/assets/design/fonts/…`). All five targets exist under `public/assets/design/fonts/` (`source-sans-3.woff2`, `bricolage-grotesque.woff2`, `noto-sans-latin-ext.woff2`, `noto-sans-cyrillic.woff2`, `noto-sans-arabic.woff2`). This step only matters if the Lead lands via `<object>`/inline (§15.4); with `<img>` the rules never fire.
3. Replace the figure at [public/index.html](../public/index.html#L88) with the block above and delete the `orange-path-*` `<source>`/`srcset`/JPEG in the same change (the four `orange-path-*` files then leave the deploy).
4. Put §15.7(a) into `public.artAlt` (or add `public.artAltNarrow` + the `matchMedia` swap for §15.7(b)).
5. Apply the two-line CSS change from §15.6.
6. Replace `public/assets/og-card.png` with `og-card-candidate.png` (still exactly 1200×630) and run `node tools/seo-check.mjs`.
7. Run the offline baseline from AGENTS.md; `design-check`/`design-assets-check` and `seo-check` are the ones most likely to react to a new asset under `public/assets/`.

### 15.9 Contrast, re-measured

Recomputed for this revision (`.qa/redesign-01/landing-graphic-rev3-checks.mjs`, WCAG 2.x, sRGB, from the token values):

| Pair | Ratio | Bar | Result |
| --- | --- | --- | --- |
| `--ink` on `--card` (task, option words) | 15.72:1 | 4.5 | PASS (AAA) |
| `--orange-dark` on `--card` (exam kicker) | 5.51:1 | 4.5 | PASS (AA) |
| `--ink` on `--red-bg` (option A `den`) | 13.74:1 | 4.5 | PASS (AAA) |
| `--ink` on `--green-bg` (option B `dem`) | 13.73:1 | 4.5 | PASS (AAA) |
| `--red` on `--red-bg` (`FALSCH`, cross glyph, tile border) | 6.41:1 | 4.5 | PASS (AA) |
| `--green` on `--green-bg` (`RICHTIG`, check glyph, tile border) | 6.93:1 | 4.5 | PASS (AA) |
| `#fff` on `--red` (badge letter `A`) | 7.33:1 | 4.5 | PASS (AAA) |
| `#fff` on `--green` (badge letter `B`) | 7.93:1 | 4.5 | PASS (AAA) |
| `--ink` on `--peach` (Ukrainian explanation) | 14.12:1 | 4.5 | PASS (AAA) |
| `--orange-dark` on `--peach` (`ERKLÄRUNG` head) | 4.95:1 | 4.5 | PASS (AA) |
| `--orange` on `--card` (answer gap rule) | 2.84:1 | — | decorative, exempt — the sentence reads without it |
| `--peach-line` on `--peach` (panel edge) | 1.18:1 | — | decorative, exempt |
| `--line` on `--card` (card border) | 1.24:1 | — | decorative, exempt |
| `--muted` on `--canvas` (wide provenance chip) | 5.89:1 | 4.5 | PASS (AA) — pair **dropped** in the narrow variant |

**The narrow variant introduces no new colour pair**: it uses a subset of the wide variant's tokens and drops one pair. Colour is still never the only cue (WCAG 1.4.1): the right answer carries the badge letter `B`, a check glyph and the word `RICHTIG`; the learner's pick carries `A`, a cross glyph and the word `FALSCH`.

### 15.10 Verification evidence for revision 3

* **XML/standalone validity**: `System.Xml.XmlDocument` parses both files — wide 35 elements / 12 text nodes, narrow 33 elements / 12 text nodes; root `<svg>`, `role="img"`, `viewBox="0 0 720 480"` for the narrow, `<title>` + `<desc>` present.
* **Renders**: §15.5 — native 720×480 with embedded faces, and 360 / 420 / 550 / 630 px slots as `<img>` and as `<object>`; the wide file's font behaviour is measured in the same probe.
* **Measured on-screen px**: §15.3, with the method calibrated on the wide candidate's known 30 px and 36 px styles.
* **Geometry, both font contexts, zero problems**: `landing-graphic-narrow-measure.html?w=360&pass=fonts` and `?pass=fallback` — ink-box and layout-box containment for all 12 text nodes, glyph-overlap detection, shape-in-card and shape-in-canvas checks.
* **Font behaviour**: §15.4 — 8.36 % (`file://`) and 8.57 % (same-origin HTTP) of pixels differ between `<img>` and `<object>`; ink width 335 px vs 345 px identifies the fallback.
* **Social card**: `og-card-candidate.png` re-read from IHDR as **1200×630**, 69 788 bytes, sha256 unchanged — from the wide source, which was not modified.
* **Weight**: the narrow file is 9 223 bytes; together with the 8 231-byte wide file it replaces 1 477 962 bytes of `orange-path.png` plus 48 488 bytes of webp derivatives.
* **No tracked file under `public/` or `design/` changed.** Write scope: this proposal (the only tracked file this task edits) and the gitignored `.qa/redesign-01/`.

### 15.11 What is still not legible, and other honest limits

1. **Viewports below about 354 px** (a 320 px viewport gives a 288 px slot, 286 px of artwork) render the smallest style at 14.3 px — below the 16 px bar. The art can never be wider than the viewport; closing this would need another crop step or accepting the alt text on those devices. This is the only viewport band that still misses the bar after §15.6's CSS change.
2. **The visitor's system font is what renders** (§15.4). Both variants are verified to fit in that context, but the wide candidate's title/chip collision appears there, and the artwork will not look exactly like the design render.
3. **Alt strings and translations are agent-written and unreviewed** (§8).
4. **Light theme only** — unchanged from §12.1; this revision's contrast table covers the light tokens.
5. **No device testing.** All evidence is desktop Chromium with explicit viewport widths; AGENTS.md still requires real iPhone/Android checks on the landed page.
6. **Measurement precision.** The on-screen sizes are font sizes derived from pixel ink widths in Chromium at deviceScaleFactor 1; on other rasterisers they can move by a few tenths of a pixel (calibration error ±0.2 %, region-edge artefacts excluded and documented in §15.5).

### 15.12 State of the in-progress landing, measured on the real page (2026-10-05)

While this revision was being written another writer landed a first pass into `public/` (staged: `public/assets/landing-item.svg`, `public/assets/landing-item-narrow.svg`, the four `orange-path-*` deletions, plus `public/index.html`, `public/assets/i18n/public-messages.js`, `public/site.css`). This task did not touch those files. The landed SVGs are byte-for-byte the candidates of §15.1 with only the five `@font-face` URLs rewritten to `/assets/design/fonts/…` (verified by line diff) — so landing steps 1–2 of §15.8 are done and the artwork now on the page is the artwork verified above. Four things still contradict the measurements:

| # | What the page does now | What the measurement says | Where |
| --- | --- | --- | --- |
| 1 | `<source media="(max-width: 900px)">` | the wide crop clears 16 px only from about a 1190 px viewport; measured on the page at an 1100 px viewport the wide file is served at a 503.5 px slot and its 30 px labels render at **15.67 px**. Use `(max-width: 1199px)` (§15.6) | `public/index.html:97` |
| 2 | the `@media (max-width: 900px)` block still has two grid columns (`.approach { gap: 32px; }`) | measured at a 641 px viewport the narrow crop is served, but the slot is 280.5 px and the 36 px styles render at **13.93 px**. Add the collapse from §15.6 | `public/site.css:112` |
| 3 | `artAlt` (and the static `alt`) says "Übungsaufgabe aus dem **Lesen**-Teil: Antwort **A** ist grün als richtig markiert, die gewählte Antwort **B** rot" | the artwork is a **Sprachbausteine** item and the colours are the other way round — A `den` is red and labelled `FALSCH`, B `dem` is green and labelled `RICHTIG`. The "eigenes Übungsbeispiel, keine offizielle telc-Aufgabe" clause is missing too | `public/assets/i18n/public-messages.js:67`, `public/index.html:98` |
| 4 | the HTML comment says the wide variant "is legible from about a 1100 px viewport up" and that the file's own `@font-face` rules supply the curated Noto faces | the 30 px label measures 15.67 px at an 1100 px viewport, and an SVG in `<img>` does not load those rules at all (§15.4) — the Ukrainian line renders in the system font, not Noto Sans | `public/index.html:90-95` |
| 5 | the wide file's `.label` (the exam kicker `TELC DEUTSCH B1`) is now **22 px** — it was 30 px in revision 2 — in both `.qa/redesign-01/landing-graphic.svg` and the landed copy. Changed at 03:04:26, equal byte count, **not by this task** | the kicker is meaning-bearing (it is what names the exam) and at 22 px on a 960 canvas it renders at **11.49 px** at an 1100 px viewport and **13.19 px** at the 1448 px desktop reference — below the 16 px bar at every real slot, so after this edit the wide crop fails on this style even on the widest desktop. The rest of the wide scale is unchanged | `public/assets/landing-item.svg:48`, `.qa/redesign-01/landing-graphic.svg:48` |

Measured on the landed page over a local read-only static server (`.qa/redesign-01/landing-graphic-qa-server.mjs`, repo `public/` only, nothing written; the crop and the artwork box are read from `img.currentSrc`, `img.naturalWidth` and the artwork's own `getBoundingClientRect()` after scrolling it into view, because `loading="lazy"` means it has not loaded before then; the on-screen sizes are the file's px values multiplied by that measured artwork box). The 1100 px and 1448 px rows were measured after the 22 px edit of item 5:

| Viewport | Crop served | `.approach-art` slot | Artwork box | `.label` (22 / 36 px file) | Marks (30 / 36 px) | Task (40 / 42 px) | Smallest meaning-bearing | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1448 px | wide 960×640 | 577.5 | 575.5 | **13.19 px** | 17.98 px | 23.98 px | **13.19 px** | ✗ |
| 1199 px | wide 960×640 | 517.0 | 515.0 | **11.80 px** | 16.09 px | 21.46 px | **11.80 px** | ✗ |
| 1100 px | wide 960×640 | 503.5 | 501.5 | **11.49 px** | 15.67 px | 20.90 px | **11.49 px** | ✗ |
| 641 px | narrow 720×480 | 280.5 | 278.5 | 13.93 px | 13.93 px | 16.25 px | **13.93 px** | ✗ |
| 360 px | narrow 720×480 | 328 | 326 | 16.30 px | 16.30 px | 19.02 px | **16.30 px** | ✓ |

That the only artwork change is the kicker is confirmed by pixels: the revision-2 native render `.qa/redesign-01/landing-graphic.png` and a render of the current file `.qa/redesign-01/landing-graphic-current-960x640.png` differ in 3 268 of 614 400 pixels (0.532 %), all of them inside x 96–382 / y 92–112 — the kicker's row — with no other row differing.

So the landed first pass fixes the phone case (the narrow crop is served at ≤900 px and clears the bar at 360 px), but text is still under the bar in three ways: the 22 px kicker (item 5) on **every** wide viewport including the 1448 px desktop reference, the 901–1189 px band where the wide crop is served with its 30 px marks at 12.6–16.0 px (item 1), and the 641–900 px band where the narrow crop is served into a 280–410 px slot (item 2). Items 1 + 2 + 5 need code changes; items 3 + 4 are content correctness and an inaccurate comment.

**Recommendation for item 5:** restore `.label` to 30 px (the revision-2 value, 17.19 px at a 550 px slot) and fix the fallback collision where it actually comes from — the total row width. At 30 px in the system fallback the title is 302.8 px wide and the full chip text `EIGENES ÜBUNGSBEISPIEL` is 444.7 px, so title + 8 px gap + chip text + 2 × 20 px padding = 795 px against 768 px of card content (x 96–864): the row overflows by about 28 px. Shortening the chip text to `EIGENES BEISPIEL` (16 characters ≈ 309 px in the same fallback) brings the row to 660 px — 108 px of slack — and both styles stay at 30 px and keep their on-screen size. Giving the chip its own row is the alternative. I did not make either change: the wide file was outside this task's deliverable (it was to be left as it is), and another writer's edit must not be overwritten silently. This is the Lead's decision.
