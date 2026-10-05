# LIBRARY-UI-01/02 — Nachschlagen hub and guide pages (MIRROR-B1PREP-01 slices E/F)

Owner: teammate `library-ui`. Worktree `D:\Hatoove\.worktrees\library-ui-01`, branch
`codex/library-ui-01-nachschlagen`, base commit `072d29e`. Nothing pushed, nothing deployed, no
other worktree touched. Contract: `docs/contracts/MIRROR-B1PREP-01.md` §4.2, §4.3, §5 (E/F).

## Scope delivered

* **Hub** (`#/nachschlagen`): the header "N Bereiche · alles zum Lesen, nichts wird abgefragt" with
  N computed from the six area definitions, and six cards with icon, description and counts **computed
  from the served payload** (`GET /api/v1/guides` returns `section_count` per guide):
  Redemittel Sprechen (3 Teile), Briefe schreiben (19 Einträge), Fälle & Artikel (20 Einträge),
  Nomen & Genus (60 Einträge + the lexicon chip), Grammatik (14 Themen), Satzbau verstehen (Werkzeug
  chip). Kerngrammatik and the core phrases are **not** cards; both documents remain renderable by
  deep link (`#/nachschlagen/core-grammar`, `…/core-phrases`) for slice G.
* **Guide pages** for all seven guide documents: title, counts per section kind from the payload,
  "Nachschlagen, nicht abgefragt" pill, the German line first with the learner-language line beneath
  and dimmed, "← Nachschlagen" at the top and the bottom, a jump chip for **every** section (plus the
  watch-out block), a speaker button on German example lines via the existing `read-aloud.js`, and the
  eight case tables with the cells that differ from the Nominativ reference highlighted plus a legend.
* **Nomen & Genus** (`#/nachschlagen/gender-rules`): the six gender rules, forty exceptions, fourteen
  two-article words and the noun lexicon, filterable by gender (server-side closed filter) and
  searchable (server-side `q`), each noun with plural, rule, German example + speaker button, and its
  meaning in the learner's language when a translation exists.
