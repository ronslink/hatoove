# REDESIGN-01 G1 — landing-page graphic: proposal and one SVG candidate (revision 2)

**Status: candidate for review — not landed, not approved, no tracked file touched.**
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
| **Rasterised social card** | `.qa/redesign-01/og-card-candidate.png` | no | **exactly 1200×630**, 69 788 bytes — the file `public/assets/og-card.png` contract expects |

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
3. **Replace the front-door figure** in [public/index.html](../public/index.html#L87): drop the `<picture>`/`srcset`/JPEG for a single `<img src="/assets/landing-item.svg" width="960" height="640" loading="lazy" data-i18n-alt="public.artAlt" alt="…de…">`. Decide whether the `orange-path-*` files are deleted in the same change.
4. **Update `public.artAlt`** with the five strings in §8 (and, if wanted, `og:image:alt`).
5. **Replace `public/assets/og-card.png`** with the 1200×630 candidate from §9, then run `node tools/seo-check.mjs` (S4 checks that file and its declared dimensions).
6. **Run the offline baseline** from AGENTS.md before pushing: `repository-check`, `design-check`, `retired-surface-check`, `seo-check`, `server-origin-check`, `keymask-check`, `owned-api-check`, `owned-client-check`. `design-check.mjs` / `design-assets-check.mjs` are the ones most likely to react to a new asset under `public/assets/`.
7. **Independent review** by someone who is not the author, plus desktop and mobile evidence on the real page.
