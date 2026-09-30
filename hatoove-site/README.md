# Hatoove brand website and practice preview

Standalone static website. The existing B1 application and learner records are unchanged.

Run `node tools/serve.mjs` and open the printed local URL. `dist/` is the complete deployable site. Hosting identity is in `.openai/hosting.json`.

## Brand

- Logo: **rising "oo"**: the double o in hatoove drawn as two rings, the second raised and orange, as a step up. The mark is the two rings on an orange tile. Master files are in `brand/`; the wordmark text is outlined (Bricolage Grotesque 700), so the logo needs no font installed.
  - `hatoove-logo.svg` / `-white.svg`: mark + wordmark, for light / dark backgrounds
  - `hatoove-wordmark*.svg`: wordmark only; `hatoove-mark.svg`: tile; `hatoove-mark-small.svg`: heavier rings for 16–32 px
  - `favicon.ico`, `icon-512.png`, `hatoove-logo.png`: raster exports
- Headlines: Bricolage Grotesque (self-hosted, SIL OFL, `dist/assets/OFL-BricolageGrotesque.txt`); body: Source Sans 3.
- Primary orange: `#FF6B2B`; ink: `#242320`; readable orange text: `#BD3C0A`; white background with pale orange practice framing.
- Main message: **Know the exam. Practise what matters.**
- Source Sans 3 is self-hosted; its SIL Open Font License is in `dist/assets/OFL-SourceSans3.txt`.
- Orange paper-path artwork was generated for Hatoove. It depicts small steps toward a goal and is not an official exam-provider asset.

## Working features

Two original reading samples, two original language-element samples, deterministic answer explanations, English/German instruction switching, keyboard-accessible tabs, a writing draft with word count, five-point self-review, model response and expandable FAQs. State is in page memory only and clears on reload. Nothing is sent for AI grading or saved to an account.

No authentication, payments, listening audio or production AI assessment is connected. Do not represent this as a complete exam, calibrated diagnostic, pass predictor or officially endorsed preparation. Website publication does not buy or connect `hatoove.com`.

The section weights reflect the official telc Deutsch B1 model: reading 75, language elements 30, listening 75, writing 45. Full-exam success also requires a separate oral pass. Content remains a preview and needs educational review before a commercial release.

## Verification

Browser checks passed for correct and incorrect answers, all four objective samples, retries, language switching, keyboard tab navigation, draft/checklist preservation, safe rendering of typed markup, model responses and FAQs. No horizontal overflow at 1440, 768, 390 or 320 pixels; assets loaded and no JavaScript errors were observed. Desktop and mobile screenshots were visually reviewed.

The optional `start_hatoove_practice` WebMCP action opens a sample tab without answering or grading. Native WebMCP validation was unavailable in the verification browser; ordinary practice works without it.
