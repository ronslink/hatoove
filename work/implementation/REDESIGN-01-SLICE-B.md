# REDESIGN-01 slice B — structure pass

Status: **structure landed, values still the pinned ones.** Ron's decision on 5 October 2026 was to build
slice B's structure now and leave every colour value as it is today, so that the studio-look colour list
becomes a values-only change.

## What changed

| File | Change |
| --- | --- |
| `public/app/index.html` | The eleven sidebar icons are now the Lucide paths themselves (lucide-static 1.52.0, ISC); the sidebar logo is the white variant. Every `data-view`, label and `data-i18n` key is unchanged. |
| `public/app/app.css` | New REDESIGN-01 B section: a `--token:` layer for the sidebar and the idle answer-tile border, the sidebar rules, a guarded dark-theme block, and a menu type override (16 px); plus the `.revealed-answer` line for slice C. |
| `public/app/app.js` | Fehlerheft rows render the correct answer next to the learner's own, and the practice verdict gets a line naming the correct answer (slice A's `correct_answer`). |
| `public/assets/i18n/shell-messages.js` | `m388` ("richtige Antwort:") and `m389` ("Weiter üben") in all five dictionaries. The uk/ar/tr strings are machine-written and need Ron's native reviewers. |
| `tools/app-browser-check.mjs` | L19 now asserts the answer reveal instead of the behaviour slice A replaced. |
| `.qa/redesign-01/lucide/` | Vendoring source: the 20 Lucide SVGs, `LICENSE`, and `lucide-paths.json` with the extracted paths. Recovery material, not committed. |

## Rendered evidence, and the three bugs the rendering caught

`tools/app-browser-check.mjs` was run against slice B, against the **unchanged** tree for a baseline, and again
after each fix. Failing legs, compared by name:

| Run | Failing legs | Regressions vs baseline |
| --- | --- | --- |
| Baseline (stashed slice B) | 38 | — |
| Slice B, first pass | 38 (identical set) + L19 | 0; L19 was the one leg slice A legitimately changed |
| Slice B + slice C client change | 38 + L19 passing, +1 flaky view leg | 0 |
| Slice B, final (white logo) | same | 0 |

`L20.nachschlagen` passed in the first run and failed in the next two, on identical code for that view: a known
flake, recorded rather than hidden. Every other failure is pre-existing on the unchanged tree — the app shell
still shows "Loading…" for several catalogue views on this harness (L12, L14, L16, L20.woerterbuch) and the
settings/session/mock legs time out. **Those are not slice B's, and they are not fixed by it.**

Three defects were found by rendering and by a cascade probe, none by reading:

1. **The dark-theme block was not theme-guarded.** `:root:not([data-theme=light])` is not the pinned
   condition; the pinned system wraps it in `@media (prefers-color-scheme: dark)`. Un-guarded, the block fired
   on a light device, so `--nav-bg` resolved to `#faf9f6` and the sidebar rendered **light** — the first
   screenshot showed a white sidebar with a white logo. `.qa/redesign-01/cascade-probe.html` reproduces it in
   one page load.
2. **The idle menu label was unreadable.** `--ink-2` on the dark surface measured **1.51:1**. It is now a 70 %
   mix of the sidebar's own text colour: 8.36:1 light, 8.89:1 dark.
3. **The logo was invisible.** The pinned ink logo is `#241a14`; on the `#242320` surface that is 1.05:1. The
   page had been swapping to the white variant on `prefers-color-scheme: dark`, which picks by the *device's*
   theme while the page follows `data-theme` — so a light page on a dark device showed the white logo on a
   white sidebar. The sidebar is a dark surface unconditionally now, so the white variant (15.6:1) is used
   unconditionally: no filter, no new asset, no pinned-file change.

The first fix attempt also added `filter: brightness(0) invert(1)` to the logo. It was removed: it forces the
wordmark white **and inverts the orange dot**. The curated white asset was already the right answer.

## Measured contrast (WCAG sRGB)

