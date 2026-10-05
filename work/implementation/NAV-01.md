# NAV-01 — information architecture (MIRROR-B1PREP-01 slice A)

**Status: delivered on branch `codex/nav-01-mirror-ia` (worktree `.worktrees/nav-01`), base commit
`072d29e`. Awaiting independent review; not merged, not pushed, not deployed.**

Authority: `docs/contracts/MIRROR-B1PREP-01.md` §4.1, §4.2 and §5 slice A.

## What changed

| File | Change |
|---|---|
| `public/app/index.html` | Sidebar rebuilt as three labelled groups with ten entries; topbar breadcrumb now reads `Deutsch B1 / <group> · <title> · <date>`; the "Ihre Vorbereitung" card got the id `preparation-context`; new sections `view-pruefungsteile` and `view-probepruefung`; `view-nachschlagen` gained a Satzbau card and the `library-host` mount point; `view-woerterbuch` → `view-wortschatz` and `view-fortschritt` → `view-verlauf`; the mobile tabbar aligned to the new groups. |
| `public/app/app.js` | `VIEW_TITLES` rewritten for the new routes; a redirect/alias layer (`VIEW_ALIAS`, `NAV_GROUP`, `GROUP_LABEL`, `DEEP_LINKS`, `resolveView`); the section loop, breadcrumb group and preparation-card visibility now follow the route; the guarded module loader for `library.js` and `mock-intro.js`; interim `renderPartIndex`, `renderProbepruefung` and `renderNachschlagen`; every internal reference to the retired `fortschritt` view name updated to `verlauf`. |
| `public/app/app.css` | Two rules for the group wrapper (`.nav-group`), plus the first group's label loses its leading gap. |
| `public/assets/i18n/shell-messages.js` | Nine new keys `m393`–`m401` in all five locales. |
| `tools/nav-ia-check.mjs` | New focused gate, 11 legs, mutation-proven. |

Sidebar as delivered: **Mein Lernweg** — Heute, Einzelübungen, Wortschatz, Fehlerheft ·
**Prüfungstraining** — Prüfungsteile, Hören, Schreiben, Probeprüfung · **Werkzeuge** — Nachschlagen,
Einstellungen.

Retired routes still resolve: `#/fortschritt` → `verlauf`, `#/woerterbuch` → `wortschatz`, bare
`#/abschnitt` → `probepruefung`, `#/nachschlagen/satzbau` → `satzbau`, and `#/lauf/<id>` keeps the run
view. Leseverstehen and Sprachbausteine keep their deep links without a sidebar entry.

## Deviations from the frozen contract, and why

1. **Ten entries, not nine.** The §4.1 table lists 4 + 4 + 2 = **10** entries; the slice-A task text I
   wrote said "nine" (a copy error in the task and in the first draft of the sidebar comment, not in the
   contract). Implemented as 10, asserted as 10.
2. **`#/fortschritt` → `#/verlauf` instead of `#/heute`.** The contract says Fortschritt folds into
   Heute. The history content is reached as the Verlauf sub-page of Heute, so the redirect targets the
   sub-page rather than dropping the learner onto Heute with the history unreachable. Heute keeps the
   "Details" link to it; the sidebar has no Verlauf entry.
3. **Module stylesheets are injected on a successful module import**, not linked unconditionally from
   `index.html` as §5 slice A phrased it. `library.css` and `mock-intro.css` do not exist until E/F and D
   land, and an unconditional `<link>` would 404 in every build in between. The contract's intent (the
   shell owns `index.html`; a module owns its own stylesheet) is unchanged.
4. **No `VIEW_SECTION` indirection.** The first implementation aliased `wortschatz` onto `view-woerterbuch`
   and `verlauf` onto `view-fortschritt`. `tools/design-check.mjs` D6 requires every route in
   `VIEW_TITLES` to own a `#view-*` element, and the alias would have hidden the mismatch rather than
   fixed it. The sections were renamed to the canonical routes and the retired names live only in
   `VIEW_ALIAS`, which redirects.

## Checks run

