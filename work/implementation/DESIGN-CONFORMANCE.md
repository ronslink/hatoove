# DESIGN-CONFORMANCE-01 — why `public/app/` does not look like the supplied designs

**Ron, 2 October 2026:** *"we need to look into the design folder of d:/B1_Prep to see what the pages
should look like. `D:\Hatoove\public\app\index.html` looks nothing like our designs."*

He is right, and the reason is narrower and more fixable than "the design was not followed".

---

## 1. The finding that decides the shape of the work

**Every component the designs use is ALREADY DEFINED in our pinned stylesheet.** Measured against
`public/assets/design/hatoove.css` (byte-pinned, digest `36af5c8f190b3700…`):

| | | | |
|---|---|---|---|
| `.exam-pill` ✅ | `.side-foot` ✅ | `.avatar` ✅ | `.crumbs` ✅ |
| `.lang-btn` ✅ | `.icon-btn` ✅ | `.gauge` ✅ | `.bar` / `.band` ✅ |
| `.parts` ✅ | `.part` ✅ | `.mini` ✅ | `.card-peach` ✅ |
| `.hero-next` ✅ | `.count` ✅ | `.kicker` ✅ | `.mobile-bar` ✅ |
| `.top-actions` ✅ | `.grid-dash` ✅ | `.hint` ✅ | `.skip` ✅ |
| `.link` ✅ | | | |

**So the gap is MARKUP, not CSS.** The shell was built from the design's *tokens* — the orange, the
type, `.card`, `.btn`, `.field`, `.chip` — and then a layout was invented around them. The design's
*components* and *page structure* were never adopted. That is why it "looks nothing like" the designs
while using the same stylesheet: it is wearing the design's colours and none of its parts.

## 2. The designs are directly renderable with our own stylesheet

Each screen is standalone HTML that links `../assets/hatoove.css` — **the same file we pinned**. There
is no missing stylesheet, no build step and no translation layer. Conformance is therefore a markup
exercise, and the 14 screens are usable as the source of that markup.

## 3. The second gap, which is bigger than the styling: THE INFORMATION ARCHITECTURE DIFFERS

The design's navigation is organised **by skill**, with group labels and counts:

```
Today · Study plan
  ── Practise ──
  Reading · Language elements · Listening · Writing
  ── Track ──
  Mistakes (14) · Mock exam · Progress
```

The shell's navigation is:

```
Heute · Üben · Wörterbuch · Nachschlagen · Fortschritt · Konto · Einstellungen
```

These are not the same product. `Üben` is a generic bucket where the design has four named skills;
`Wörterbuch`/`Nachschlagen` are the shell's own inventions (good ones, but the design puts vocabulary
and reference material somewhere else); and **`Mistakes`, `Mock exam`, `Study plan` and `Progress` have
no view at all.**

### Screen → view map

| Design screen | Shell view today |
|---|---|
| `dashboard` | `heute` — exists, structurally different (no `.gauge`, `.parts`, `.hero-next`) |
| `practice` | `ueben` — exists, conceptually different |
| `language` | **none** (the design's "Language elements" practice) |
| `listening` | **none** (and HV has no audio — see below) |
| `writing` | **none** (writing tasks are listed under `ueben`) |
| `review` | **none** ("Mistakes", with a count badge) |
| `mock` | **none** |
| `plan` | **none** ("Study plan") |
| `progress` | `fortschritt` — exists, far simpler |
| `settings` | `einstellungen` — exists |
| `upgrade` | `checkout` — the checkout screen (`public/app/checkout.js`, PAYMENTS-01 contract) |
| `onboarding` | **none** |
| `login` | `signin.html` — exists as the one public page |
| `check-email` | **none** (no email flow yet — PILOT-18) |

## 4. The rule that must survive the rebuild

**The designs' copy is ENGLISH** ("Today", "Language elements", "Mistakes", "Written estimate"). That is
the designer's working language. **MASTER-PLAN §4 rule 6 requires the interface to be GERMAN** — decided
and built. So: **adopt the structure, the components and the layout; render the copy in German.** Do not
"conform" by switching the interface to English, and do not treat the English strings as the spec for
the wording.

## 5. Constraints

- **Never edit `public/assets/design/hatoove.css`.** It is byte-pinned; `design-assets-check` D2 fails on
  a changed digest, and this project has already made that mistake once (font-coverage rules added to
  it). New chrome goes in `public/app/app.css`.
- The design's icons are inline SVG in the screens. Reuse them; do not substitute emoji (the older
  client used 🔊 and the design does not).
- `upgrade.html` is a PAYMENT surface. It is **in scope** (Ron, 3 October 2026; MASTER-PLAN **D15**) and
  `public/app/checkout.js` implements it. Prices, promotional dates and withdrawal terms still need real
  contracts, so the screen shows only what the server actually has — never a mockup's figure.

## 6. Ordered plan

