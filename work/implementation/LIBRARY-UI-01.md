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
  (document title/intro/section title/summary/payload strings, and `nouns[entry_id]`), every
  `machine_unreviewed` line carries "maschinell übersetzt · Prüfung ausstehend", and with
  `translations: null` a non-German page shows the German source plus **exactly one** note
  (`shell.m091`, already existing, all five locales). `en` needs no note: the authored `…En` fields
  *are* the English translation, and they are shown to an English learner only.
* **Public entry point unchanged**: `guideContent(value, esc, language)` keeps working; library mode
  is a fourth, optional `options` argument, so `tools/guide-render-check.mjs` passes unmodified
  (303 real examples, 15 wrong-example labels).

## Files

| File | Change |
|---|---|
| `public/app/library.js` | new — `createLibraryView(ctx)` with `{ mount(host, options?), unmount() }`; exports `LIBRARY_AREAS`, `SECTION_LABELS`, `caseHighlights`, `NOUN_PAGE_SIZE` for the check |
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
node tools/repository-check.mjs           → 699 tracked files, 616 text blobs screened
node tools/retired-surface-check.mjs      → 10 passed, 0 failed
node tools/seo-check.mjs                  → 11/11 passed
node tools/server-origin-check.mjs        → 8 checks passed
node tools/keymask-check.mjs              → 14 checks passed
node tools/owned-api-check.mjs            → 34 passed, 0 failed (backend: memory)
node tools/owned-client-check.mjs         → 32 passed, 0 failed
```

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
5. translations present: the bundle title and a section title path resolve, each machine-translated line
   carries the marker and nothing else does, and a page **with** a bundle shows no German-only note.
6. lexicon: the count comes from the payload, a list at the route's page size carries the
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
`D:\Hatoove\handoff\ron-agent\library-ui-01\01…11-*.png` (gitignored shared handoff).

```
01-hub-1366-light.png                        07-lexicon-390-de-server-cap.png
02-hub-1366-dark.png                         08-cases-320-light.png
03-cases-1366-light.png                      09-gender-320-ar-full-240.png
04-cases-1366-ar-rtl-machinetranslated.png   10-lexicon-1366-en-meanings.png
05-grammar-1366-ar-german-only-note.png      11-writing-1366-dark-tr.png
06-hub-390-light.png
```

Overflow at 320 px: `document.scrollWidth === clientWidth` on the hub, the cases guide and the gender
page (de and ar); the case tables scroll inside their own `overflow-x: auto` wrapper, which is the
existing `.guide-table` behaviour, not page overflow.

**Standalone harness for the reviewer** (a full app server is not needed):

```
node tools/library-render-check.mjs --harness handoff/ron-agent/library-ui-01/library-harness.html --serve 4321
# then open http://127.0.0.1:4321/handoff/ron-agent/library-ui-01/library-harness.html
```

Query parameters preselect a state: `?route=cases-guide&locale=ar&nouns=50&translations=0&theme=dark`
(`nouns=50` emulates the route's page cap, `translations=0` the German-only path). The harness inlines
the seven guides and the 240 nouns, so it needs no database, and it reports a failure in the page.

Dark mode in the screenshots is rendered by applying the pinned dark block from
`public/assets/design/hatoove.css` under `:root[data-theme=dark]`, because the available headless
browser session is read-only and `prefers-color-scheme` cannot be emulated from it. The declarations are
lifted verbatim at harness-generation time; only the selector changes.

## What was NOT verified

* **No PostgreSQL / no live server.** Nothing was run against a real database or the pilot app; the
  guide payloads are the fixtures built from `data/*.json`. The server-side read path for
  `translations` (§4.3, slice F2) does not exist yet in this worktree, so the translated path is proven
  against a fixture bundle only.
* **`api.js` needs a one-line change I do not own.** The module calls
  `api.guides.read(guideId, locale)`; today `public/app/api.js` ignores the second argument, so no
  `?locale=` reaches the server and every page renders German-only. Add
  `read: (guideId, locale = null) => call('GET', PATHS.guides + '/' + encodeURIComponent(guideId) + (locale ? '?locale=' + encodeURIComponent(locale) : ''))`.
  Until then the German-only path is what the real app shows.
* **The 240-noun lexicon cannot be enumerated through the route as it stands.**
  `listNouns` defaults to `limit = 50` and `server/owned-api.mjs:1008` passes no limit, so a list
  response carries at most 50 rows, with no total and no pagination: "Alle" shows 50 of 240, and the
  page says so instead of pretending otherwise. Filtering by gender (der 96 / die 84 / das 60 — each
  above the cap) and searching are exact, so every entry is *reachable*, but the whole 240 are not
  browsable in one list. A server change outside my scope fixes it (pass `limit` up to 500 and return
  a `total`); `tools/library-render-check.mjs` already proves the page is correct when the server can
  serve all 240.
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
4. **Translation path key convention** (`strings`): `<section_id>.<relative path>` first, then
   `sections.<section_id>.…`, `<section_id>.payload.…`, `sections.<ordinal>[.payload].…`, and
   `payload.<relative>`. A bare `title` is treated as the document title and never applied to a
   section (that exact mistake put one string on twenty sections during development). Slice F2 should
   key the bundle with section ids; `strings[path]` may be a string or `{ text, status }`, per-string
   status may also arrive as `statuses[path]` / `review[path]`, and `nouns[entry_id].status` is honoured.
5. **Hub payload cost.** The hub makes one request (`guides.list`); a guide page makes two
   (`guides.read`, and for Nomen & Genus one `nouns.list`). No guide is fetched for the hub's counts.
6. **Content register observation (not mine to fix).** The authored guide prose in `data/*.json`
   addresses the learner informally ("Wenn du den Fall kennst …", `data/cases-guide.json` intro). That
   is authored content, not interface copy, so `i18n-register-check` does not scan it; the §7 content
   corrections should decide whether it changes with the source data.
7. **Harness dark mode** is the pinned dark block applied by attribute, not by `prefers-color-scheme`
   (see above). A reviewer with a real browser should confirm the media-query path once.
