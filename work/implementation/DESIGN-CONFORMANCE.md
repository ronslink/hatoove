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
| `upgrade` | **none** (deliberately: no purchase UI in the pilot, AGENTS.md) |
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
- `upgrade.html` is a PAYMENT surface. The pilot has no purchase UI (AGENTS.md), so it is deliberately
  out of scope even though the design exists.

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

## 7. LIMIT — and it is the important one

**No browser has ever been run in this project.** Every design claim in this record comes from reading
markup and grepping a stylesheet. **No screen has been rendered, at any breakpoint, in either theme.**
Conformance cannot be *claimed* by matching class names; it has to be seen. Until a browser renders
these screens, this document records an intention, not a result — and steps 1–2 in particular should be
verified visually before steps 3–5 build on them.

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
scores"*; *"no readiness, streaks, study-plan, reminder/purchase UI"*; no pass prediction. The design's
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