| Pair | Ratio | Min | Result |
| --- | --- | --- | --- |
| LIGHT idle menu label (70 % canvas on ink) | 8.36:1 | 4.5 | pass |
| LIGHT hovered menu label (canvas on ink) | 14.93:1 | 4.5 | pass |
| LIGHT active item (orange-dark on peach) | 4.95:1 | 4.5 | pass |
| LIGHT group label (72 % canvas on ink) | 8.36:1 | 4.5 | pass |
| LIGHT side-foot secondary (72 % canvas on ink) | 8.36:1 | 4.5 | pass |
| LIGHT idle tile border (`#7d8ea6` on paper) | 3.34:1 | 3.0 | pass |
| LIGHT white sidebar logo on `--ink` | 15.62:1 | 4.5 | pass |
| DARK idle menu label (70 % ink on canvas) | 8.89:1 | 4.5 | pass |
| DARK hovered menu label (ink on canvas) | 16.58:1 | 4.5 | pass |
| DARK active item (orange-dark on peach) | 6.98:1 | 4.5 | pass |
| DARK hover surface (12 % ink on canvas) | 1.35:1 | 1.2 | pass |


## The token layer, and why it is the whole point

`public/assets/design/hatoove.css` is pinned: its digest is a reviewed contract
(`design-assets-check`, `app-browser-check` P0b). `app.css` is the shell's own layer, and before this change
it defined **zero** custom properties. Slice B introduces the first ones:

```css
:root {
  --nav-bg: var(--ink);
  --nav-ink: var(--canvas);
  --nav-ink-muted: color-mix(in srgb, var(--canvas) 70%, var(--ink));
  --nav-active-bg: var(--peach);
  --nav-active-ink: var(--orange-dark);
  --tile-idle-border: #7d8ea6;
}
```

`design-check` D1 scans `app.css` for raw colour **in a rule** and exempts token-definition lines
(`design-check.mjs:80`), so this is the one legal place for a literal value, and every rule refers to it
through `var()`. When the studio-look list arrives, only these values change; no rule is touched.

The sidebar is `var(--ink)`, not an invented navy: `--ink` is the design system's own dark neutral, so it
has provenance and a measured text partner. Ron's one measured value, `#7d8ea6` at 3.3:1 on paper, is kept as
supplied for the idle tile border.

## Lucide provenance

- Source: `lucide-static@1.52.0`, fetched from unpkg on 5 October 2026; licence ISC.
- Vendored as path data inline in `index.html` — no font, no sprite request, no CDN, no dependency added.
  This client ships no framework and must work offline; a runtime icon fetch would add a third-party origin.
- The route mapping: Satzbau `puzzle`, Heute `house`, Fortschritt `chart-line`, Fehler `circle-alert`,
  Prüfungsläufe `layout-dashboard`, Leseverstehen `book-open`, Sprachbausteine `puzzle`, Hörverstehen
  `headphones`, Schreiben `square-pen`, Wörterbuch `book-type`, Nachschlagen `list-checks`, Einstellungen
  `settings`.
- Do not hand-edit a path in `index.html`; re-vendor it from `.qa/redesign-01/lucide/`.

## What slice B still owes

1. **The exam card with the large B1.** Not built: it needs the studio-look values to be a designed object
   rather than a guess, and `#preparation-exam` carries the exam name as localized text, so the B1 badge
   needs a data source decision first.
2. **The "Weiter üben" button.** Delivered (`c3c4f49`): the next-task card's primary action reads
   `shell.m389` in the selected interface language, and `bindShellText` owns the label so the re-render after
   a dashboard refresh keeps it. The no-preparation state still reads "Verlauf öffnen" (`m101`). It is the
   pinned orange because the card already used `.btn-primary`.
3. **The navy sidebar.** Currently `var(--ink)`. The navy arrives with the colour list; it is one token value.
4. **Colour values.** All still pinned; the structure is ready for the swap.

## Delivered by this pass, beyond the structure

- Fehlerheft cards already show the correct answer next to the learner's own (slice C's server work, rendered
  here because the data existed and the screen was wrong without it).
- The practice verdict line names the correct answer, in the selected interface language.
- `m388`/`m389` exist in all five languages. **The uk/ar/tr strings are machine-written**: they are not
  reviewed copy, and `work/implementation/REDESIGN-01.md` §5 stands — Ron's native reviewers decide them.

