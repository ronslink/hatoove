# Curated design assets — provenance

These bytes are the **shipped** Hatoove design system. They are copies of the supplied design
originals, not re-exports, and `tools/design-assets-check.mjs` proves it: every file here must match
the SHA-256 pinned in [`DESIGN-REFERENCE-MANIFEST.json`](../../../work/implementation/DESIGN-REFERENCE-MANIFEST.json).

| | |
|---|---|
| Supplied by | Ron, 1 October 2026 |
| Original location | `D:\B1_Prep\design` (the live install; **read-only**) |
| Relocated to | `D:\Hatoove\design` on 1 October 2026 |
| Manifest | `work/implementation/DESIGN-REFERENCE-MANIFEST.json` — 22 files pinned, 22 verified byte-for-byte at relocation |
| Curated here | 6 files, on 1 October 2026 |
| Check | `node tools/design-assets-check.mjs` — 6 legs, including a tamper leg |

## What is here, and why

| File | Role |
|---|---|
| `hatoove.css` | the design language: tokens, dark theme, `@font-face`, base elements |
| `fonts/source-sans-3.woff2` | body face |
| `fonts/bricolage-grotesque.woff2` | display face |
| `hatoove-logo.svg`, `hatoove-logo-white.svg` | full logo, light and dark surfaces |
| `hatoove-mark.svg` | the rising-oo mark, used as the favicon in the reference |
| `licences/OFL-SourceSans3.txt` | SIL OFL 1.1 notice, © Google Inc. |
| `licences/OFL-BricolageGrotesque.txt` | SIL OFL 1.1 notice, © 2022 The Bricolage Grotesque Project Authors |

Both fonts are **SIL Open Font License 1.1**. The notices are the copies that already existed in
`hatoove-site/dist/assets/`, and the font bytes there are **identical** to the design originals
(verified: `7a19a702…` and `a79fdb52…`), so the pairing is not inferred from names.

## What is deliberately NOT here

- **The 14 reference screens and the index.** They are reference, not product: several contradict
  recorded decisions, and shipping them as application markup would put fixtures in the client. They
  are imported for reading only, under [`work/design-reference/`](../../../work/design-reference/).
- **`build.py`.** The design's own builder is explicitly not to be run
  (`DESIGN-WIRE-01.md:12`), so it is not imported. It remains in the untracked `design/` folder.
- **The design originals.** `design/` stays untracked, by `.gitignore`. These copies are the
  curated artifacts; the check is what ties them to the reviewed originals.

## The known coverage gap

`MFP-DESIGN-DECISIONS.md` measured both subsets: **231** mapped codepoints (Source Sans 3) and
**226** (Bricolage Grotesque). Neither supplies Cyrillic or Arabic letters and both miss `ĞğİŞş`
while containing `ı`. That is not a claim about the full font families — it is a claim about **these
subset files**, which are what ship.

Consequence: the agreed explanation languages are **de/en/uk/ar/tr** and these two subsets cannot
render three of them. Additional freely licensed coverage (the record suggests a Cyrillic/Latin
extended Noto Sans build plus Noto Sans Arabic) must be added, pinned and licensed before any
Ukrainian, Arabic or Turkish explanation is claimed to render. **Do not treat "the font is present"
as "the glyph is covered"** — computed `font-family` is not evidence; rendered shaping is.

## Rules for using these assets

1. Do not edit a curated file to make a view work. If the design language needs to change, that is a
   new reviewed asset with a new digest, recorded in the manifest.
2. Do not add an asset here without a licence notice and a pinned digest.
3. Rendered evidence at 320/390, 768/1024/1180 and 1440 px in both themes is still required, and
   **emulation is not a real device**. Nothing here has been rendered by a check.
