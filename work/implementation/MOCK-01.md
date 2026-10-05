# MOCK-01 — Probeprüfung intro page and saved-run history (MIRROR-B1PREP-01 slice D)

**Status: delivered, not reviewed.** Author: teammate `mock-intro`. Worktree
`D:\Hatoove\.worktrees\mock-intro-01`, branch `codex/mock-01-probepruefung`, base commit `072d29e`.
Independent review and integration are separate gates; nothing was pushed, merged or deployed.

## 1. Scope

`docs/contracts/MIRROR-B1PREP-01.md` §4.2 (frozen client view modules) and §5 slice D. One page:

- the three written blocks with their official minutes and points, and the written total;
- the official telc B1 pass threshold stated as a **fact**, never as a prediction (D22);
- the note that the oral exam (Sprechen) is not part of it;
- **one** start control that issues today's unchanged `complete_supported_written` run request through the
  existing api client;
- below it the saved runs, read from the same endpoint and labelled with the same helpers the existing
  Prüfungsläufe history uses.

The run machinery is untouched: `public/app/mock.js`, `public/app/app.js`, `public/app/index.html`,
`server/**` and `public/assets/i18n/**` outside the one catalogue file below are unmodified.

## 2. Files

| File | Change |
|---|---|
| `public/app/mock-intro.js` | new — the module (`createMockIntroView`, `introMarkup`, `historyMarkup`, `createMockStarter`) |
| `public/app/mock-intro.css` | new — module-owned styles, tokens only |
| `tools/mock-intro-check.mjs` | new — 17-leg focused check with mutation proof |
| `public/assets/i18n/practice-messages.js` | **shared file, announced**: 16 new keys, all five locales, in the `MOCK-01` block before `PRACTICE_MESSAGES` |
| `work/implementation/MOCK-01.md` | this note |

**Announced shared-file write:** `public/assets/i18n/practice-messages.js`. Only the `rows` object grew (no
existing key changed), and `tools/i18n-register-check.mjs` R5 and `tools/practice-locale-check.mjs` both pass.
New keys: `mockIntroTitle`, `mockIntroLead`, `mockIntroBlocks`, `mockIntroColPart`, `mockIntroColTime`,
`mockIntroColPoints`, `mockIntroBlockWritten`, `mockIntroBlockListening`, `mockIntroBlockWriting`,
`mockIntroBlockTotal`, `mockIntroTotalNote`, `mockIntroRuleTitle`, `mockIntroRule`, `mockIntroOral`,
`mockIntroStartFailed`, `mockIntroStartSession` (16 keys). Everything else reuses existing practice keys
(`ui59`–`ui67`, `startComplete`, `finished`, `openRun`, `view`, `resume`, `form`, `formRelease`, `minutes`,
`timed`, `untimed`, `tasks`, `serverLoading`, `mockScope`, `sectionScope`, `startingRun`, `mockSession`).

## 3. Exam facts used, and where they come from

| Fact | Source |
|---|---|
| Leseverstehen + Sprachbausteine 90 min · Hörverstehen 30 min · Schreiben 30 min (= 150 min) | contract §5 D; canonical `timeGroups` in `content/exams/telc-deutsch-b1/manifest.json` (`lv-sb-90` = 5400 s) and `tools/exam-s5b-fixture.mjs` (`hv-30`, `writing-30` = 1800 s each) |
| Leseverstehen 75 + Sprachbausteine 30 = 105 · Hörverstehen 75 · Schreiben 45 · written total 225 · oral 75 · whole exam 300 | `docs/exam/TELC-B1-SOURCES.md` §4 (`Punkte und Gewichtung`) |
| Official rule: at least 60 % of the maximum in the written **and** in the oral part separately; 135/225 and 45/75 | `docs/exam/TELC-B1-SOURCES.md` §4.1 |
| No overall verdict is possible while speaking is unassessed | `docs/exam/TELC-B1-SOURCES.md` §4.1, last paragraph |

The page therefore states the rule and stops there. There is no "Bestanden?" card: B1_Prep's
`public/js/exam.js:1508` shows `Bestanden? Ja/Nein` from the written part alone, which
`docs/exam/LEGACY-GAP-MAP.md` G1 records as a defect — that wording is deliberately **not** mirrored.
Only the phrasing intent of `B1_Prep/public/js/exam.js:1211–1213` (block list, 225 points, oral note) is reused.

## 4. Reuse decisions (what is not a second surface)

- **Start request:** `api.mock.forms()` (GET `/api/v1/mock-forms`) then `api.mock.start({ formId, formVersion,
  releaseVersion, eventId })` — byte-for-byte the call `mock.js` `list()` already makes, including the
  idempotent `eventId` reuse on retry. `eventId` is a UUID, which is what `server/mock-contract.mjs`
  `validateStartMockRun` requires. The success path hands the run to the shell as `#/lauf/<id>`, the route
  `mock.showRun` already owns.