All from `.worktrees/nav-01` (worktree root, `node` 24.4.1, no npm dependencies installed):

| Check | Result |
|---|---|
| `node tools/nav-ia-check.mjs` | **passed, 11 legs** |
| `node tools/design-check.mjs` | **passed, 14 legs, 0 failed** (2 pre-existing warnings) |
| `node tools/i18n-register-check.mjs` | **passed, 0 findings** across 11 shipped files |
| `node tools/repository-check.mjs` | passed, 699 tracked files |
| `node tools/retired-surface-check.mjs` | passed, 10/10 |
| `node tools/seo-check.mjs` | passed, 11/11 |
| `node tools/server-origin-check.mjs` | passed, 8/8 |
| `node tools/keymask-check.mjs` | passed, 14/14 |
| `node tools/owned-client-check.mjs` | passed, 32/32 |
| `node tools/guide-render-check.mjs` | passed (303 examples, unchanged renderer) |
| `node tools/migration-eol-check.mjs` | passed, 5/5 (after linking `server/owned-postgres/node_modules` into the worktree; the worktree has no untracked `node_modules`) |
| `node tools/migrate-check.mjs` | **not run**: needs a disposable PostgreSQL and it is not this slice's gate |
| `tools/app-browser-check.mjs` | **not run**: needs Docker and a browser; the real-device gate stays open |

### Mutation proof for the new gate

A copy of the tool beside a copy of the client in `%TEMP%` (deleted afterwards). Pristine copy passed;
each mutation failed the intended leg:

| Mutation | Result |
|---|---|
| delete the Probeprüfung sidebar entry | fail — "group pruefungstraining lists the wrong entries" |
| drop `shell.m400` from the Turkish block | fail — the locale-coverage leg |
| show the preparation card on every view again | fail — "app.js no longer hides the preparation card outside Heute" |
| retarget the `fortschritt` alias away from `verlauf` | fail — "Fortschritt must fold into Heute as the Verlauf sub-page" |

## Rendered evidence

`handoff/ron-agent/nav-01-evidence/` (untracked): desktop 1366 Heute light and dark, Prüfungsteile,
Probeprüfung, Nachschlagen; mobile 390 Heute light and Probeprüfung dark; a 320 px Heute capture.
Measured in the same run: one visible `.view` per route, `aria-current` on the matching entry, the
breadcrumb group correct for each route, the preparation card hidden on every route except Heute, sidebar
248 px at 1366 and collapsed at 390, and **no horizontal overflow at 320 px** (scrollWidth 320 = clientWidth
320, zero overflowing nodes).

**Honest limits of that evidence.** The capture is a temporary harness over the real `index.html` markup
and the real `app.css`/design stylesheets served over HTTP on `127.0.0.1:8788`; it performs only the
reveal that `app.js` performs after boot. It proves the shell, the sidebar, the breadcrumb and the
preparation-card rule — it does **not** exercise the API, the interim part index or the saved-run list,
which `app.js` renders at runtime. No signed-in run was performed, and no real phone or tablet was used.

## Not verified / residual risk

- No signed-in run against a real API; the route dispatch was proven statically and the shell rendered,
  not the authenticated journeys.
- The interim bodies of `#/pruefungsteile` (four subtests) and `#/probepruefung` (saved runs plus the
  module mount) are not in the rendered evidence; slices B and D replace them.
- The nine new interface strings are machine-authored in uk/ar/tr (German and English are authored);
  native review is owed before anything is treated as final copy.
- `#/abschnitt/<runId>` (the mock player) was not exercised in a browser after the rename; the route and
  view key are unchanged and the static check pins the bare-route redirect.
- The tabbar change is inside slice A's navigation scope but was not in the contract's literal text; it
  keeps the mobile surface consistent with the sidebar groups.

## Next action

Independent review of `codex/nav-01-mirror-ia` against §4.1/§4.2 and this note, then integration by the
Lead, then slice B and the wiring of `library.js` (E/F) and `mock-intro.js` (D) into the hosts this slice
created.
