# DESIGN LANGUAGE — target and migration contract

**First-release acceptance:** [MFP-DESIGN-DECISIONS](MFP-DESIGN-DECISIONS.md) is the current design/state contract. MFP-07a curates licensed assets, script-complete fonts, tokens, responsive CSS and the retargeted design check together. MFP-08/09 use it for asynchronous writing/history states. The earlier DESIGN-01..07 sequence and the historical inventory below do not restore dropped features or the old client. German chrome is invariant; Arabic RTL/shaping and Ukrainian/Turkish glyphs for shipped feedback cannot be deferred with a future translated corpus.

The source contains 112 inline style attributes across its fourteen screens and no reduced-motion rule. The existing design checker does not inspect those files or reject all inline styles; it warns for raw corner radii. Import acceptance must explicitly cover shared classes/tokens, scoped dynamic exceptions, reduced motion, visible focus and desktop/mobile rendering. Font name alone is not glyph/shaping evidence. See the decision record for the corrected licence provenance and R13 logo answer.


## Direction superseded on 1 October 2026

Ron selected the designs in `D:\B1_Prep\design` to replace the previous visual language. [DESIGN-WIRE-01](DESIGN-WIRE-01.md) and its manifest are the target reference: orange rising-oo, warm-paper surfaces, Bricolage Grotesque headings, Source Sans body, consistent desktop/mobile shell and both themes. German chrome/content stay German; explanations support de/en/uk/ar/tr, with scoped Arabic RTL and verified font coverage/licences.

DESIGN-01 must migrate the tokens/components, stylesheet consumers and `tools/design-check.mjs` together with the first implemented screen. Keep the gate effective with negative checks; preserve its language invariant. The current runtime token inventory below remains a baseline for that migration, **not an instruction to preserve the old palette or block the redesign**. This documentation update alone does not change runtime CSS or claim the new visuals are implemented. All retained reference/vocabulary views must join the same system; no parallel theme is the end state.

## Historical runtime baseline before DESIGN-01

| | |
|---|---|
| Asked by | Ron, 2026-10-01: *"we need to ensure we have a consistent page design or a design language that is consistent throughout the app and is mobile friendly"* |
| Status | Existing runtime baseline; target superseded by the direction above. DESIGN-01 updates this inventory and the gate with implementation |
| Source | `public/styles.css` (32 KB) and `public/js/shell.js`, read on 2026-10-01 — not a proposal, a description of what exists |
| Scope | Existing components to migrate; new target views follow DESIGN-WIRE-01 rather than introducing a second independent system |

## 1. The identity

A warm paper background, deep navy for structure and primary action, gold as the accent, and a serif face for
headings against a sans body. This describes the old baseline; the new approved design replaces these choices without a framework migration.

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

1. **Design narrow first.** The target checks include **320 px and 390 px** (an iPhone-class viewport) and no view may
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

Consistency is only real if it is checked. Two mechanisms, both now in place:

1. **`tools/design-check.mjs`** — the structural check, and it is a real gate, not a promise. It fails on: any raw
   colour in a rule outside a custom property; any raw `font-family` in a rule; a missing token; a missing dark
   override; a missing mobile breakpoint; a missing `prefers-reduced-motion`; a view not registered through the
   shell; a second navigation pattern; or a shell that is not the view host. Inline corner radii are reported as
   **WARN, not FAIL**, deliberately: `border-radius: 0 3px 3px 0` is legitimate, and a check that cries wolf is
   worse than no check — this programme has been bitten eight times by *wrong checks* rather than by wrong
   artifacts.
2. **Browser evidence at 390 px and 1440 px** in **both themes**, asserting: no horizontal overflow, no console
   errors, touch targets at least 44 px, and visible focus — the pattern `tools/mock-outcome-browser-check.mjs`
   already establishes.

### 6.1 What the first run of `design-check.mjs` found — real debt, recorded not hidden

Run against the tree as it stood, it passed 9 of 10 and reported the following. **This section carried a wrong
number, and it is corrected here rather than left standing:**

| Finding | Count | Meaning |
|---|---|---|
| **Raw `font-family` in a rule** | **0** — *previously reported as 26, which was wrong* | The original check used `FONT_RE=/font-family\s*:/i`, which matched **every** `font-family` declaration — including the 22 rules that already said `var(--serif\|sans\|mono)` and the four `@font-face` descriptors. **26 was the check's own count, not the file's.** The descriptors cannot use `var()` at all, so "replace them with tokens" was never possible. Corrected by the D1 author and independently confirmed by the coordinator: the check now blanks the `@font-face` blocks and flags only a family that is not one of the three type tokens, and it still fails when a raw family is introduced into a rule |
| Inline corner radius outside a token | 19 | WARN only; `border-radius: 0 3px 3px 0` is legitimate. Visible debt, reported rather than failed |

**The lesson is worth more than the number.** This was a check the coordinator wrote that counted the very
declarations it was meant to approve — the twelfth instance in this programme of a check being wrong rather than the
artifact, and the second one that reached CI before anyone noticed. `public/styles.css` is byte-identical to
`main`, so the rendered typography was never affected.


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
