# MIRROR-B1PREP-01 — bring Hatoove's structure in line with B1_Prep

**Status: FROZEN engineering contract.** Frozen by the coordinator on 5 October 2026 from Ron's
direction and the draft supplied the same day. Supersedes the proposal in
`PRACTICE-FLOW-FROM-B1PREP-20261005.md` §3 (that file is not in this repository; its §3 scope is
replaced by this document). Direction is Ron's; the implementation choices below are the
coordinator's within the authorized scope.

**Baseline:** local `main` = `origin/main` = `f3d0000` (merge of PR #151, incident closeout).
`git status` clean. Every slice branches from this commit or from `main` after an earlier slice of
this program has been integrated.

**Authority:** Ron, 5 October 2026 — *"we need to mirror the structure of the previous app more …
The Reference Library was full of useful information and easy to understand additionally the way the
lesson practices and mock exams were organized was clean and clear"*, and *"use Claude to help put
this all in place we also have hermes agent to assist create a goal to get this done"*.

---

## 1. Ron's decisions (5 October 2026)

| # | Question | Answer | Effect |
|---|---|---|---|
| 1 | Bring back the Lernplan? | **Drop it** | No Lernplan, anywhere. Heute keeps only the exam-date countdown. |
| 2 | Probeprüfung or Mocktest? | **Translate per language, default is good** | German label **Probeprüfung**; every other nav label is translated in all five interface languages. New keys go through the same native review as existing copy. |
| 3 | Practice selection rule and play limits | **Go with the proposal** | Unseen sets first, then most wrong items, then oldest. Practice listening uses the exam play rule with a replay only after "Auswerten". |
| 4 | Translate the guides into uk/ar/tr? | **Generate them** | Done offline on 5 Oct (bundle ingested in this repo). Native review precedes removal of the "machine-translated" marker. |

Verbatim constraints that also stay in force:

> "for each module look at the b1_prep the presentation of the tests was more fluid you select a
> section and what we have in the database for that lesson is presented not every option available.
> Mock tests and practice are two different things"

> "if reviewing the questions the whole question and options need to be given otherwise its
> pointless as well naturally the reasoning"

## 2. Constraints that this program does not undo

- **No forecast, no pass prediction, no readiness score** (D22).
- **No Lernplan** (decision 1).
- **No Sprechen** in the pilot; the mock intro keeps B1_Prep's note that the oral exam is not part
  of it. Speaking guide material stays reference-only.
- **No live AI generation** (D10). "Neu generieren" becomes "Noch ein Satz", drawn from the released
  pool.
- **Hatoove brand, colours and type stay** (REDESIGN-01). We mirror structure and behaviour, not
  Certa's blue look.
- **Five interface languages** (de/en/uk/ar/tr). Exam content stays in German; operational
  directions additionally show the selected-language translation. Arabic interface is RTL with
  explicit LTR islands for German content.
- **Applied migrations are frozen.** Production has applied `0001`–`0041` with the checksums in
  `server/migrations/MANIFEST.json`. A corrective content change therefore ships as a **new**
  migration; never rewrite an applied file's bytes.
- **A reviewer must not be the author** of the slice under review.
- **No production operation, no DNS change, no live payment key, no deployment** without Ron's
  explicit authorization. Building and testing locally is authorized.

## 3. Evidence and repo reality

Both apps were run side by side on 5 Oct (17 B1_Prep and 13 Hatoove screens captured; copies in
`handoff/ron-agent/library-evidence/`, untracked). The content is already in Hatoove:

| Content | Count | Where it lives |
|---|---|---|
| Guides | 7 | `data/*.json` → `server/migrations/0013-guide-library.sql` |
| Guide sections | 123 | `guide_section` |
| Nouns | 240 | `data/noun-lexicon.json` → `server/migrations/00xx` noun build |
| Vocabulary entries | 300 | `data/vocab.json` |
| Objective sets (telc B1) | 25 (local), 34 `objective_set` rows in production, release head `v2` | objective build |

The guide payloads still carry the English fields (`noteEn`, `ruleEn`, …) and the full tables.
**What was lost is presentation and organisation** — this program is mostly client and
information-architecture work. The only schema work is slice F2 (translation storage) and slice C
(practice attempts).

Client today: `public/app/` — `index.html`, `app.js` (1877 lines, all views + route table `VIEW_TITLES`
at line 76, `route()` at line 1536), `app.css`, `guide-content.js` (guide renderer, export signature
`guideContent(value, esc, language)`), `preparation.js`, `mock.js`, `listening.js`, `explanations.js`,
`review-labels.js`, `read-aloud.js`, `writing.js`, `checkout.js`, `sentence-check.js`, `api.js`,
`locale-preference.js`. Catalogues: `public/assets/i18n/{shell,practice,public,auth}-messages.js`,
`instructions.js`, `core.js`.

Server routes today (all under `/api/v1`, in `server/owned-api.mjs`): `guides`, `nouns`, `vocab`,
`practice/next`, `practice/progress`, `practice/mistakes`, `mock-forms`, `mock-runs`, `preparations`.
The practice endpoints already exist; slice C extends them rather than inventing them.

Checks: the AGENTS.md offline baseline (`repository-check`, `design-check`, `retired-surface-check`,
`seo-check`, `server-origin-check`, `keymask-check`, `owned-api-check`, `owned-client-check`,
`i18n-register-check`) plus `package.json` `check` / `check:db`. Guide rendering already has
`tools/guide-render-check.mjs`.

## 4. Frozen interfaces

These are frozen for the program. Changing one is a contract amendment, recorded in §8, not a
slice-local decision.

### 4.1 Routes and information architecture (slice A)

Sidebar groups and entries — the only entries the sidebar may show:

| Group | Entries (route) |
|---|---|
| **Mein Lernweg** | Heute `#/heute` · Einzelübungen `#/ueben` · Wortschatz `#/wortschatz` · Fehlerheft `#/fehler` |
| **Prüfungstraining** | Prüfungsteile `#/pruefungsteile` · Hören `#/hoeren` · Schreiben `#/schreiben` · Probeprüfung `#/probepruefung` |
| **Werkzeuge** | Nachschlagen `#/nachschlagen` · Einstellungen `#/einstellungen` |

- Topbar carries breadcrumb `Deutsch B1 / <group>` plus the page title on every view.
- `#/satzbau` moves under Nachschlagen (`#/nachschlagen/satzbau`); the top-level entry disappears.
- Fortschritt folds into Heute: `#/fortschritt` → `#/heute`.
- Prüfungsläufe becomes the history inside Probeprüfung and Prüfungsteile: `#/abschnitt` →
  `#/pruefungsteile`.
- `#/lesen` and `#/sprachbausteine` keep resolving as deep links into Prüfungsteile; they leave the
  sidebar. `#/woerterbuch` → `#/wortschatz`.
- **No dead nav entries.** A sidebar entry ships together with a view that renders something real.
  Until B/D/G land, a new route renders the interim view named in §5.
- The `section.preparation-context` card ("Ihre Vorbereitung", `index.html` line 117) renders on
  **Heute only**. The writing-feedback allowance moves to Schreiben.

### 4.2 Client view modules

`app.js` keeps the route table, the shell and the topbar. **New view code goes into new modules** so
that one file never has two writers:

```js
// public/app/<name>.js
export function create<Name>View(ctx) { return { mount(host), unmount() }; }
// ctx = { api, uiText, esc, language, navigate, state, guideContent }
```

The shell owns `<section class="view" id="view-<route>">` in `index.html` and mounts the module into
that section lazily. A module owns every byte inside its own section and its own new CSS file. The
shell loads a module with a dynamic `import()` guarded by a `try/catch` so a missing module
degrades to the interim view instead of breaking the route.

Module allocation: `library.js` (E/F), `mock-intro.js` (D), `part-runner.js` (C client),
`drill.js` (H), `vocab.js` (G).

### 4.3 Library translation read path (F2 → E)

Additive only; existing consumers of `GET /api/v1/guides` and `…/guides/:id` must not change shape.

- `GET /api/v1/guides/:id?locale=<l>` gains an optional `translations` member:
  `{ locale, guideVersion, status, stringStatus: { "<path>": "<status>" }, strings: { "<path>": "<text>" },
  nouns: { "<entry_id>": { meaning, example, rule } } }`
  (`stringStatus` added by amendment A2: §4.3 requires per-string review status and the original member
  list had no slot for it. `status` is the bundle marker, `statusText` per line is the client's job.)
- When a locale has no imported, non-rejected bundle, `translations` is `null` and the client renders
  German only with one "Übersetzung folgt" note per page. A **stale** bundle also answers `null`; the
  frozen shape carries no discriminator, so never-imported and imported-but-stale are indistinguishable
  through this API for now (recorded limitation, A2).
- Per-string review status is exposed so the client can mark `machine_unreviewed` lines:
  `"maschinell übersetzt · Prüfung ausstehend"`.
- Translations attach to the guide version they were generated from (`…@v1`). A new guide version
  makes them stale; stale bundles are not served as current.

### 4.4 Storage (F2)

Modelled on `0040-explanation-review`:

- `guide_translation(guide_id, section_id, path, locale, text, review_status, reviewer, reviewed_at, source_content_version)`
- `noun_translation(entry_id, locale, meaning, example, rule, review_status, reviewer, reviewed_at, source_content_version)`
- `review_status ∈ {machine_unreviewed, approved, rejected}`; default `machine_unreviewed`.
- Importer + review workflow; nothing is marked approved by an agent.

### 4.5 Migration numbering (reserved)

`0042` library translations (F2) · `0043` content corrections (§7) · `0044` practice attempts (C) ·
`0045+` later slices. `server/migrations/MANIFEST.json` is a shared file: each slice appends only its
own entry, computed with the same sha256 the migrator uses; the Lead resolves any append conflict at
integration and never rewrites an existing line.

### 4.6 i18n

Every new interface string is registered in the catalogue for **all five locales** in the same
commit; German is authored, the other four are translated in the same pass. `tools/i18n-register-check.mjs`
(the eight legs) is a gate for every client slice. No new informal address.

## 5. Slices, owners and acceptance

Owners are leases, not titles. Each slice runs in its own git worktree on branch
`codex/<task-id>-<description>`, writes only its listed scope, and is independently reviewed before
integration.

### Round 1 (parallel)

#### A · NAV-01 — information architecture — owner: **Lead**
**Scope:** `public/app/index.html`, `public/app/app.js`, `public/app/app.css`,
`public/assets/i18n/shell-messages.js`, `tools/nav-ia-check.mjs` (new), `work/implementation/NAV-01.md`.

- Sidebar groups, labels and topbar breadcrumb exactly as §4.1.
- Route table and redirects as §4.1, including `#/nachschlagen/satzbau`.
- `preparation-context` card restricted to Heute.
- Interim views for `#/pruefungsteile` (today's skill chooser), `#/probepruefung` (today's
  Prüfungsläufe/history), `#/wortschatz` (today's Wörterbuch), each labelled as interim in the
  implementation note.
- Shell hooks for the §4.2 modules with graceful degradation, and `<link rel="stylesheet" href="library.css">`
  plus `<link rel="stylesheet" href="mock-intro.css">` so module-owned stylesheets load without
  another `index.html` writer.
- **Acceptance:** every old and new route resolves; old hashes redirect; every nav label exists in
  all five locales; `i18n-register-check` and `design-check` pass; rendered evidence at 1366 and
  390 px in both themes; no overflow at 320 px.

#### F2 · LIBRARY-I18N-01 — import the uk/ar/tr translations — owner: **teammate `library-i18n`**
**Scope:** `server/migrations/0042-*.sql`, its `MANIFEST.json` entry,
`server/library-translation*.mjs` (new), importer in `tools/` (new), `tools/library-i18n-check.mjs`
(new), `content/library-translations/**`, `work/implementation/LIBRARY-I18N-01.md`.

- Storage and read path per §4.3 and §4.4; importer reads the ingested bundle; idempotent re-import.
- Never marks anything approved; preserves `machine_unreviewed`.
- **Acceptance:** disposable PostgreSQL (Docker) applies the migration from an empty database and
  from a `0041`-head database; import is byte-idempotent; a rejected string is not served; a stale
  version is not served as current; `owned-api-check` passes; a focused check proves the German
  example sentences inside translations are unchanged.

#### E/F · LIBRARY-UI-01/02 — Nachschlagen hub and guide pages — owner: **teammate `library-ui`**
**Scope:** `public/app/guide-content.js`, `public/app/library.js` (new), `public/app/library.css`
(new), `tools/library-render-check.mjs` (new), `work/implementation/LIBRARY-UI-01.md`.

- Hub: header "N Bereiche · alles zum Lesen, nichts wird abgefragt" and **six cards**, each with an
  icon, a description and counts computed from the payload — Redemittel Sprechen (speaking-guide),
  Briefe schreiben (writing-guide), Fälle & Artikel (cases-guide), Nomen & Genus (gender-rules +
  noun lexicon), Grammatik (grammar-guide), Satzbau verstehen (the existing Satzbau tool).
- Guide pages: title + counts + "Nachschlagen, nicht abgefragt" pill; German line first with the
  learner-language line beneath and dimmed; jump chips for every section; case tables highlight the
  cells that differ from the Nominativ row plus a legend (computed client-side, all 8 tables);
  speaker button on German example lines; "← Nachschlagen" at top and bottom.
- Nomen & Genus: rules, exceptions, two-gender words, and the 240-noun lexicon filterable by gender
  and searchable, each noun showing its meaning in the learner's language.
- Kerngrammatik and core phrases leave this hub for Wortschatz (slice G).
- **Acceptance:** `guide-render-check` still passes with the unchanged `guideContent(value, esc, language)`
  signature; rendered checks at 1366 and 390 px in both themes; highlight works on all 8 tables; no
  overflow at 320 px; Arabic lines RTL with German fragments kept LTR; with `translations: null` the
  page shows German only plus exactly one "Übersetzung folgt" note.

#### D · MOCK-01 — Probeprüfung intro — owner: **teammate `mock-intro`**
**Scope:** `public/app/mock-intro.js` (new), `public/app/mock-intro.css` (new),
`tools/mock-intro-check.mjs` (new), `work/implementation/MOCK-01.md`.

- Intro page: block table (Leseverstehen + Sprachbausteine 90 min · Hörverstehen 30 min · Schreiben
  30 min), total points, the official pass rule stated as a fact and not a prediction, and the note
  that the oral exam is not part of it.
- One start button for `complete_supported_written`; the history of finished mocks below.
- The existing run machinery is unchanged.
- **Acceptance:** the start button issues today's unchanged run request; no readiness/prediction
  wording; rendered evidence at 1366 and 390 px in both themes; the module degrades to today's view
  when the shell cannot import it.

### Round 2 (after A integrates)

- **B · PRACTICE-UI-01** — Prüfungsteile and Hören tiles (one tile per part with released content,
  official label, items, points, play rule, and the learner's own count "x Aufgaben geübt · y
  richtig"). No per-set cards.
- **C · PRACTICE-01** — server selection rule and practice attempts, then the part runner client
  (whole part on one page, single "Auswerten", full review with all options, then **Noch ein Satz ·
  Fehler üben · Zur Auswahl**; listening wraps with "Alle Sätze dieses Teils geübt — von vorn").
- **Content corrections** — the three source defects in §7, as `data/*.json` fixes plus migration
  `0043`.
- **POOL-01** — released-set inventory per part and a reviewed offline batch proposal. Needs Ron's
  go-ahead before any batch is generated.
- **G · VOCAB-01** and **H · DRILL-01** follow C.

## 6. Evidence and gates for every slice

1. `node tools/repository-check.mjs` and the AGENTS.md offline baseline relevant to the slice.
2. The slice's own focused check, added as a `tools/*-check.mjs` leg and mutation-proven where it
   guards a defect class.
3. Rendered evidence at 1366 px and 390 px, both themes, plus a 320 px overflow check for layout
   slices.
4. A written implementation note in `work/implementation/<TASK-ID>.md`: scope, files, checks run with
   their output, what was not verified, and residual risk.
5. An independent review by a different agent or by Hermes, recorded in
   `handoff/ron-agent/`. Delivered ≠ reviewed ≠ merged.
6. Integration by the Lead only, after the review, with the diff and the final test run inspected.

## 7. Source-data defects to correct (found while translating)

1. `das Familiemitglied` → `das Familienmitglied`. Present in `data/noun-lexicon.json`.
2. `die Möbel` is glossed as the singular "piece of furniture"; `die Möbel` is plural and the singular
   is `das Möbelstück`. The current example sentence ("Dieses Möbel passt …") is wrong German.
3. The speaking guide teaches Teil 1 as a three-minute **presentation**. The official telc B1 Teil 1
   is getting to know each other (`exam-product-review.md`). Reference-only in the pilot, but it
   teaches the wrong task and must be corrected before the guide is presented as authoritative.

Corrections ship as `data/*.json` edits **and** a new migration `0043`, because `0013` is applied in
production and its checksum is frozen.

## 8. Amendments and open items

- **A1 (5 Oct 2026, POOL-01 inventory).** The evidence table's "Objective sets (telc B1): 25" and the
  note "SB1 has 4" are corrected: `data/seed.json` carries **24 sets, 8 parts × 3**, SB1 included
  (`work/implementation/POOL-01-INVENTORY.md`, measured from the source of truth rather than from a
  running database). The production `objective_set` row count of 34 spans exam packages and is not the
  telc B1 per-part set count. Every part therefore has released content and gets a tile in slice B; C's
  wrap rule stands at three sets per part.
- **A2 (5 Oct 2026, F2 read path).** `stringStatus` is part of the `translations` member: §4.3 requires
  per-string review status and the original five-member list had no slot for it. Accepted, not a slice
  deviation. The same amendment records that a stale bundle and an absent bundle both answer
  `translations: null`, so the API cannot currently distinguish never-imported from imported-and-stale.
- **A3 (5 Oct 2026, slice D).** The ctx object in §4.2 gains one optional member, `examLanguage`, so a
  module can label authored exam-language text (`lang`/`dir`) the way `mock.js` already does. Absent, a
  module falls back to `lang="und" dir="ltr"`; nothing may require it. The shell passes
  `getExamLanguage()` for every module from integration onwards.
- **A4 (5 Oct 2026, slice A review).** Three readings are recorded after REVIEW-NAV-01:
  (a) bare `#/abschnitt` resolves to **`probepruefung`**, not `pruefungsteile` as §4.1's bullet says,
  because the saved-runs list is the Probeprüfung history surface and slice D carries it there; every
  in-app link was retargeted so nothing depends on the redirect.
  (b) The flat `#/satzbau` stays the **canonical** address for the Satzbau tool; `#/nachschlagen/satzbau`
  resolves as the deep link that §4.1 wants, and the shell's saved-URL writer keeps the `#/prep/<id>/<view>`
  shape. Satzbau is still reached from Nachschlagen and is no longer a sidebar entry.
  (c) §4.1's "the writing-feedback allowance moves to Schreiben" is implemented literally: the allowance
  element lives in the Schreiben view, and the preparation card names where it went.
  Two scope notes: `public/app/mock.js` entered slice A's scope at review time (three link targets), and the
  §4.2 module context table is unchanged by this amendment.
- **A5 (5 Oct 2026, slice D review).** Two readings are recorded after REVIEW-MOCK-01:
  (a) The Probeprüfung history lists **all** saved runs, finished and still open, not only finalised ones —
  the interim renderer it replaces already listed them unfiltered, and the run list is the only surface
  from which a resumable run is reachable.
  (b) The D22 wording gate is a curated word list, and the reviewer proved a plain prediction
  ("Sie werden die Prüfung sicher bestehen.") passes it. The rule paragraph is therefore treated as
  authoring-reviewed copy, not as machine-guarded, and the follow-up is to extend the gate with phrase
  forms (`werden … bestehen`, `schaffen Sie`, `Bestanden?`, `voraussichtlich`) and to route the paragraph
  through the same native review as the other interface copy. No prediction ships today.
  A3 is now honoured in code: the shell passes `examLanguage` to every module (REVIEW-MOCK-01 D1 found it
  missing, which had rendered exam-language islands as `lang="und"`).
- **A6 (5 Oct 2026, slice B data sourcing).** The slice-B author proved, with file/line evidence, that
  four of the five facts a tile must show were **not reachable from any served payload**: the
  objective-sets list filters `media_required = false` so it can never contain HV1–HV3; the mock-forms DTO
  carries no per-part breakdown; no served source carries per-part points; and practice progress groups by
  section (LV/SB/HV) rather than by part. Sourcing is therefore fixed as:
  (a) items, section/part, item count and the HV play rule come from a new read-only
  `GET /api/v1/exam-parts?examId=…`, assembled from the blueprint the server already holds
  (`exam_blueprint.payload`, `listening-package.json`);
  (b) per-part own-counts come from the existing practice-progress result extended with
  `parts: [{family, attempts, correct}]` over `item_evidence.family`;
  (c) per-part **points** are a documented client constant citing `docs/exam/telc-b1-written-draft.json`
  and `docs/exam/TELC-B1-SOURCES.md` §4 (25/25/25 for lv-t1…hv-t3, 15/15 for sb-t1/t2), and the module
  prefers a served value when one exists. Follow-up owed: move per-part points into the packaged blueprint
  at its next revision so the client constant can be deleted;
  (d) no migration and no MANIFEST line are involved — the data already exists.
  The same amendment records the Hören entry point: `#/hoeren` mounts the same part-index module into
  `#hoeren-host` and the module keys its filter off the host it is given, so "Hören is Prüfungsteile
  filtered to HV" stays one implementation with two entry points and the ctx interface is unchanged.
- **A7 (5 Oct 2026, slice G).** §5's G entry is a stub ("G · VOCAB-01 and H · DRILL-01 follow C"). The
  sentence the slice was leased against — "Prüfungskern first, then the general 300-word deck; ship
  browse-by-block first; spaced repetition comes later" — was the coordinator's elaboration, now
  ratified here as G's scope: the **Prüfungskern** (`core-grammar` 4 blocks / 125 items and
  `core-phrases` 3 blocks / 130 items) rendered first as reference blocks with a chip per block and its
  own payload count, then the **300-word deck** browsable by part of speech and searchable, with the
  authored English gloss on the English page only. **Spaced repetition is out of this slice** and no
  per-item state exists in the payload for it. The same amendment records that the two core corpora
  **move out of the library** into Wortschatz, which §5 E/F implies: the Nachschlagen hub keeps its six
  cards for the other guides, `public/app/library.js` no longer renders or fetches the two core
  corpora, and a deep link to either hands over to `#/wortschatz`.
- **A8 (5 Oct 2026, table-header translation).** Where a translated table header exists, the guide page
  renders the German table first and a dimmed translated-header table beneath it, rather than
  substituting the translated header for the German one. The German source is never replaced by its
  translation (§4.3's "German text first" applies to tables too).
- `PRACTICE-FLOW-FROM-B1PREP-20261005.md` was not found in this repository or in
  `D:\B1_Prep\Claude outputs`; §3 of that document is superseded by §5 here.
- Push/PR policy for this program: slices are committed to their own local branches and integrated
  locally by the Lead. Nothing is pushed, deployed or charged without Ron's explicit go-ahead.
- Native review of the new uk/ar/tr interface copy and of the guide translations is **owed**. Until
  it happens, translations render with the "maschinell übersetzt · Prüfung ausstehend" marker and no
  string is marked approved.
- POOL-01 batch generation needs Ron's go-ahead.

*Amendment log: v1 frozen 5 October 2026 by the coordinator; A1–A8 added 5 October 2026.*