1. **Shell chrome first** — sidebar (`.exam-pill`, grouped `.nav` with SVG icons and `.kicker`
   labels, `.side-foot` + `.avatar`) and topbar (`.crumbs`, `.lang-btn`, `.icon-btn`, `.mobile-bar`).
   Every screen sits inside it, so it must conform before any page does.
2. **`heute`** to the `dashboard` screen: `.page-head` with `.kicker` + a sentence-shaped `<h1>`,
   `.card-peach.hero-next`, `.gauge` with `.bar.band`, `.parts`/`.part`/`.mini`, `.hint`.
3. **Skill views** — Reading / Language elements / Listening / Writing as their own views, driven by
   the objective catalogue's `section` (LV/SB) and family, replacing the generic `Üben` bucket.
4. **`review`** (Mistakes) over `item_evidence` — the data already exists: every wrong answer is a row.
5. **`progress`**, **`plan`**, **`mock`**, then the rest.

## 7. LIMIT — CLOSED on 2 October 2026: a browser has now been run

**This section used to say "no browser has ever been run in this project".** That is no longer true, and
the distinction it drew was the right one, so it is kept rather than deleted:

> Conformance cannot be *claimed* by matching class names; it has to be seen.

It has now been seen. `tools/app-browser-check.mjs` brings up a **disposable Compose stack** (own project,
own volume, own free ports — never the learner's), drives headless Chromium over the shared CDP harness in
`tools/cdp.js`, and walks the real journey — front door → sign-in → Heute → Leseverstehen → open a set →
answer it → Fehler → the other views — at **1440×900 and 390×844**, in **light and dark**, writing
screenshots to `.qa/browser/<stamp>/` (gitignored). It is **56 legs, 56 passing**.

Its assertions are about what is ON SCREEN, and each one was written because a weaker version passed while
the product was broken:

| Leg | What it asks | What it caught |
|---|---|---|
| `L1b`, `L1c` | is the page STYLED, and was anything it requested refused? | the front door rendered as **unstyled HTML**: `/` served the brand site, whose relative assets resolved to `/styles.css` (401), `/app.js` (401) and `/assets/hatoove-logo.svg` (404). "Has text and an h1" passed happily. |
| `L7`, `L9` | does `Heute` show the server's recommendation, and is the console clean? | `api.practice.progress` was missing from `public/app/api.js` while `renderDashboard()` called it. `Heute` stayed on "Wird geladen …" for ever, with an unhandled rejection. |
| `L15b` | is the opened task **on screen**? | pressing "Üben" rendered the form BELOW nine cards, off the bottom of the viewport. Every DOM and class-name assertion passed. |
| `L4b`, `L4d`, `L20b`–`L20d` | does `hidden` actually hide? | the pinned `.stack{display:grid}` outranks `[hidden]`, so the sign-in page showed BOTH forms and its tabs were decorative; `#guide-body` was visible before a guide was opened and "Zurück" did nothing. |
| `L13b` | is any set titled with a seed placeholder? | nine sets carried the generator's fallback title (`LV3 1`, `SB1 2`) on screen. |
| `L22`, `L22b`, `L22c` | one tabbar row, nothing clipped, nothing behind the bar? | ten tabs in the pinned five-column grid wrapped into a SECOND fixed row that covered the end of every view; the phone's mistakes badge was a duplicate id that never updated. |

**Still a limit, and still stated rather than implied:** headless Chromium on a desktop OS is not an iPhone
or an Android device. It proves rendering, layout and interaction; it does not replace a real-device
keyboard, audio or Safari check, and it cannot see a font fallback that only that device has. The
real-device gate stays open.

---

## 8. Step 2 — the dashboard, and the THREE THINGS THE DESIGN ASKS FOR THAT WE MUST NOT BUILD

The supplied `dashboard.html` asserts, verbatim:

```
<div class="gauge-top"><span>Written estimate</span><span><b>152</b> / 225</span></div>
<div class="gauge-foot"><span>Range 142–162 · from 418 answers</span><span>pass line 135 (60 %)</span></div>
<div class="stat"><span class="num">9</span><span>day streak</span></div>
<div class="stat"><span class="num">14</span><span>mistakes due</span></div>
```

**A calibrated score estimate, a confidence range, a pass line and a streak.** AGENTS.md and
MASTER-PLAN forbid every one of them: *"provisional formative feedback, not calibrated readiness
scores"*; *"no readiness, streaks, study-plan or reminder UI"*; no pass prediction. The design's
own `.hint` even says *"Practice estimate from your answers, not an exam result"* — the designer knew it
was an estimate, and the product decided not to ship estimates at all.

**So the layout, the components and the hierarchy were adopted and the claims were not.** What the
dashboard shows instead, all of it from `item_evidence` and `state.settings`:

| Design | Built | Why |
|---|---|---|
| `Written estimate 152 / 225` | **count of answered items** | a projection of a mark is exactly the forbidden thing |
| `Range 142–162` | *omitted* | a confidence interval is a pass prediction wearing a statistic |
| `pass line 135 (60 %)` | *omitted*, and **no `warn` colour** | the design's `.mini warn` class keys off that same 60 %, so using it would smuggle the pass line back in through a colour |
| `9 day streak` | *omitted* | streaks are excluded by name |
| `14 mistakes due` | **counts of answered / correct** | "due" implies a scheduling claim nothing here makes |
| `.parts` per-part scores (54/75 …) | **per-section `correct / attempts`** | the learner's own record rather than a scaled exam score |

`.hint` is kept and states the position plainly: *"Das ist deine Übungsbilanz, kein Prüfungsergebnis.
Eine Note oder eine Bestehensprognose gibt es hier bewusst nicht."*

**A deviation from a design is a decision that must be visible.** If a future session "restores" the
gauge to match the mock-up, it will be reintroducing a pass prediction, and this section is where that
is discoverable rather than a matter of taste.

### The route the dashboard needed

`GET /api/v1/practice/progress` — per-section counts from `item_evidence`, plus totals. **Counts, not a
score**, and `accuracy` is `null` for a section with no attempts rather than 0: never-seen is not the
same as failed. Verified: a fresh learner gets `{attempts: 0, accuracy: null, sections: []}`; after two
answers, `{attempts: 2, correct: 1, accuracy: 0.5, sections: [{section: "LV", …}]}`.

---

## 9. Rendered evidence, 2 October 2026 — what the screenshots changed

Everything below was decided by **looking at the rendered screens**, not by reading markup. The screens
are at `.qa/browser/<stamp>/` (gitignored, regenerated by `node tools/app-browser-check.mjs`).

**1. The front door is the brand site, served AT `/`.** The earlier state did not work: `/` served
`public/landing/index.html`, and because the page's asset URLs are relative they resolved to
`/styles.css`, `/app.js` and `/assets/hatoove-logo.svg` — none of which is the landing's file.
`/styles.css` and `/app.js` answered **401** (the shell's auth gate; and note the gate decides BEFORE
resolution, so a path that is not public answers 401 whether or not the file exists — an earlier version of
this record said 404, which was only reachable in an intermediate state of this very change). Ron, 2
October: *"we need landing/index or just index"* → **just index**. The site artifact is now copied to the
root of `public/` and `/` serves it directly; its stylesheet and script are named `site.css` / `site.js` so
they cannot collide with the retired SPA's `public/styles.css` (still the subject of
`tools/design-check.mjs`) or with the shell at `/app/`. `hatoove-site/dist` remains the deployable artifact
and `tools/app-browser-check.mjs` P1 fails if the two ever drift.