- **History:** `api.mock.list()` (GET `/api/v1/mock-runs`) — the same endpoint `mock.list()` and
  `renderHistory()` use. Labels come from the exported helpers `mockScopeLabel`, `mockReviewLabel` and
  `mockWritingStatus` of `public/app/mock.js` (imported, not copied) plus `reviewHistoryNotice` of
  `public/app/review-labels.js`; the heading reuses the existing shell key `m006`
  ("Gespeicherte Prüfungsläufe") through `ctx.uiText`, and states reuse `ui65`–`ui67`.
- No new endpoint, no new storage, no new label vocabulary.

## 5. Interface this module expects (what the Lead must wire)

Contracts §4.2, plus the three shell facts the Lead sent on 5 October 2026:

1. `mount(host)` is called with `#mock-intro-host` (the `<div class="stack" id="mock-intro-host">` inside
   `#view-probepruefung`). The module writes `host.innerHTML` and attaches `host.onclick`; it touches nothing
   outside that host.
2. `mock-intro.css` is injected by the shell after `import()` succeeds; the module assumes it is loaded.
   Nothing else needs doing for the stylesheet.
3. `ctx = { api, uiText, esc, language, navigate, state }`. `navigate` is called **once**, with
   `#/lauf/<run-id>`, after a successful start; if it is missing the module falls back to `location.hash`.
   `state.preparation.state` is read to disable the start control on an archived preparation.
4. `mount` returns a promise (the first load). Ignoring it is fine; `unmount()` before it settles cancels the
   paint. Both are safe on a host that is already gone.
5. **Optional additive hook (not part of the frozen ctx):** `ctx.examLanguage` (for telc B1: `'de'`) marks the
   form title and the saved-run titles as LTR exam-language islands. Without it they render `lang="und"` — the
   same fallback `mock.js` uses when `getExamLanguage()` is unknown. The Lead may add it; nothing breaks if not.
6. The module does **not** render the route title. Its `h1` is "Schriftliche Probeprüfung" so it does not
   repeat the topbar's "Probeprüfung" (shell key `m400`).

The Lead's interim renderer (the saved-runs list written into the same host through the existing mock
controller) is untouched in this branch and remains the fallback when the module cannot be imported.

## 6. Checks run, with results

All commands run from `D:\Hatoove\.worktrees\mock-intro-01`.

```text
node tools/mock-intro-check.mjs
  17 passed, 0 failed

node tools/design-check.mjs
  14 passed, 0 failed, 2 warning(s)        (warnings pre-existing: monospace, inline radius)

node tools/i18n-register-check.mjs
  PASS R1..R10                             German register: 0 findings, 11 shipped files

node tools/practice-locale-check.mjs
  Practice locale: 18 checks passed

node tools/repository-check.mjs            Repository check passed: 699 tracked files
node tools/retired-surface-check.mjs       10 passed, 0 failed
node tools/seo-check.mjs                   11/11 checks passed
node tools/server-origin-check.mjs         OK 8 check(s) passed
node tools/keymask-check.mjs               OK 14 check(s) passed
node tools/owned-api-check.mjs             34 passed, 0 failed (backend: memory)
node tools/owned-client-check.mjs          32 passed, 0 failed
node tools/shell-locale-check.mjs          Shell locale: 25 checks passed
node tools/guide-render-check.mjs          303 real examples preserved, 15 wrong examples labelled
```

### 6.1 What the focused check pins (17 legs)

Interface `{mount, unmount}`; the three block rows (label + minutes + points, plus the 150/225 total row); the
225/300/75 total-points note; the official rule with 60 %, 135, 225, 45, 75; the Sprechen note; exactly one
start control (`data-mock-intro-start` appears once, and the history rows cannot start a run); the exact start
request (`['eventId','formId','formVersion','releaseVersion']`, UUID eventId, no other endpoint touched) and
the `#/lauf/<id>` navigation; idempotent retry after an unanswered start; three refusal paths (archived /
session / generic) each showing a message and navigating nowhere; the history from `api.mock.list()` with the
exported scope/review/writing labels, finished vs open, and the withdrawn-review notice; empty vs refused
history as different answers; degradation for no complete form / archived preparation / missing api; D22
vocabulary in all five locales; all five locales rendering blocks, rule and oral note untranslated; Arabic
`dir="rtl"` with an LTR exam-language island; the formal German register; and the module stylesheet using only
defined tokens, no raw colour, no un-tokenised font, with its one extra breakpoint (420 px) module-scoped.

### 6.2 Mutation proof (`%TEMP%`, copies of `public/`, run with `--module=`)

```text
MUTATION A  oral-exam note removed
  FAIL  5 oral note: Sprechen is named as not part of this mock
  FAIL 14 five locales: blocks, rule and oral note all render ...
  15 passed, 2 failed

MUTATION B  a "Sie haben gute Chancen zu bestehen." sentence added
  FAIL 13 D22: no prediction vocabulary in ANY of the five locales
         prediction wording reached the learner: de -> "Chancen", en -> "Chancen", ...
  16 passed, 1 failed

MUTATION C  start body key releaseVersion renamed to release_version
  FAIL  7 unchanged run request: ... the request carries only today's four fields
  16 passed, 1 failed
```

Reproduce with:

```powershell
Copy-Item -Recurse D:\Hatoove\.worktrees\mock-intro-01\public $env:TEMP\mock-intro-mutation\public-A
# edit $env:TEMP\mock-intro-mutation\public-A\app\mock-intro.js
node tools/mock-intro-check.mjs --module=$env:TEMP\mock-intro-mutation\public-A\app\mock-intro.js
```

The check resolves the locale runtime from the module under test
(`new URL('../assets/i18n/core.js', moduleUrl)`), so a copied tree renders in the locale the check sets
instead of the browser-inferred one.

### 6.3 Rendered evidence (untracked, gitignored `handoff/`)

`D:\Hatoove\.worktrees\mock-intro-01\handoff\ron-agent\` — harness `mock-intro-harness.html`, server
`static-server.mjs`, screenshots `mock-intro-<width>-<lang>-<theme>.png`:

| Screenshot | Width | Notes |
|---|---|---|
| `mock-intro-1366-de-light.png`, `mock-intro-1366-de-dark.png` | 1366×768 | loaded, 3 saved runs |
| `mock-intro-390-de-light.png`, `mock-intro-390-de-dark.png` | 390×844 | loaded |
| `mock-intro-390-ar-dark.png` | 390×844 | Arabic RTL, German run titles and form title in LTR islands |
| `mock-intro-390-en-light.png` | 390×844 | empty history state |
| `mock-intro-320-de-light.png`, `mock-intro-320-de-dark.png` | 320×720 | all three facts visible, no page or table overflow |
| `mock-intro-320-refused-light.png` | 320×720 | forms and history refused |

Measured in the page, every state: `document.documentElement.scrollWidth === innerWidth` at 320, 360, 390,
768 and 1366 px, in the Arabic render too, and the block table's wrapper does not scroll at 320/390/1366.
The harness reproduces only what the shell gives a module (the four pinned stylesheets plus `mock-intro.css`,
a host inside `<main class="content">`, and a synthetic `api`), served read-only on `127.0.0.1:4183` from the
worktree root; the server process was killed after the screenshots were taken.

## 7. What was NOT verified

1. **The real shell wiring.** `#mock-intro-host`, the dynamic `mock-intro.css` injection, `ctx.navigate`,
   `ctx.uiText` and `ctx.state` are exercised only against the harness's stubs. NAV-01 is on another branch
   (commit `b0aab2b`) and was not merged here, so this branch has never rendered inside the real shell.
2. **No server, no database, no browser-side run.** `api.mock.forms/start/list` are stubbed; the request shape
   is pinned by reading `server/mock-contract.mjs` and by matching `mock.js`, not by an HTTP call. The
   `#/lauf/<id>` route was not followed.
3. **Real form payload.** The `complete_supported_written` form DTO (`form_id`, `version`, `release_version`,
   `scope`, `item_count`, `time_limit_seconds`) is taken from `mock.js` and the datastore DTO; no released form
   was read from a live installation.
4. **Native review of the new uk/ar/tr copy is owed** (contract §8). The machine translations are authored in
   good faith and pass the structural gates, but no native speaker has checked them.
5. **Device checks.** Screenshots are emulation; no iPhone/Android keyboard, audio or screen-reader pass.
6. **The 420 px breakpoint** in `mock-intro.css` is a module-local addition beyond the design system's
   1100/860. `design-check` does not read module stylesheets, so this is asserted only by my own leg 17
   (module-scoped selectors only). A reviewer may prefer folding it into 860 px.
7. **History filter choice.** The list shows *all* saved runs (finished and still open), not only finished
   ones. The contract says "the history of finished mocks"; showing open runs keeps a resumable run reachable
   from the only route that lists them. Flagged for the reviewer; filtering to `state === 'finalised'` is a
   one-line change if the contract is read strictly.
8. **D22 scan is a curated list.** A prediction expressed with a word the list does not know would still pass;
   that is the same honest limit `i18n-register-check.mjs` documents for its own word list.

## 8. Residual risk

- **Locale source.** The module translates from the locale runtime (`getLocale()`), because the `mock.js`
  label helpers resolve the locale themselves; `ctx.language` is not used for rendering. If the shell ever
  passed a `language` that disagreed with the runtime, the runtime wins. The module re-renders on
  `subscribeLocale`, so a language switch updates it without a reload.
- **Form/table agreement.** The page states 90/30/30 minutes from the exam blueprint. If a future released
  form's `timeGroups` differed, the page would state the blueprint while the run enforced the form's schedule.
  The check pins the numbers, so the drift would be caught only if the blueprint changed in this repository.
- **Single start control.** One control is asserted; if the shell later mounts the module twice into the same
  host, two would appear. `unmount()` clears the host and removes the locale subscription, so remounting is
  safe.
- **100-run cap** on `/api/v1/mock-runs` is the server's; the page does not paginate.

## 9. Next action

Independent reviewer (not the author) verifies the diff and the evidence; the Lead integrates
`public/app/mock-intro.js`, `public/app/mock-intro.css`, `tools/mock-intro-check.mjs`,
`work/implementation/MOCK-01.md` and the 16 catalogue keys, then runs the shell against
`#/probepruefung` and follows the created run to `#/lauf/<id>`.