* **Translation rendering (§4.3)**: the additive `translations` member is consumed when present
  (section title/summary/payload strings, the eight case tables' header cells, and `nouns[entry_id]`),
  every `machine_unreviewed` line or block carries "maschinell übersetzt · Prüfung ausstehend", and with
  `translations: null` a non-German page shows the German source plus **exactly one** note
  (`shell.m091`, already existing, all five locales). `en` needs no note: the authored `…En` fields
  *are* the English translation, and they are shown to an English learner only.
* **F2 key space adopted (the N2 fix — see the section below)**: the client looks up the *stored*
  translation path `<guide_id>/<section_id>.<field>` (with the store's bracket indices) as its primary
  key, keeps the older prefix-free forms as secondary fallbacks, consumes `stringStatus` per line, and
  reads the noun lexicon through the separate `nouns[entry_id]` key space.
* **Public entry point unchanged**: `guideContent(value, esc, language)` keeps working; library mode
  is a fourth, optional `options` argument, so `tools/guide-render-check.mjs` passes unmodified
  (303 real examples, 15 wrong-example labels).

## N2 fix — the translation key space (the reason no translated line rendered)

**The defect.** Slice F2 stores and serves `guide_translation.path` verbatim, and that path is the
bundle key: `<guide_id>/<section_id>.<field path>`, e.g.
`speaking-guide/telc-deutsch-b1.speaking-guide.sp1.payload.phrases[0].hint`
(`server/library-translations.mjs` `planGuideStrings` stores it, `readGuideTranslations` returns it as
`strings[path]`). This module looked up dotted, prefix-free keys (`<section_id>.payload.phrases.0.hint`)
and matched **0 of 50** requested paths on a real page. Nothing errored: the page simply stayed German,
which is indistinguishable on screen from "no translations were imported".

**The fix.** `public/app/library.js` exports `storedTranslationPath(guideId, sectionId, relative)` and
uses it first in both lookups:

| what | key space | example |
|---|---|---|
| section column | `<guide>/<section>.title` or `.summary` | `cases-guide/telc-deutsch-b1.cases-guide.bestimmter-artikel.title` |
| payload field | `<guide>/<section>.payload.<field>` with `[i]` indices | `speaking-guide/telc-deutsch-b1.speaking-guide.sp1.payload.approach[0].step` |
| case-table header | `<guide>/<section>.payload.headers[i]` | `cases-guide/telc-deutsch-b1.cases-guide.bestimmt…payload.headers[1]` |
| noun lexicon | `nouns[entry_id]` — **not** a path | `nouns["telc-deutsch-b1.noun.die-moebel"].meaning` |

Secondary fallbacks (`<section_id>.<field>`, `sections.<id>.…`, `payload.<field>`, ordinal forms) are
kept, and a check leg pins them. Per-line status reads `stringStatus[path]` (amendment A2) and falls
back to the member-level `status`; the `nouns[…]` entries carry no per-entry status, so their lines
follow the member status. Two things F2 has **no** key space for, recorded rather than invented: the
guide-level watch-out list (it lives on the `guide` row, not on a section) and the document title/intro
— those stay German-only if the bundle does not carry them.

**The leg that would have caught it** (`tools/library-render-check.mjs`, `assertRealBundleTranslation`):
it loads the real bundle, builds the served member the way `readGuideTranslations` does (keys taken from
the bundle, never from the client), and asserts that the rendered page contains the exact bundle text for
a named set of real paths — four from `speaking-guide` (title, summary, a `phrases[0]` group, an
`approach[0]` step), a grammar `payload.rule` and `payload.traps[0]`, a `cases-guide` header cell, and the
noun `telc-deutsch-b1.noun.die-moebel` (`meaning` and `example`). It also asserts the key builder's output
byte for byte, that the marker appears per line, that an `approved` member carries **no** marker, and —
the mutation proof — that the same assertions **fail** when the served key form is the pre-fix dotted
form. The fixture-bundle leg additionally pins the legacy fallback.

## Files

| File | Change |
|---|---|
| `public/app/library.js` | new — `createLibraryView(ctx)` with `{ mount(host, options?), unmount() }`; exports `LIBRARY_AREAS`, `SECTION_LABELS`, `caseHighlights`, `NOUN_PAGE_SIZE`, `storedTranslationPath` for the check |
| `public/app/library.css` | new — the module's own layer, design tokens only, no raw colour/font, no breakpoint of its own |
| `public/app/guide-content.js` | extended with library mode (German first, learner line, machine marker, speaker marks); default output byte-identical |
| `public/assets/i18n/practice-messages.js` | **shared catalogue — announced to the Lead.** 26 new `library*` keys, all five locales, formal address (see below) |
| `tools/library-render-check.mjs` | new — the focused check, including the mutation proof and the harness/serve options |
| `work/implementation/LIBRARY-UI-01.md` | this note |

### The one shared file I had to write

`public/assets/i18n/practice-messages.js` gained 26 keys in all five locales: `libraryAreasCount`,
`libraryPill`, `libraryJump`, `libraryMachineTranslated`, `libraryCountParts`, `libraryCountTopics`,
`libraryCountEntries`, `libraryCountNouns`, `libraryTool`, `libraryAllGenders`, `libraryShown`,
`libraryPartial`, `libraryCasesLegend`, `libraryLexicon`, `libraryArea*` × 6, `libraryDesc*` × 6.
Everything else reuses existing keys (m010, m057, m061, m068–m091, m267/m268/m272/m278/m282/m283/m288,
m337, m340). `i18n-register-check` R1–R10 pass. **No other slice may write that file in the same
window** — the Lead serialised this announcement.

## Commands and results

Run from `D:\Hatoove\.worktrees\library-ui-01`.

```
node tools/library-render-check.mjs
PASS library render: 6 hub areas and their payload counts, 7 guide pages with a jump chip per section,
     8 case tables marked exactly off the Nominativ reference, Arabic RTL with LTR German islands,
     one German-only note per page, the machine-translated marker, and the lexicon filter/search path.
     123 guide sections and 240 nouns through the module; ar locale left set by the last case.

node tools/guide-render-check.mjs
PASS guide semantics: 303 real examples preserved, 15 wrong examples labelled, translations and escaping checked

node tools/i18n-register-check.mjs        → 0 findings (R1–R10 PASS, 11 shipped files)
node tools/design-check.mjs               → 14 passed, 0 failed, 2 warnings (D2b monospace stack, D2c inline
                                            corner radii; both pre-existing in app.css, untouched by this slice)
node tools/repository-check.mjs           → 703 tracked files, 620 text blobs screened
node tools/retired-surface-check.mjs      → 10 passed, 0 failed
node tools/seo-check.mjs                  → 11/11 passed
node tools/server-origin-check.mjs        → 8 checks passed
node tools/keymask-check.mjs              → 14 checks passed
node tools/owned-api-check.mjs            → 34 passed, 0 failed (backend: memory)
node tools/owned-client-check.mjs         → 32 passed, 0 failed
```

`migration-eol-check` and `table-class-check` cannot run in this worktree: both import
`server/owned-postgres/provision.mjs`, which needs the `pg` package, and this worktree has no
`server/owned-postgres/node_modules` (gitignored, not installed here). They are not part of the AGENTS.md
offline baseline; `migration-eol-check` is green on a provisioned worktree, `table-class-check` needs a
disposable database. Reported rather than claimed.

### What `tools/library-render-check.mjs` asserts

Fixtures are built from `data/*.json` with the same section mapping the two migration generators use
(`build-guide-migration.mjs`, `build-writing-speaking-migration.mjs`), and the fixture section counts
are asserted against the generators' numbers (grammar 14, core-grammar 4, core-phrases 3, gender 60,
cases 20, writing 19, speaking 3; 240 nouns) so fixture drift fails here rather than silently.

1. hub: six cards in the contracted order, header count, each card's count equals its guide's
   `section_count` from the index payload, the Satzbau card links to `#/nachschlagen/satzbau`, no
   Kerngrammatik/core-phrases card, no label falling through to "Übersetzung nicht verfügbar", and the
   hub does **not** download whole guides for counts.
2. each of the seven guides: title, pill, unreviewed note, two "← Nachschlagen" occurrences, one jump
   chip per section plus a jump target per section, header counts per kind from the payload, and the
   document actually read.
3. case tables: all eight render; the marked cells equal a second, independently written implementation
   of the documented rule; the legend appears exactly when something is marked; hand-derived cell sets
   for `bestimmter_artikel` (10 marks) and `adjektivendungen_bestimmt` (7 marks); the table with no
   Nominativ reference (`praepositionen_kasus`) marks nothing.
4. Arabic: the page is RTL, 298 German islands are `lang="de" dir="ltr"`, nothing Arabic is marked LTR,
   exactly one German-only note (ar and uk), none for de/en; the authored English line appears on the
   English page and **never** on the Arabic one.
5. translations present: a section title and a payload header in the stored key form resolve, the marker
   appears once per translated block and nowhere else, an `approved` member carries none, a page **with**
   a bundle shows no German-only note, and the legacy fallback key form still resolves.
6. **the real bundle** (`assertRealBundleTranslation`, the N2 leg): the served member is built the way
   `server/library-translations.mjs` builds it, with keys taken from
   `content/library-translations/hatoove-library-translations-uk-ar-tr.json`; a named set of real paths —
   four from `speaking-guide`, a grammar `payload.rule` and `payload.traps[0]`, a `cases-guide` header
   cell, and the noun `telc-deutsch-b1.noun.die-moebel` — must appear as the exact bundle text, and the
   key builder itself is asserted byte for byte. **Mutation-proved**: with the served key form replaced by
   the pre-fix dotted form, the same assertions fail.
7. lexicon: the count comes from the payload, a list at the route's page size carries the
   "may be truncated" note, the gender filter and the search query the server (and compose), a
   one-character search queries nothing and explains the two-character minimum, and with a server that
   can serve the whole lexicon the page counts all 240 and shows each noun's meaning in the learner's
   language.

**Mutation proof** (part of every run): the shipped modules are copied to a temporary directory, the
case-table comparison is flipped and the single-note guard is removed, and a runner written against the
*correct* rule is asserted to fail **on its own assertion** (not on a load error). A check that cannot
fail is not a check.

### Rendered evidence

Screenshots (1366 px, 390 px, 320 px; light and dark; de/en/ar/tr):
`D:\Hatoove\handoff\ron-agent\library-ui-01\01…11-*.png` and, for the N2 fix, `n2-*.png`
(gitignored shared handoff).

```
01-hub-1366-light.png                        07-lexicon-390-de-server-cap.png
02-hub-1366-dark.png                         08-cases-320-light.png
03-cases-1366-light.png                      09-gender-320-ar-full-240.png
04-cases-1366-ar-rtl-machinetranslated.png   10-lexicon-1366-en-meanings.png
05-grammar-1366-ar-german-only-note.png      11-writing-1366-dark-tr.png
06-hub-390-light.png

n2-uk-cases-1366-light.png         40 real translated lines, translated table headers, 40 markers, no note
n2-uk-grammar-1366-german-only-note.png  translations=0: 0 translated lines, exactly one note
n2-ar-gender-1366-light.png        814 translated lines, RTL, 1522 explicit LTR German islands
n2-uk-cases-1366-dark.png          the same page in the pinned dark theme
n2-uk-cases-390-light.png          390 px, 40 translated lines, no page overflow
n2-ar-gender-390-light.png         390 px RTL, 814 translated lines, no page overflow
n2-uk-cases-320-light.png          320 px, translated tables scroll inside `.guide-table`, no page overflow
```

Overflow at 320 px: `document.scrollWidth === clientWidth` on the hub, the cases guide and the gender
page (de and ar), and on the translated Ukrainian pages; the case tables — including the added
learner-language header table — scroll inside their own `overflow-x: auto` wrapper, which is the
existing `.guide-table` behaviour, not page overflow.

**Standalone harness for the reviewer** (a full app server is not needed):

```
node tools/library-render-check.mjs --harness handoff/ron-agent/library-ui-01/library-harness.html --serve 4321
# then open http://127.0.0.1:4321/handoff/ron-agent/library-ui-01/library-harness.html
```

Query parameters preselect a state: `?route=cases-guide&locale=ar&nouns=50&translations=0&theme=dark`
(`nouns=50` emulates the route's page cap, `translations=0` the German-only path). The harness inlines
the seven guides, the 240 nouns **and the three served translation members built from the real bundle**,
so it needs no database or server, renders the real uk/ar/tr lines and markers, and reports a failure in
the page.

Dark mode in the screenshots is rendered by applying the pinned dark block from
`public/assets/design/hatoove.css` under `:root[data-theme=dark]`, because the available headless
browser session is read-only and `prefers-color-scheme` cannot be emulated from it. The declarations are
lifted verbatim at harness-generation time; only the selector changes.

## What was NOT verified

* **No PostgreSQL / no live server / no real `api.js` call.** Nothing was run against a real database or
  the pilot app. The translation leg builds the served member from the **real bundle** in the shape
  `server/library-translations.mjs` produces, but the HTTP round trip (`api.guides.read(guideId, locale)`
  → `?locale=` → the datastore) was not exercised here: this branch's base predates the merged `api.js`
  fix, so integration onto `main` is what makes the locale actually reach the server. The merged
  signature is `read: (guideId, locale = null) => …?locale=…` and the module already calls it that way.
* **A stale bundle is not distinguishable by the client.** Contract A2 records that the frozen member
  carries no discriminator, so "never imported" and "imported but stale" both arrive as `null`; the page
  shows the one German-only note in both cases, which is the contracted behaviour.
* **The guide-level watch-out list and the document title/intro have no F2 key.** They stay German-only
  unless a bundle chooses to carry `watch_out` / `title` / `intro` at guide level; this is recorded in the
  code and the note rather than papered over with an invented key.
* **The 240-noun lexicon could not be enumerated through the route in this worktree's base.**
  `listNouns` defaulted to `limit = 50` with no total. The Lead reports the merged route now serves the
  whole bounded corpus (240) and takes a bounded `limit`; `tools/library-render-check.mjs` proves the page
  is correct in both worlds (capped → "N angezeigt" plus the truncation note; complete → "240 Nomen").
  This branch's base still has the cap; integration onto `main` carries the fix.
* **No real device, no screen reader, no keyboard pass.** Touch-target size and RTL reading order were
  judged from rendered screenshots at three widths, not measured with a device.
* The **shell integration** (route table, `#library-host`, dynamic stylesheet injection) is the Lead's
  NAV-01 slice; I mounted into my own host and did not run the real `index.html`.

## Residual risk and integration notes

1. **Duplicate Satzbau card until integration.** Per the frozen contract the hub has six areas
   including "Satzbau verstehen"; my module therefore renders that card (linking to
   `#/nachschlagen/satzbau`). The shell's Nachschlagen markup keeps an interim Satzbau card outside my
   host, so **the Lead should drop the shell's interim card** to avoid two. I kept the contract's
   six-card hub; the header says "6 Bereiche" and counts my six cards.
2. **Route for the Satzbau card.** `ctx.navigate('#/nachschlagen/satzbau')` is the §4.1 route. If the
   shell resolves only `#/satzbau` (the Lead's note says `#/satzbau` resolves), then either the shell
   must also resolve `#/nachschlagen/satzbau`, or the single `navigate` value in `LIBRARY_AREAS` must
   change — one line, my file.
3. **Guide navigation is module-internal** (hub ⇄ guide ⇄ lexicon), so no deep-link URL is produced for
   an open guide; an incoming `#/nachschlagen/<area-or-guide-id>` *is* honoured at mount and on
   `hashchange`. If the shell wants shareable guide URLs, it must keep the sub-route in the hash; my
   module already reads it.
4. **Translation key convention (settled by the N2 fix).** The primary key is F2's stored path
   `<guide_id>/<section_id>.<field>` with bracket indices, and the older prefix-free forms
   (`<section_id>.…`, `sections.<id>.…`, `payload.<field>`, ordinal forms) are secondary fallbacks. A bare
   `title` is never applied to a section (that mistake put one string on twenty sections during
   development). `strings[path]` may be a string or `{ text, status }`; per-line status comes from
   `stringStatus[path]` (A2) with the member-level `status` as the fallback. The noun lexicon is a
   **different key space** — `nouns[entry_id]`, not a path — and carries no per-entry status, so its
   lines follow the member status. If F2 ever normalises its served keys, this client's primary lookup
   must change with it; the real-bundle leg is what fails first if that happens.
5. **Hub payload cost.** The hub makes one request (`guides.list`); a guide page makes two
   (`guides.read`, and for Nomen & Genus one `nouns.list`). No guide is fetched for the hub's counts.
6. **Content register observation (not mine to fix).** The authored guide prose in `data/*.json`
   addresses the learner informally ("Wenn du den Fall kennst …", `data/cases-guide.json` intro). That
   is authored content, not interface copy, so `i18n-register-check` does not scan it; the §7 content
   corrections should decide whether it changes with the source data.
7. **Harness dark mode** is the pinned dark block applied by attribute, not by `prefers-color-scheme`
   (see above). A reviewer with a real browser should confirm the media-query path once.
8. **Authored `…En` lines are English-only.** The language-purity rule from the earlier revision holds:
   a non-English learner never sees the authored English field; `en` needs no "Übersetzung folgt" note
   because those fields *are* its translation.
