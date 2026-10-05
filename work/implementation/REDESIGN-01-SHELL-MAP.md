# REDESIGN-01 slice B — shell + pinned-token implementation map

B0 recon, 2026-10-05, teammate `shell-recon` (task-2). Read-only: this note changes nothing.
Scope: restyle the vanilla learner shell under `public/app/` — re-pointed palette, navy sidebar, larger
menu type, grouped nav + Lucide icons, exam card with a large "B1", orange "Weiter üben".

Two stylesheets matter. `public/assets/design/hatoove.css` is **PINNED**: 21210 bytes, sha256
`36af5c8f190b37008d35fc954515c3503658a052ca2c29ae9963d701ccca2fdc`, pinned in
`work/implementation/DESIGN-REFERENCE-MANIFEST.json:33-36` — do not edit. `public/app/app.css` (470 lines)
is the shell's own editable layer. `public/app/index.html:8-11` loads pinned first and `app.css` last, so
`app.css` overrides win by order.

## 1. Pinned token inventory (`public/assets/design/hatoove.css`)

Light block `:root` L6-16; dark overrides are duplicated in L17-25
(`@media (prefers-color-scheme:dark)` → `:root:not([data-theme=light])`) and L26-32 (`:root[data-theme=dark]`).

| token | light (L7-15) | dark (L19-31) |
|---|---|---|
| `--orange` | `#ff6b2b` | *not redefined* |
| `--orange-dark` | `#bd3c0a` | `#ff8a57` |
| `--orange-ink` | `#23160f` | *not redefined* |
| `--peach` | `#fff0e7` | `#2c1d15` |
| `--peach-line` | `#f3dccd` | `#4a3022` |
| `--ink` | `#242320` | `#f2f0ec` |
| `--ink-2` | `#414039` | `#d9d6d0` |
| `--muted` | `#62615c` | `#aaa69e` |
| `--faint` | `#8a8984` | `#85827b` |
| `--line` | `#e8e7e3` | `#34322e` |
| `--paper` | `#fff` | `#181715` |
| `--canvas` | `#faf9f6` | `#12110f` |
| `--card` | `#fff` | `#1e1d1a` |
| `--green` / `--green-bg` | `#225b44` / `#e8f2ec` | `#7fcfa4` / `#16271e` |
| `--amber` / `--amber-bg` | `#8a5a00` / `#fff4dc` | `#f0c060` / `#2b2310` |
| `--red` / `--red-bg` | `#a3271b` / `#fdecea` | `#f2938a` / `#2e1714` |
| `--display` | `"Bricolage Grotesque","Source Sans",system-ui,sans-serif` | unchanged |
| `--font` | `"Source Sans",system-ui,sans-serif` | unchanged |
| `--r-sm` / `--r` / `--r-lg` / `--r-xl` | `8px` / `12px` / `18px` / `24px` | unchanged |
| `--shadow` | `0 1px 2px #2423200a,0 8px 24px #6c33100d` | `0 1px 2px #0006,0 8px 24px #0004` |

Which file may be edited, and why (all in `tools/design-check.mjs`):

* Token definitions exist **only** in the pinned file: `app.css` defines none (`grep '^\s*--' public/app/app.css` → no match).
* D1 scans `app.css` only (`:62,72-83`) and **exempts token-definition lines** (`:80`), so a new palette
  value is legal in `app.css` only as `--token:<raw value>;` then `var(--token)`.
  `background:#0b1f33` in a rule fails D1; `--navy:#0b1f33` + `var(--navy)` passes.
* D3 builds `defined = pinned ∪ app.css` (`:103-105`); D4's required list is checked against that union
  (`:111-115`), not against the pinned file alone.
* Editing the pin breaks `tools/design-assets-check.mjs` D2 (digest compare `:109-117,190-200`) and
  `tools/app-browser-check.mjs` P0b (re-hashes the served copy `:327-346`).

## 2. Sidebar and navigation (`public/app/index.html`)

Chain L46-81: `<aside class="side">` → `<picture>` logo L46-49 → `.exam-pill` L52-55 →
`<nav class="nav" aria-label="App" data-i18n-aria-label="shell.m382">` L57-72 → `.side-foot` L74-80.
**Navigation is already grouped** by `.kicker.nav-label` headings: unlabelled group L58-62; "Lernen"
(`shell.m305`) L63; L64-69; "Konto" (`shell.m306`) L70; L71.

