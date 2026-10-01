# TASK — HATOVE-DESIGN-WIRE-01: wire Claude's design pages into the app

| | |
|---|---|
| Raised by | Ron, 2026-10-01: *"claude created our pages `D:\B1_Prep\design` we will need a task to wire these up"* |
| Source of the design | **`D:\B1_Prep\design`** — read as a reference in this session. **`D:\B1_Prep` is Ron's live install and was not modified**; the design folder is the only thing read from it |
| What is there | 15 HTML files, 1 stylesheet (21 KB), 3 SVG logos, 2 woff2 fonts, and a 46 KB `build.py` — **0.29 MB, 14 screens plus an index** |
| Target | `public/` in `ronslink/hatoove`, on top of the candidate `codex/ownapi-03-persistent` @ `e126d8c` (PR #60) |
| Status | **DECIDED AND DISPATCHABLE.** Ron answered all four blocking questions on 2026-10-01 — see §0.5. Phases 1–4 below are approved in shape; **the shipping order for `ar` and `tr` is the only recommendation still awaiting a yes** |
| Relationship to existing work | **It REPLACES the existing design language** (Ron's decision, D3). `work/implementation/DESIGN-LANGUAGE.md` must be rewritten in the same commit as the first screen — §2.1 says exactly what that costs |

---

## 0.5 THE DECISIONS — Ron, 2026-10-01. Read these first; they unblock the work.

| # | Question | **Decision** |
|---|---|---|
| **D1** | Does the design's English chrome replace German? | **No. German chrome, German content; explanations in the learner's language.** The design's layout and flows are adopted, its **copy is translated to German**, and Ukrainian joins the explanation-language setting. **The `design-check.mjs` language guard and the five browser checks that prove the German navigation is byte-identical after a language switch stay exactly as they are.** |
| **D2** | What are the go-live languages? | **FINAL, Ron, 2026-10-01: English, Ukrainian, Arabic, Turkish** — plus German, which is the chrome and the default. So the **explanation-language set is `de`, `en`, `uk`, `ar`, `tr`** — five, not eight. `ru`, `ro` and `fa` from `D:\B1_Prep\PRODUCTION_STRATEGY.md:295`'s candidate-population line are **out of the go-live list**; that line is a population judgement, not the go-live decision, and it must not be read as one |
| **D3** | Does this design replace the existing design language? | **Yes. Replace it, and rewrite `DESIGN-LANGUAGE.md` with it.** One stylesheet, one token set, `design-check.mjs`'s token/font/breakpoint rules moved in the **same commit**. See §2.1 |

**Where the list came from, and what it is not.** The six names at `PRODUCTION_STRATEGY.md:295` are a
candidate-population judgement; **Ron's go-live list is the narrower five-language set above and it supersedes
them for that purpose.** I searched the repository, the handoff folder and the live install's markdown for a ranked
frequency table and **there is no such table in any of the three** — so no ordering claim attaches to either list.
If a separate frequency study exists elsewhere, **point me at it and I will reconcile it**; it would not change the
five, only the order they are shown in.

**Two things to know about the five, and one of them is a real piece of work nobody has costed:**

1. **Turkish has no evidence behind it at all.** The feasibility studies probed **Arabic and Ukrainian** only
   (`research/deepseek-feasibility/README.md:16`, `research/mistral-feasibility/README.md:15`). **Turkish was never
   probed**, so `tr` starts from zero — it is not "the same as Arabic".
2. **Arabic is right-to-left, and this app has never rendered RTL text.** Everything in `public/` assumes
   left-to-right; there is no `dir` attribute anywhere and no logical-property CSS. An Arabic explanation is
   therefore not "one more option in a `<select>`": it needs `dir="rtl"` scoped to the explanation element, mirrored
   layout where the text is inline, correct punctuation and numerals, and a font that actually has Arabic glyphs —
   **`Source Sans 3` and `Bricolage Grotesque` do not.** This is the single largest hidden cost in the whole design
   task and it belongs in the estimate, not in a surprise.

**Native review is still open, and the research says so in writing.** `docs/assessment/FEEDBACK-CASES.md:170`:
*"Arabic/Ukrainian samples needed glossary and native review."* `research/deepseek-feasibility/semantic-review.md:66`
adds that the **Arabic** case terms *"need review against an agreed German-learning glossary by a qualified
Arabic-language educator; Arabic grammatical categories do not map mechanically to German case terminology. This
review provides no native-expert translation signoff."* And
`research/mistral-feasibility/RESULTS-2026-09-30.md:63` is the sharpest: *"A language code and valid JSON cannot
establish translation quality… No native-speaker acceptance study was performed."*

**So the honest shipping order, and it is a recommendation the coordinator is making rather than a decision Ron has
taken:** `de` and `en` as today; **`uk` next** (probed, and the design already draws it); then `ar` and `tr` **behind
their `C-06`-equivalent native sign-off**, which is open for both. **Exposing five options is cheap; claiming reviewed
explanation quality for `ar` and `tr` is not, and that claim is what a selector option makes by existing.**

---

## 0. Read this before doing anything

**The design is a full restyle, not a reskin.** Measured, not impressionistic:

| | Existing app (`public/styles.css`, 32 KB) | Claude's design (`assets/hatoove.css`, 21 KB) |
|---|---|---|
| Background | `--bg: #f5f1e8` — warm cream | `--canvas: #faf9f6`, `--paper: #fff` — near-white |
| Primary action | `--accent: #213f78` — **deep navy** | `--orange: #ff6b2b` — **bright orange** |
| Accent | `--gold: #b7791f` | `--orange-dark: #bd3c0a`, `--peach: #fff0e7` |
| Text | `--fg: #1a2130` — navy-black | `--ink: #242320` — warm near-black |
| Headings | `--serif: 'Fraunces', 'Iowan Old Style', Georgia, serif` | `--display: "Bricolage Grotesque", …` — **not a serif** |
| Body | `--sans: 'Source Sans 3', …` | `--font: "Source Sans", …` (same family, **different file and a variable face 200–900**) |
| Radii | `--radius: 14px`, `--radius-sm: 9px` | `--r-sm: 8px`, `--r: 12px`, `--r-lg: 18px`, `--r-xl: 24px` |
| Tokens | `--bg`, `--bg-2..4`, `--line`, `--fg`, `--accent`, `--gold`, `--good/warn/bad`, `--shadow*` | `--canvas`, `--paper`, `--card`, `--ink`, `--orange`, `--peach`, `--green/amber/red`, `--shadow` |

**Every token name is different and no value is shared.** `DESIGN-LANGUAGE.md` §1 says *"Preserve it. No framework
migration, no redesign, no new palette."* The design does exactly the three things that sentence forbids. **That is
fine — it is Ron's product and Ron can change his mind — but it means §2.1 is a decision, not a detail.**

**And two mechanisms will actively reject it today:**

- **`tools/design-check.mjs`** fails the build on: a missing token from the `DESIGN-LANGUAGE.md` list; a
  `font-family` that is not `var(--serif|sans|mono)`; a raw colour outside a custom property; a missing dark
  override; a missing mobile breakpoint (1100/860/600/480); a missing `prefers-reduced-motion`; a view not
  registered through `shell.registerView`. The design uses **`Bricolage Grotesque`** for `--display` and new token
  names, so **it fails this gate as it stands**, by design.
- **`tools/design-check.mjs` also refuses a language setting that reaches the interface** (see §2.2).

---

## 1. What is in the folder, and where each screen lands

The 14 screens map onto the app's **20 registered views** (`public/js/app.js:252-271`) as follows. `A` = the screen
is a restyle of something that exists; `B` = the screen needs a view that does not exist; `C` = the screen needs
server data or a product feature that does not exist.

| # | Design screen | Lands on | Class | The work it implies |
|---|---|---|---|---|
| 01 | `login.html` — magic link + Google | `account` (`Konto`, sign-in/sign-up/sign-out) | **B** | **Magic link and Google are not implemented.** `server/owned-postgres/sessions.mjs` is the synthetic email+password port. No GoTrue, no Better Auth, no Google. This is S5 — Ron's decision — and a design cannot add it |
| 02 | `check-email.html` | — | **C** | needs a mail path that does not exist |
| 03 | `onboarding.html` — exam, date, explanation language, daily time | `settings` + `account` | **B** | needs a first-run wizard (no such view); fields already exist as settings (`examDate`, `dailyGoal`, `language`) |
| 04 | `dashboard.html` — **Today**, "readiness vs pass line" | `home` (`Übersicht`) | **A + C** | the readiness-vs-pass-line presentation is new; the forecast exists (`--good/warn/bad` bands) |
| 05 | `practice.html` — exam-part runner, timer, **question map** | `paper` (`Prüfungsteile`) | **A + C** | the question map is new UI; the runner exists |
| 06 | `language.html` — answer feedback with a **Ukrainian** explanation | `drill` (Adaptive Übungen) | **A + C** | the feedback surface exists; **the explanation language does not reach the interface today** — see §2.2 |
| 07 | `listening.html` — play-once, true/false | `listening` (Hörverstehen) | **A** | restyle; the play-count rules already exist |
| 08 | `writing.html` — letter editor, **Leitpunkte check**, criteria bands, AI feedback | `writing` (Schreiben) | **A + C** | **this is the screen WRITING-SURFACE-01B just wired.** The design adds a live Leitpunkt checklist and a 3-band rubric presentation the current view does not have |
| 09 | `review.html` — mistakes, spaced queue, weak topics | `notebook` (Fehlerheft) | **A** | restyle |
| 10 | `plan.html` — week calendar to the exam date | `plan` (Lernplan) | **A + C** | the current plan is a dated list; the design is a **calendar grid**, which is new UI |
| 11 | `progress.html` — estimate over time, by part, mock history | `home`/`notebook` partly | **C** | **there is no progress-over-time series.** `store.js` keeps attempts and an ability estimate, not a per-day series; a chart needs either derived data or a new record |
| 12 | `mock.html` | `mock` (Mocktest) | **A** | restyle |
| 13 | `settings.html` | `settings` (Einstellungen) | **A** | restyle; note the design's settings screen is not the current one's field set |
| 14 | `upgrade.html` — plans, quotas | — | **C** | see §2.3 |
| — | *(no design screen)* | `vocab`, `vocabdrill`, `speaking`, `reference`, `speakingguide`, `writingguide`, `casesguide`, `nounsguide`, `grammarguide`, `sentenceguide` | — | **10 existing views have no design.** Decide whether they are restyled to the new language or left alone — leaving them makes two design languages ship at once |

**Six of the fourteen screens therefore need something the app does not have**, and three of those (§2.2, §2.3,
§2.4) need a **product decision** rather than implementation effort. Wiring cannot start cleanly until they are
answered, which is why this is a task definition.

---

## 2. The decisions that block the wiring

### 2.1 — DECISION (Ron): this design replaces the existing design language, or is a second one

`DESIGN-LANGUAGE.md` §1 says preserve the identity and no new palette; `tools/design-check.mjs` enforces it
mechanically. The design replaces the palette, the heading face and every token name.

**Recommended, and it is the only version that stays honest:** *this design **replaces** the old one, and
`DESIGN-LANGUAGE.md` is rewritten to describe the new language in the same session as the first screen lands.* The
alternative — two design languages — is a defect by the existing document's own definition, and it is the exact
condition Ron asked for the design language to prevent.

**What that requires, concretely:**
1. **A token alias map is not enough.** The new stylesheet must be merged into `public/styles.css` so there is
   **one** stylesheet, or `design-check.mjs` must be taught the new token list — **and either way the check's
   `REQUIRED_TOKENS` list and `DESIGN-LANGUAGE.md` §2's table must be updated in the same commit.** A gate that
   still demands `--gold` after the palette stopped having one fails for the wrong reason.
2. **The font change is a payload change.** Today: `Fraunces` (serif) + `Source Sans 3`. The design brings
   `Bricolage Grotesque` + `Source Sans` as **variable woff2 files** that are *not in the repository yet*, and
   `DESIGN-LANGUAGE.md` §2 promises *"three faces, no more"*. Adding a fourth means saying which three remain.
3. **`@font-face` self-hosting has a licence question** for `Bricolage Grotesque`, which is OFL — record the licence
   in the repository next to the files rather than in someone's head.

### 2.2 — ANSWERED (Ron, D1 + D2): German chrome, and **five** explanation languages

**D1 = German chrome and German content; explanations in the learner's language.** **D2 = the go-live explanation
set is `de`, `en`, `uk`, `ar`, `tr`.**

**The design's Ukrainian explanation is therefore the feature, not a mockup flourish — keep it. Its English chrome
is not: translate it.** The five browser checks that prove the German navigation is byte-identical after a language
switch **stay green and stay in place**, and `design-check.mjs`'s language guard **is not touched**.

**But the code does not support the set yet, and one of the five needs work that has nothing to do with styling.**

| | Today | For five explanation languages to be go-live |
|---|---|---|
| The setting's options | `public/js/ui.js:919-921` offers exactly **two**: `de` (Deutsch), `en` (English) | add `uk` (`Українська`), `ar` (`العربية`), `tr` (`Türkçe`) — each labelled in its own script, as the design does with `Українська` |
| The stored value | free text, `SETTINGS_TOKEN_RE`, ≤ 16 chars (`server/owned-api.mjs:110,141-146`) | **no server change needed**; the field is already open |
| The help text | `ui.js:924`: *"Gilt nur für Erklärungen und Rückmeldungen zu deinen Antworten. **Menü und Prüfungsinhalte bleiben Deutsch.**"* | **stays true** — D1 is exactly this |
| Does the setting reach anything? | **No.** `language` is stored and shown; **every provider prompt in `public/js/ai.js` is hardcoded German** (`:725` *"Kurze deutsche Erklärung der Regel"*, `:1191`, `:1247`). `RON-DECISIONS-20261001.md` records this as the D2 remainder | **this is the real work**, it is server-side, and it is item 1 of Phase 3 |
| **Arabic (RTL)** | **the app has never rendered right-to-left text**: no `dir` attribute anywhere in `public/`, no logical-property CSS, and neither `Source Sans 3` nor `Bricolage Grotesque` has Arabic glyphs | **`dir="rtl"` scoped to the explanation element**, mirrored inline layout, correct numerals and punctuation, and **a font that has Arabic glyphs** — see §0.5 item 2 |
| `lang` attributes | not used for explanations | the design already tags them (`lang="de"`, `lang="uk"`) — **keep that**, and extend it per language with the matching `dir` |
| Native review | `en` is gated by `C-06`; `uk` and `ar` were probed and **not** signed off; `tr` was never probed | see §0.5 item 2 — **`uk` next, `ar` and `tr` behind their own sign-off** |

**What is needed to proceed, and it is one thing: the shipping order.** §0.5 recommends `de`+`en` as today, `uk`
next, and `ar`+`tr` gated behind native review. **If that is right, say so and Phase 3 item 1 can start
immediately.**

**Do not touch `public/index.html`'s navigation labels, `shell.js`'s titles, or the language guard.** D1 makes that
a decision rather than a preference: a worker who translates the chrome to match the design will break five green
browser checks and the gate, and it will look like a regression rather than a reversal.

### 2.3 — DECISION (Ron): the design shows paid plans, quotas and an upgrade screen

`upgrade.html` shows plan tiers; `writing.html` carries *"AI feedback: 17 of 20 left"*. **The database already has
`entitlements` and `usage_ledger`** and the deletion transaction reaches both, so the *mechanism* exists — but
**no pricing decision has been made, and the standing boundary is "no live payments"**.

- The entitlement counter can be **honest today** (`allowance - used - reserved` is real data).
- The **plan names, prices, expiry and the upgrade flow cannot**. `dashboard.html`'s *"Exam Sprint · until 12 Dec"*
  is an invented plan.
- **Do not put a price or a plan name in the product before Ron decides it.** A number the system cannot honour is
  the same class of defect as the retention period this programme refused to invent.

### 2.4 — DECISION (Ron): the design claims a grading property the system does not have

`writing.html:65` reads: *"AI estimate checked by two different models, not an official score."* **The system uses
one provider** (`DEEPSEEK_*`, a single proxy at `server.js`). Two-model cross-checking is a real feature to build
(two calls, agreement logic, a cost decision) **or the sentence must change.** Shipping the sentence over a
single-model path is exactly the false-claim defect this programme has recorded repeatedly — most recently
`owned-api-check` printing a memory note on a PostgreSQL run.

### 2.5 — DECISION (coordinator's, but say it out loud): is this a React app?

`design/index.html:8` says *"Design reference for the React app (work package W-01 onward)."* **Nothing in this
repository mentions a React app**, `package.json` has no dependencies and no build step, and `public/` is vanilla
ES modules with `shell.registerView`. So either:

- **the design is a visual reference for the existing vanilla app** — then "React" in the index is a copy error and
  should be corrected in the design folder; or
- **a React migration is intended** — then this is not a wiring task at all, it is a rewrite of the whole client,
  and it needs its own objective, its own risk assessment, and a decision about whether the 21 views and the whole
  browser-check suite are ported or rewritten.

**Assume (a) unless told otherwise, and correct the sentence in the design source.** Do not start a React
migration on the strength of one line in a mockup index.

---

## 3. The work, once the decisions land

**Phase 0 — decisions recorded.** `work/implementation/DESIGN-WIRE-01.md`: which of §2.1–§2.5 was decided and by
whom, with the design folder's commit or hash if it is ever versioned.

**Phase 1 — one design language, and the gate moved with it.**
1. Merge `assets/hatoove.css` into `public/styles.css` (or replace it), **keeping one source of truth**.
2. Rewrite `DESIGN-LANGUAGE.md` §1–§3 to describe the new identity and the new token names.
3. Update `tools/design-check.mjs`'s required-token list, its font rule and its `REQUIRED_BREAKPOINTS` to match,
   **and verify it still fails** on a raw colour, a raw `font-family`, a missing token, a missing dark override and
   a missing breakpoint. **A gate that has been relaxed until it passes is the defect, not the fix.**
4. Add the fonts under `public/fonts/` with their licences, and `@font-face` rules pointing at them.
5. Commit the **hero screen first** (see Phase 2) so the gate is proven on real markup rather than on a stylesheet.

**Phase 2 — screen by screen, hero first.** Order by value and by risk, one commit each:

| Order | Screen | Why here |
|---|---|---|
| 1 | `dashboard` → `home` | the highest-traffic surface and the one that proves shell, sidebar, tokens, dark mode and 390 px together |
| 2 | `writing` | **the freshest code**: `WRITING-SURFACE-01B` just wired it (`codex/writing-surface-01b`, PR #75). The design's Leitpunkt checklist and criteria bands land on top of a draft service that already exists |
| 3 | `practice` + `language` + `listening` | the exam runner family, shared components |
| 4 | `review` + `plan` + `progress` | the track family; `progress` waits on §1's class-C data question |
| 5 | `mock` + `settings` | restyle of two large existing views |
| 6 | `account` + `onboarding` | **blocked on S5** (auth) for the sign-in half; the wizard can land first |

**Phase 3 — the data the new screens need, as its own slices.** Each of these is server or store work, not styling,
and each gets a checker:

- **The go-live explanation languages (`de`, `en`, `uk`, `ar`, `tr`) — this one can start now, and it is the
  smallest complete slice.** Today `ui.js:919-921` offers `de` and `en`, and the choice reaches nothing: **every
  provider prompt in `public/js/ai.js` is hardcoded German** (`:725`, `:1191`, `:1247`). The slice is four parts:
  1. **add the options**, each labelled in its own script (`Українська`, `العربية`, `Türkçe`), and extend the
     existing five navigation checks so they keep proving the German chrome is unaffected;
  2. **carry the chosen language into the provider prompt** — the D2 remainder. **This is a server-side change to
     the AI prompt path**, so it needs the prompt to move server-side (issue #63) or a bounded, recorded exception.
     Do **not** let a client-controlled language string reach the provider unchecked, and do not let it select a
     *model*: the model is operator configuration (`provider-config-check` 11/11 exists to keep it that way);
  3. **handle Arabic's direction.** `dir="rtl"` on the explanation element only, mirrored inline layout, and a font
     carrying Arabic glyphs. **`design-check.mjs` must be extended to catch a missing `dir` on an RTL explanation**,
     in the same style as its other rules — otherwise the day someone adds a sixth language without direction, the
     layout breaks silently;
  4. **gate `ar` and `tr` behind native review.** Both are unreviewed (`uk` was probed too, and is the one to ship
     first). A selector option is a quality claim; **do not make it for a language nobody has signed off.**
- **Leitpunkt coverage** for the writing screen: how many of the four task points the current text covers, and by
  what rule. **If it is a model judgement, say so in the UI** — a "covered" tick the server did not verify is a
  false claim.
- **Progress over time** (`progress.html`): either derive a series from the attempt log, or record one. Say which.
- **Question map** (`practice.html`): per-item answered/flagged state inside a running part.
- **Readiness vs pass line** (`dashboard.html`): the forecast exists; the *presentation against the pass mark* is a
  computation that should be checked, not eyeballed.

**Phase 4 — proof that the same rules still hold.** The existing pattern, and it is not optional:
`tools/mock-outcome-browser-check.mjs`-style evidence at **390 px and 1440 px, in both themes**, asserting **no
horizontal overflow, no console errors, visible focus, touch targets ≥ 44 px** — plus `node tools/design-check.mjs`
exit 0. **A 390 px emulated viewport is not a phone**, and the real-device gate (`C-06`/`P-03`/`X-01` neighbours)
stays open: nothing here may be reported as real-device evidence.

---

## 4. Acceptance — stated so it cannot be met vacuously

1. **One stylesheet, one token set, one gate.** `design-check.mjs` green **and** shown to fail when a raw colour, a
   raw font family, a token or a breakpoint is removed. The old token names appear nowhere.
2. **Every wired screen renders from the app's real data.** A screen that renders sample strings from the mockup
   ("Olena K.", "14 mistakes", "17 of 20 left", "33 / 45") is **not** wired; it is a copy of the design pasted into
   the app. Assert on a real value the app produced.
3. **390 px, both themes, no horizontal overflow, no console errors, focus visible, touch ≥ 44 px** — per screen,
   in CI, with the counters quoted in the record.
4. **`lang` and `dir` attributes are correct** on German, Ukrainian, Arabic and Turkish text. Arabic explanations
   carry `dir="rtl"`, and `design-check.mjs` fails when an RTL language is added without it.
5. **No copy that claims a capability the system lacks** (§2.4), and **no price or plan name** before §2.3 is
   decided.
6. **The German-navigation browser checks still pass** — or the decision that removed them is recorded with the
   commit that removed them (§2.2).
7. **The views with no design screen are decided explicitly**, not left to drift (§1, last row).

---

## 5. Deliverables

- `work/implementation/DESIGN-WIRE-01.md` — the decision record (§3 Phase 0) plus the wiring log.
- One commit per screen, each naming the base SHA, each with its browser evidence.
- The rewritten `DESIGN-LANGUAGE.md` and the updated `design-check.mjs` **in the same commit as the new stylesheet**.
- A PR against `codex/ownapi-03-persistent` — **a branch with no PR gets no CI.**
- **If a step is larger than it looked:** stop at a green pushed milestone and report what remains. A partial pushed
  slice is worth incomparably more than a complete unpushed one — four runs in this programme learned that the
  expensive way.

---

## 6. Boundaries

No deployment, no DNS, **no live payments**, no invitations, no new production access, no live AI. Synthetic data and
provider stubs only. **`D:\B1_Prep` is Ron's live install — the design folder may be *read*; nothing in that tree
may be modified, and no build step may run there.** Gates `E-01`, `C-04`, `C-06`, `P-03`/`X-01` and real-device
evidence stay **open**. A 390 px emulated viewport is not a phone. **Clawdbot is not in use.**
