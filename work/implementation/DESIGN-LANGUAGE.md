# DESIGN LANGUAGE — the app's one page design, and the rules for keeping it consistent

| | |
|---|---|
| Asked by | Ron, 2026-10-01: *"we need to ensure we have a consistent page design or a design language that is consistent throughout the app and is mobile friendly"* |
| Status | the app **already has** a design language. This document names it, so new work follows it instead of inventing a second one |
| Source | `public/styles.css` (32 KB) and `public/js/shell.js`, read on 2026-10-01 — not a proposal, a description of what exists |
| Governs | **every new view, including the account surface.** A view that does not use these tokens and components is a defect, not a style preference |

## 1. The identity

A warm paper background, deep navy for structure and primary action, gold as the accent, and a serif face for
headings against a sans body. **Preserve it.** No framework migration, no redesign, no new palette.

## 2. Design tokens — the only source of colour, shape and type

Every colour, radius, shadow and font comes from a CSS custom property on `:root`, with a dark override under
`prefers-color-scheme: dark`. **Never hard-code a hex value, a px radius or a font stack in a new rule.** If a
value is genuinely missing, add a token — do not inline it.

| Group | Tokens | Meaning |
|---|---|---|
| Surface | `--bg`, `--line`, `--fg`, `--sidebar-bg` | page, borders, text, navigation |
| Brand | `--accent`, `--accent-soft`, `--on-accent`, `--brand-disc`, `--gold`, `--gold-soft` | primary action and brand emphasis; **one primary action per view** |
| Semantics | `--good`, `--good-dim`, `--good-soft` · `--warn`, `--warn-dim`, `--warn-soft` · `--bad`, `--bad-dim`, `--bad-soft` | correct / caution / incorrect. Use these, never red/green literals |
| Shape | `--radius` (14 px), `--radius-sm` (9 px) | cards and controls |
| Depth | `--shadow-sm`, `--shadow`, `--shadow-lg` | raised surfaces |
| Type | `--serif` (headings), `--sans` (body and UI), `--mono` (numbers, keys, code) | three faces, no more |

**Dark mode is not optional and not a redesign**: it works because every rule uses tokens. A new rule that
hard-codes `#fff` breaks dark mode silently — that is the most common way this app's design language gets broken.

## 3. Components — build with these, do not invent parallel ones

| Component | Class | Use |
|---|---|---|
| Application frame | `.app`, `.sidebar`, `.main`, `.topbar` | the shell owns layout; a view renders **inside** it |
| Navigation | `.nav-item`, `.nav-sep`, `.brand`, `.brand-mark`, `.sidebar-foot`, `.theme-toggle` | adding a destination means adding a `.nav-item`, not a new pattern |
| Container | `.card` | every block of content is a card |
| Layout | `.grid`, `.btn-row`, `.meter-row`, `.stat` | two-column grids collapse on small screens; `.btn-row` wraps |
| Action | `.btn-row` with the existing button classes, one primary | **one primary action per view** |
| Feedback | `.pill`, `.hint`, `.muted`, `.dim`, `.empty`, `.toast`/`.toast-host`, `.spinner`, `.busy-overlay`/`.busy-box` | status, help text, emptiness and progress. `.busy-overlay` is how the app says "working" — reuse it, do not build a second spinner |
| Assessment | `.option`, `.feedback`, `.correction`, `.verdict-row`, `.progress-line`, `.bar`, `.heat`, `.tag-chip` | practice and result surfaces |
| Content | `.passage`, `.letter-body`, `.item-block`, `.item-stem`, `.item-num`, `.gap-inline`, `.headline-list`, `.headline`, `.transcript-box`, `.ads-grid`/`.ad`, `.tf-row`/`.tf-buttons` | exam-shaped content |
| Utility | `.mt`, `.mb`, `.small`, `.center`, `.nowrap`, `.hidden`, `.mono`, `.serif`, `.hero` | spacing and emphasis only |

**A form control is `input`, `textarea` or `select` as already styled; a new view adds no new control style.**
Errors are shown through `.hint`/`--bad` and status through `.pill`, not through new banners.

## 4. Mobile rules — the app is mobile-capable, and it must stay that way

The stylesheet already adapts at **1100 px, 860 px, 600 px and 480 px**, and honours
`prefers-reduced-motion: reduce`. New work must hold these rules:

1. **Design narrow first.** The smallest supported width is **390 px** (an iPhone-class viewport) and no view may
   scroll horizontally at that width — assert `scrollWidth <= clientWidth`, as the existing browser checks do.
2. **Touch targets are at least 44 × 44 px**, and controls are never closer than 8 px.
3. **Text scales to 200 %** without clipping or overlap, and no layout depends on a fixed pixel height.
4. **No hover-only affordance.** Anything hover reveals must also be reachable by tap and by keyboard.
5. **One column on small screens.** `.grid` collapses; do not introduce a fixed two-column layout below 600 px.
6. **Reduced motion is respected** — never animate something essential, and gate new motion on the existing
   `prefers-reduced-motion` block.
7. **Focus is visible** on every interactive element, in both themes.

## 5. Accessibility that is not decoration

- Semantic elements first (`button`, `label`, `nav`, `main`), ARIA only where semantics cannot express the state.
- A visible label for every input; placeholders are **not** labels.
- Status changes that the learner must notice get `role="status"` or `role="alert"` — the mock-result work already
  uses `role="status"` for pending feedback and should stay the pattern.
- Colour is never the only signal: pair `--good`/`--bad` with a word or an icon.
- German is the learner-facing language of the app. Keep new copy in German and in the app's voice.

## 6. How this is verified, not merely stated

Consistency is only real if it is checked. Two mechanisms, both already in use in this programme:

1. **A structural check** over new views: they may not introduce a hex colour, a raw `px` radius, or a new
   font-family; they must render inside the shell; and they must use the token names above. This kind of check is
   cheap to write and it is the only thing that stops a second design language appearing one view at a time.
2. **Browser evidence at 390 px and 1440 px** in **both themes**, asserting: no horizontal overflow, no console
   errors, touch targets at least 44 px, and visible focus — the pattern `tools/mock-outcome-browser-check.mjs`
   already establishes.

**Existing evidence to build on, not to redo:** `tools/exam-blueprint-check.mjs` and the earlier CSS bounding work
(`PILOT-01`) already proved that only the D5/D6 defects were real and that 200 %-zoom filenames are not proof of
text-zoom support. Do not resubmit viewport emulation as real-device evidence.

## 7. What this means for the account surface

The account view (ACCOUNT-UI-01) is the **first view built under this document**, so it sets the precedent:

- it renders inside the existing shell and is reached through a normal `.nav-item`;
- it uses `.card`, `.grid`, `.btn-row`, `.hint`, `.pill` and the semantic tokens — **no new palette, no new
  control style, no new spinner**;
- it holds the mobile rules above at 390 px, in both themes, with a visible focus ring and no horizontal overflow;
- and it adds the structural check from §6.1 for its own view, so the rule is enforced rather than promised.

**No gate is closed by this document.** The real-device gate (iPhone Safari / Android Chrome) stays **open**: a
390 px emulated viewport is not a phone, and nothing here may be reported as real-device evidence.