| `data-view` | href | de label | i18n key | where |
|---|---|---|---|---|
| `satzbau` | `#/satzbau` | Satzbau | `shell.m303` | sidebar L58; card L314 |
| `heute` | `#/heute` | Heute | `shell.m007` | sidebar L59; tabbar L451 |
| `fortschritt` | `#/fortschritt` | Fortschritt / Verlauf | `shell.m012` sidebar / `shell.m379` tabbar | sidebar L60; tabbar L451 |
| `fehler` | `#/fehler` | Fehler | `shell.m011` | sidebar L61 (+`#mistake-count`); card L320 |
| `abschnitt` | `#/abschnitt` | Prüfungsläufe | `shell.m304` | sidebar L62 |
| `lesen` | `#/lesen` | Leseverstehen | `shell.m002` | sidebar L64; card L315 |
| `sprachbausteine` | `#/sprachbausteine` | Sprachbausteine | `shell.m003` | sidebar L65; card L316 |
| `hoeren` | `#/hoeren` | Hörverstehen | `shell.m004` | sidebar L66; card L317 |
| `schreiben` | `#/schreiben` | Schreiben | `shell.m005` | sidebar L67; tabbar L451 |
| `woerterbuch` | `#/woerterbuch` | Wörterbuch | `shell.m009` | sidebar L68; card L318 |
| `nachschlagen` | `#/nachschlagen` | Nachschlagen | `shell.m010` | sidebar L69; card L319 |
| `einstellungen` | `#/einstellungen` | Einstellungen / Konto und Einstellungen | `shell.m013` / `shell.m352` | sidebar L71; card L321 |
| `ueben` | `#/ueben` | Üben | `shell.m008` | tabbar L451 only (not in sidebar) |
| `mehr` | `#/mehr` | Mehr | `shell.m014` | tabbar L451 only |
| `checkout` | `#/checkout` | Pass freischalten | `shell.m016` | card L324 only |

The phone tabbar is one line, L451 (`<nav class="tabbar" …>`): `heute`, `ueben`, `schreiben`,
`fortschritt`, `mehr`. `#view-mehr` cards L314-324 hold 9 `data-view` links.

Menu text sizes come from the pinned file: `.nav a{…font-size:15px…}` L98 (also `min-height:44px`,
`gap:12px`, `border-radius:10px`, `color:var(--ink-2)`, `font-weight:600`); group labels use pinned
`.kicker` (`font-size:11px`, uppercase) L67 plus `.nav-label{margin:16px 12px 4px}` L102;
`.nav a .count` L101; hover `background:var(--canvas)` L99; current item
`background:var(--peach);color:var(--orange-dark)` L100. "Larger menu type" is an `app.css` override of
`.nav a` / `.nav-label`; the pinned values cannot be edited.

## 3. Exam card and the "B1"

Exam identity is bound in `app.js:216-221`: `label = prep.exam || state.exams…exam || prep.exam_id` →
`bindShellText(el('sidebar-exam'))` L220, `el('preparation-exam')` L221. Three candidate cards:

1. Sidebar pill `index.html:52-55` (`#sidebar-exam`, `#exam-countdown`). Pinned `.exam-pill` L94
   (`background:var(--peach)`, `1px solid var(--peach-line)`, `border-radius:var(--r)`, padding 12px),
   `.exam-pill strong{font-size:14px}` L95, `.exam-pill span{font-size:13px;color:var(--muted)}` L96.
2. Dashboard card `index.html:159-164`, `class="card" aria-labelledby="exam-title"`; `#exam-title` =
   `shell.m322` "Nächste Prüfung"; `#countdown` L161. Pinned `.card` L78 (`var(--card)`,
   `1px solid var(--line)`, `var(--r-lg)`, 22px, `var(--shadow)`).
3. Dashboard hero `index.html:130-137`, `class="card-peach hero-next"` (pinned `.card-peach` L80,
   `.hero-next` L121, `.hero-next h2{font-size:1.6rem}` L122), CTA `a.btn.btn-primary` L136.

No "B1" literal is authored in `index.html`; the exam name arrives from account/exam data, so a large "B1"
is new markup. Removing `#sidebar-exam` / `#preparation-exam` / `#exam-countdown` / `#countdown` /
`#page-title` / `#mistake-count` breaks `app.js:220-221,509-518,799-809`.