**2. The phone tabbar carries ten destinations in ONE scrollable row — a recorded deviation.** The pinned
stylesheet lays the tabbar out as `repeat(5, minmax(0,1fr))` because the design's tabbar has exactly five
items (Today · Plan · Practise · Mistakes · Progress). Ours has ten. Five columns wrapped them into a
second fixed row ~112 px tall against the 96 px of bottom padding the stylesheet reserves, so the end of
every view sat behind the bar. The override lives in the shell's own layer (`public/app/app.css`, which is
allowed to change; the pinned file is not): one row, `overflow-x:auto`, min tap height measured at 75 px.
**Grouping ten destinations into five tabs is an information-architecture decision for Ron, not taken
here.**

**3. One thing at a time.** Opening a set replaces the catalogue list (the list is hidden, the task is at
the top of the viewport) and "Schließen" restores it; opening a guide hides the index and "Zurück"
restores it; entering a skill view closes whatever set was open. The design does the same
(`practice.html` is a full-screen runner with a back control), and the first version did not: the task
was appended below the list, off-screen.

**4. Set titles.** Nine of the twenty-four seeded sets have no authored title, so the seed generator wrote
`LV3 1`, `SB1 2`, … into `objective_set.title`. A learner is never shown a database convenience: the client
renders the section and part instead (`Sprachbausteine · Teil 1`). **The missing authored titles are
content and are recorded for Ron** — inventing exam-material names is not a client change.

> **Correction, same day, after an independent review.** This section first claimed the learner "is never
> shown a database convenience" while two places still printed the raw title: the Üben catalogue
> (`renderTasks`) and the Fehler rows. The review found both by reading the code and by opening the one
> view this check did not visit; they are fixed, `L20i` now covers the Üben catalogue and `L13b` the skill
> lists, and the Fehler row prints the section instead of duplicating the title. A claim of that shape
> needs a leg everywhere it can be violated, not one place.

**5. Answer tiles use the design's `.stat-row`**, not `.parts` (which is a one-column grid and stacked the
two tiles full width).

**6. Nothing renders a pass line.** The gauge has no `.band`, no `<s>` marker and no `.mini.warn`, and
`tools/app-browser-check.mjs` L20f asserts their absence — the `warn` colour keys off the design's 60 %
pass threshold, so using it would smuggle the pass line back in through a colour.