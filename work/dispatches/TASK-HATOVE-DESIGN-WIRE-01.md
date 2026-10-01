# TASK — HATOVE-DESIGN-WIRE-01: wire Claude's design pages into the app

| | |
|---|---|
| Raised by | Ron, 2026-10-01: *"claude created our pages `D:\B1_Prep\design` we will need a task to wire these up"* |
| Source of the design | **`D:\B1_Prep\design`** — read as a reference in this session. **`D:\B1_Prep` is Ron's live install and was not modified**; the design folder is the only thing read from it |
| What is there | 15 HTML files, 1 stylesheet (21 KB), 3 SVG logos, 2 woff2 fonts, and a 46 KB `build.py` — **0.29 MB, 14 screens plus an index** |
| Target | `public/` in `ronslink/hatoove`, on top of the candidate `codex/ownapi-03-persistent` @ `e126d8c` (PR #60) |
| Status | **TASK DEFINITION. Not started.** Five decisions in §2 are Ron's and precede any code |
| Relationship to existing work | **Supersedes nothing.** `work/implementation/DESIGN-LANGUAGE.md` governs the *existing* app; this is a new visual identity that **contradicts** parts of it. §2.1 says exactly how |

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

### 2.2 — DECISION (Ron): the design's interface is in **English**, and the app's is not

The design's navigation reads *"Today, Study plan, Reading, Language elements, Listening, Writing, Mistakes, Mock
exam, Progress, Settings"*, and its explanation-language control reads *"Explanations: Українська"*. The app's
navigation is German (`Übersicht`, `Adaptive Übungen`, `Wortschatz`, `Fehlerheft`, `Prüfungsteile`,
`Hörverstehen`, `Schreiben`, `Sprechen`, `Nachschlagen`, `Mocktest`, `Lernplan`, `Einstellungen`, `Konto`).

**A standing decision points the other way, and a gate enforces it.** Ron, 2026-10-01: *"language refers to the
explanation language; **the menu and the content remain german**."* `tools/design-check.mjs` refuses a language
setting that drives the interface, and five browser checks in `tools/account-ui-browser-check.mjs` prove the German
navigation is byte-identical after the explanation language is switched.

So the design as drawn **fails that gate**, and it is not a bug in the design — it is a **different product
decision**: an English app chrome with Ukrainian explanations. Three ways forward, and this needs Ron:

- **(a) German chrome, German content, Ukrainian explanations** *(what was decided)* — the design's layout is
  adopted and its **copy is translated to German**. The `lang="de"`/`lang="uk"` tagging in the design is already
  good practice and should be kept.
- **(b) English chrome, Ukrainian explanations** — a deliberate reversal of the 2026-10-01 decision. Then the
  `design-check` language guard and five browser checks must be **removed or inverted in the same commit**, and the
  change recorded as a decision, not slipped in.
- **(c) English chrome with a full UI translation for German learners** — the largest of the three, and it makes
  the app bilingual in a way nothing in the current codebase supports.

**Until this is answered, do not touch `public/index.html`'s navigation labels, `shell.js`'s titles, or the
language guard.** A worker that translates the chrome to match the design without an answer will break five
green browser checks and the gate, and it will look like a regression rather than a decision.

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
4. **`lang` attributes are correct** on German and Ukrainian text, as the design already does.
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