## 4. Continuation control ("Weiter üben")

The string "Weiter üben" **does not exist anywhere in the repo** (whole-repo search: only unrelated
marketing prose at `public/index.html:97` / `public/assets/i18n/public-messages.js:84`, and a research
fixture at `research/mistral-feasibility/run-v2.mjs:180`). There is no i18n key for it. Existing controls:

* `#preparation-continue`, `index.html:111`, `class="btn"` (not orange), `shell.m312` "Gespeicherte Texte
  fortsetzen"; `app.js:225` sets `href = '#/prep/' + prep.id + '/fortschritt'` — the closest "continue" control.
* `#preparation-start`, `index.html:111`, `class="btn btn-primary"`, `shell.m311` "Abschnitt üben";
  `app.js:226-227` hides it unless a preparation is active.
* Hero CTA `a.btn.btn-primary` → `#/ueben`, `index.html:136`, `shell.m008` "Üben".
* `a.card-peach.more-link` → `#/abschnitt`, `index.html:190`, `shell.m326`.

Pinned orange: `.btn-primary{background:var(--orange);color:var(--orange-ink)}` L52, hover
`background:#ff824d` L53 (raw value legal only because it is pinned); `.btn` base L51. An orange
"Weiter üben" is `class="btn btn-primary"` plus a new five-language key.

## 5. Icon system

Used today: inline, hand-authored SVG — `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">` with
`<path>`/`<circle>`/`<rect>`. Locations: sidebar links `index.html:58,59,60,61,62,64,65,66,67,68,69,71`;
topbar `:103`; dashboard hint `:151`; tabbar `:451`. Pinned `svg.i` `hatoove.css:48`: 20×20, `fill:none`,
`stroke:currentColor`, `stroke-width:1.8`, round caps/joins — Lucide-shaped, but stroke 1.8, not 2.

**No icon library is loaded or vendored.** `package.json:21` is `"dependencies": {}`; `lucide`, `feather`
and `heroicons` do not occur anywhere in `D:\Hatoove`; `public/` has no sprite, no `<use>` and no
`icons.js` (the `icons.js` files that exist are recovery copies under `.qa/migration/…`, not the live
tree). Slice B must vendor a Lucide subset/sprite (new file + licence) or paste Lucide paths inline as
`<svg class="i">`. Nothing can be imported today.

## 6. Check assertions that police slice B

### `tools/design-check.mjs` (reads pinned `:47`, app.css `:48`, index.html `:49`, app.js `:50`)

* **D1** `:72-96` — raw-colour regex `/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/` (`:81`) over `app.css`
  values; token definitions exempt (`:80`); comments skipped (`:78`). **D2** `:84-98` raw `font-family`;
  **D2c** `:93,99` inline `border-radius` → WARN only.
* **D3** `:103-107` every `var(--t)` in app.css defined in pinned ∪ app.css. **D4** `:111-115` required:
  `--orange`, `--orange-dark`, `--peach`, `--ink`, `--paper`, `--canvas`, `--card`, `--line`, `--muted`,
  `--red`, `--red-bg`, `--display`, `--font`, `--r-sm`, `--r`. **D4b** `:116` pinned keeps
  `prefers-color-scheme:dark`. **D4c** `:125-135` the app.css reduce block (`app.css:60-69`) must
  neutralise duration while pinned animates (`hatoove.css:51`).
* **D5** `:139-142` pinned keeps `max-width:1100px` (`:261`) and `860px` (`:265`). **D5b** `:143-146`
  `app.css` may contain **only** those two as `max-width` breakpoints — today 860 only, at
  `app.css:96,348,371,460`. A 900 px breakpoint fails.
* **D6** `:150-156` every key of `VIEW_TITLES` (`app.js:76-83`: abschnitt, heute, ueben, woerterbuch,
  nachschlagen, lesen, sprachbausteine, hoeren, schreiben, fehler, fortschritt, einstellungen, mehr,
  satzbau, checkout = 15) needs `id="view-<key>"` (15 today, `index.html:118-356`).
* **D7** `:160-163` every `data-view="X"` must be one of those 15. **D7b** `:164-168` **every `<nav>` in
  index.html must contain a `data-view=` link** — a new `<nav>` holding only `href` group links fails.
  **D7c** `:169` `app.js` must still contain `aria-current`.

