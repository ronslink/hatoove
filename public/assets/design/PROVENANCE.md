# Curated design assets — provenance

## Approved product captures — 9 October 2026

Ron approved replacing the public illustration with the actual redesigned app capture in chat.
Chromium captured a disposable source-only Compose instance using a synthetic account and answer.
No learner data, live AI or production access was used. The German task is retained exam content;
the Ukrainian explanation is an offline Codex-authored translation from the exact stored original,
explicitly unreviewed in tools/fixtures/redesign-product-explanation.json. The normal explanation
importer registers it without any approval decision. This is image approval, not educational or
native-language approval and not deployment authorization.

| Public capture | Dimensions | Bytes | SHA-256 |
| --- | --- | --- | --- |
| product-wide.jpg | 1400×900 | 142133 | 9613f05ff5c921b01538bd69c8fddf674d50aa71f3075c2f874a5b1522787a11 |
| product-narrow.jpg | 900×1200 | 130011 | 13c2de9ae412abe15bcbdf1e772b913988362dc3000de85d392712621085da84 |
| product-wide.webp | 1400×900 | 90712 | d4e4ea8e6f3d0515e5f82218c3ff810d738731a5a96120aac82d568f78993bc1 |
| product-narrow.webp | 900×1200 | 89088 | 0507d179bde7a2026a3d24bbb49d651d1fff62bce603027b053ec5d382862aff |
| og-card.jpg | 1200×630 | 101132 | 7332a47c025d849f36960442792acb03c437c486af48a7bd2498b01870189e27 |

All are below 200 KB. JPEG evidence is retained under the ignored generated QA projects
1791558805429-10264 and 1791559445001-52768; WebP counterparts are from 1791559790627-72540.
The replaced SVG illustrations and prior PNG social card are removed from shipped assets.
The separate digest-only German language registry projection preserves 180 existing exact-source
declarations inside the server image; changed metadata or original prose remains unknown.

## Authorized studio revision — 9 October 2026

Ron explicitly authorized revising and re-pinning `hatoove.css` in the pasted REDESIGN-01 contract.
The shipped stylesheet now uses the requested cool canvas, navy rail, blue primary controls and
orange continue control. The reference original remains unchanged under `D:/Hatoove/design/assets/hatoove.css`,
SHA-256 `36af5c8f190b37008d35fc954515c3503658a052ca2c29ae9963d701ccca2fdc`, 21210 bytes.
The manifest records the revised shipped digest. Font files, licences and logos retain their original bytes.
The historical preservation rules below describe the earlier font-coverage correction; this explicit
design revision supersedes their prohibition for this stylesheet only. Other pinned assets remain immutable.

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

## The script-coverage layer — ADDITIVE, and NOT a supplied design original

`fonts-coverage.css` and the three Noto subsets are **ours**, not Ron's design inputs. They are
therefore deliberately **not** in `DESIGN-REFERENCE-MANIFEST.json`, which pins the supplied
originals only:

| File | Why |
|---|---|
| `fonts-coverage.css` | `@font-face` rules and `[lang=uk/tr/ar]` stacks for the scripts the branding faces cannot render |
| `fonts/noto-sans-latin-ext.woff2` | Turkish: `ĞğİŞş`, which Source Sans 3 lacks while containing `ı` |
| `fonts/noto-sans-cyrillic.woff2` | Ukrainian |
| `fonts/noto-sans-arabic.woff2` | Arabic |
| `licences/OFL-NotoSans.txt`, `licences/OFL-NotoSansArabic.txt` | SIL OFL 1.1 notices |

**Why these are in a separate file, and the rule that follows.** An earlier attempt put the
`@font-face` rules and the extended font stacks **directly into `hatoove.css`** and then updated its
manifest digest to match. That defeats the pin: a curated asset stops being the reviewed artifact the
moment it is edited, and a check re-pinned after every edit measures nothing. So:

1. **Never edit a file listed in the manifest.** The digest is the contract; `D2` enforces it.
2. **Add a new reviewed file instead.** Coverage lives in `fonts-coverage.css`, the pinned file stays
   byte-exact, and `D7` reads the coverage layer for the stacks it actually asserts.
3. **A change to the design language is a new asset with a new digest**, recorded here, not a quiet
   edit to an old one.

`D6` proves every font on disk has a matching OFL notice; `D7` re-reads each font's `cmap` to prove
the glyphs are declared; `X2` proves those two legs can fail. **None of that proves rendering**:
Arabic shaping and joining, right-to-left layout and fallback behaviour are established by no check
here, and the device gate remains open.