### `tools/shell-locale-check.mjs` — reads `public/app/app.js` only

All `readFile` targets are app.js (`:119,174,184,202,215,231,248`); it never reads index.html or app.css,
so a pure index.html/app.css restyle cannot break it, while an app.js edit can.

* **`:28-36`**: `shellMessages` (de `shell-messages.js:4`, en `:439`, uk `:874`, ar `:1309`, tr `:1744`)
  must have identical key sets and `{param}` names in all five, and `>400` keys (`:29`). A new
  "Weiter üben" key must be added to **all five**.
* **`:224`** exact assertion pinning the answer button:
  `assert.match(html,/data-answer="a">a\) Original English answer/);`. It pins the output of
  `renderObjectiveForm` (`app.js:1064`), whose options are rendered at `app.js:1091-1092` as
  `data-answer="<id>"><id>) <label>`. An icon or span inserted between `>` and `a)`, or a changed `a)`
  prefix, breaks it; also `:222` `lang="en" dir="ltr">Original English question?`.
* `:176` `updateLocaleLabels` still calls `writing|mock|explanations|readAloud|checkout .updateLocale`;
  `:177` no `api.`/`renderSettings(`/`route(`/`innerHTML =`; `:178` settings write signature; `:179`
  `instructionMarkup\(\{ id: form\.interaction`; `:180` `const view = VIEW_TITLES[key] ? key : 'heute'`
  (`app.js:1462`); `:181` no `esc(… || messageMarkup`; `:198` `data-i18n="shell.m072"` +
  `data-authored-alternative="en" hidden`; `:212` `header-language').disabled = busy || unresolved`.

### Other suites that read shell markup (harnesses, not CI gates)

`app-browser-check.mjs:345-346` P0b re-hashes served pinned assets (editing hatoove.css fails) and
`:1694-1714` needs `.tabbar [data-view="mehr"]` plus ≥5 `#view-mehr [data-view]` (9 today). `.side
[data-view="…"]` / `.tabbar [data-view="…"]` selectors: `learner-completion-browser.mjs:31,159,185`,
`account-context-browser.mjs:33`; generic `[data-view="…"]` clicks at `app-browser-check.mjs:573,893,2072`.
Keep the `.side` and `.tabbar` class names and `data-view` on the same anchors.
`exam-s3-browser.mjs:55,61` assert `[data-view=sprachbausteine]` links exist and can be hidden
(`app.js:211` does that hiding).

## 7. Risks and colour pairs

Pinned rules slice B must **override** from app.css (never edit): `.app` 248 px column `hatoove.css:90`;
`.side` `background:var(--paper)` + right border `:91`; `.nav`/`.nav a` `:97-102`, including hover
`var(--canvas)` `:99` and current `var(--peach)`/`var(--orange-dark)` `:100`, both wrong on navy;
`.exam-pill` `:94-96`; `.card`/`.card-peach` `:78,80`; `.btn`/`.btn-primary` `:51-53`; `.topbar` `:108`;
`.content` max-width 1240 px `:114`; `.mobile-bar,.tabbar{display:none}` `:117`; `.kicker` `:67`.

* **Navy surface + readable text** — no navy token exists in the pin, so define `--navy`, `--navy-ink`,
  `--navy-muted` as token definitions in `app.css` and apply to `.side`, `.nav a`, `.nav-label`,
  `.side-foot`, `.exam-pill`.
* **Active/hover on navy** — `--orange` (`#ff6b2b`) or a `--navy-active` surface; the pinned current-item
  pair (`--peach` `#fff0e7` background) must be overridden.
* **Orange button** — `--orange` + `--orange-ink` (`#23160f`), the pinned contrast pair already used by
  `.btn-primary` (`hatoove.css:52`).
* **Dark mode** — the pinned dark blocks `:19-31` do not touch a new navy token, so it is identical in
  both themes unless slice B redefines it; any *pinned* token slice B overrides (e.g. `--orange`) also
  needs a dark-path value if a theme-specific one is wanted.
* **Other traps** — answer buttons: `app.js:1091-1092` is pinned by `shell-locale-check.mjs:224`, so
  restyle via `.answer-option` (`app.css:315`), not by changing the button's inner text order. New copy
  needs five dictionaries and Arabic RTL handling: pinned `[lang=ar]` `hatoove.css:75`, isolation rules
  `app.css:455-459`.
