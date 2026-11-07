# DTZ-METADATA-20261107 — selected-exam practice and mock facts

## Assignment

- Issue: https://github.com/ronslink/hatoove/issues/182
- Status: implemented, independently source-reviewed and locally validated; no merge or production deployment authorized. Hosted CI is tracked on the pull request for its exact pushed head.
- Coordinator: local Codex; execution `DTZ-METADATA-20261107-A`.
- Base: `3938b9fa159f47a057286328661dbacd1100ba71`.
- Integration: `codex/dtz-metadata-20261107`, `D:\Hatoove\.worktrees\dtz-metadata-20261107`.
- Issued: 2026-11-07 10:22 UTC; checkpoint every 15 minutes; author leases expire 11:22 UTC unless renewed.
- Initial slots: coordinator, backend author, client author; fourth slot reserved for independent review. Authors have finished. No recursive delegation.
- Existing canonical dirty work is preserved; no learner data or production changes.

## Contract and scope

The existing preparation-scoped `/api/v1/exam-parts` route gains additive release/blueprint identity, section structure and time groups from one eligible release snapshot. Its existing parts stay filtered by servable content. The existing `listExamParts` array contract remains intact. The pure assembler preserves blueprint order and exposes known part numbers; absent facts remain unknown. Mock forms gain their already validated `time_groups`.

The client calls the existing scoped route. Part order, membership, item counts, playback and section timing come from that response. The exact `telc-deutsch-b1` identity may retain the documented telc point/label supplement; it must never supplement DTZ or an unknown exam by family alone. DTZ part labels use localized section/part labels. Mock introduction timing comes from the selected complete form; telc-only totals/pass-rule copy cannot appear on DTZ or unknown exams. No overall result calculation, content approval, new exam activation, migration, saved-run rewrite or hosting change.

## Path ownership

- Backend `DTZ-METADATA-20261107-B`: `server/exam-parts.mjs`, `server/owned-postgres/adapter.mjs`, `server/owned-postgres/packages.mjs`, `server/owned-api.mjs`, new `tools/dtz-metadata-server-check.mjs`. Worktree/branch suffix `-backend`.
- Client `DTZ-METADATA-20261107-C`: `public/app/api.js`, `public/app/part-index.js`, `public/app/mock-intro.js`, `public/assets/i18n/practice-messages.js` if needed, `tools/part-index-check.mjs`, `tools/mock-intro-check.mjs`. Worktree/branch suffix `-client`.
- Coordinator: browser evidence/checks, CI wiring if required, paired central records and this receipt. Other shared paths require explicit allocation.
- Coordinator follow-up allocation: `public/app/part-index.css` for the observed 320px section-title/badge wrapping, plus the matching rendered assertion; no shared design tokens changed.
- Coordinator visual follow-up: `public/app/mock-intro.css` allows unknown-point text to wrap inside the existing narrow table columns; the browser checks table-level overflow in every locale.
- Reviewer: independent, read-only, assigned after implementation.

## Acceptance

- DTZ displays every released LV1–LV5/HV1–HV4 in package order with correct counts/playback and no telc-only SB/points/timing/labels.
- Selected complete DTZ mock uses its own ordered timing groups; telc behavior remains correct.
- Unknown/missing/withheld metadata never produces telc defaults; preparation/account switches cannot show stale facts.
- Five instruction locales, Arabic RTL/German LTR, failure/reload, archived preparations and saved mock history/start idempotency remain intact.
- Focused discriminating tests, relevant offline baseline and isolated source-only Docker PostgreSQL/browser checks pass. Desktop/mobile screenshots are inspected. Physical iPhone/Android and qualified content acceptance remain separate.
- Independent diff/evidence review, staged repository check and reviewed file list before pushing a PR. Main auto-deploys, so merge/deployment awaits Ron's explicit authorization.

## Evidence

Author source: backend `dd1d3ba4f49b2d7cb899f9ed862005b0faf4de22`, client `faaf65401a7560cf8f42cbe7d47d768966ba9e6a`; both independently R1 CLEAR before integration. Combined application, tests and contract source is `548bf14` (later receipt-only commits do not change those bytes). R1 separately reviewed the integration and both observed mobile corrections; final desktop and narrow Arabic/German evidence has no remaining visual blocker.

- All 14 baseline and 21 mirror gates pass. The initial restricted-shell run hit loopback EACCES and a symlink EPERM; only affected checks were rerun with local permissions. The CSV check also needed the already locked PostgreSQL test dependency. No source behavior was relaxed to obtain these results.
- Focused client checks: part-index 16/16, mock introduction 20/20, existing practice runner 48/48, owned client 32/32, redesign parts 4/4, register 10/10. The new checks fail against the old source in five part-index legs and three mock-introduction legs.
- New backend checker: 6 offline and 11 with real PostgreSQL; retained part-index PostgreSQL 16/16. Coverage includes exact release/blueprint identity, selected preparation, read-only snapshot, negative family rights withdrawal and withheld public release. The author's isolated Compose database, network and volume were removed and absence verified.
- Final `node tools/exam-s6-browser-check.mjs --shots .qa/dtz-metadata-20261107/browser-final`: 8/8 on clean `548bf14`, uniquely named synthetic project `hatoove-s6-browser-1794048050656-52624`, cleanup verified. It checks all nine DTZ objective parts, LV5/HV4 opening, 25/45/30-minute schedule, all five locales, RTL and 1440/390/320 layouts, table-level overflow, telc/DTZ switching, new admission closure and preserved pinned runs/history/answers after closure or rights withdrawal.
- `node tools/app-browser-check.mjs --axe --design-evidence=served-only --shots .qa/dtz-metadata-20261107/main-browser-r2`: 236/236, cleanup verified for project `hatoove-browser-1794047938938-50800`. This ran on `c820469`; the sole later application difference is the narrow mock-points wrapping rule covered by final S6. Served design assets were verified; the supplied source references were read separately, not claimed as an automated original-design audit.
- Root inspected desktop, narrow tile/section, and Arabic introduction screenshots. Local evidence is deliberately ignored: `.qa/dtz-metadata-20261107/browser-final/`, `main-browser-r2/` and adjacent logs. Representative files are `dtz-metadata-intro-de-1440.png`, `dtz-metadata-parts-de-320.png`, `dtz-metadata-tiles-LV5-320.png`, `dtz-metadata-intro-ar-320.png`.

Two initial S6 failures are retained as test-harness evidence: returning to the same composed route did not leave the runner, so the check now uses visible Heute navigation; CDP returned an empty raw DOMStringMap, confirmed by a synthetic blank-page probe, so the assertion now explicitly projects the same item/point fields. The first main-browser attempt stopped before learner-flow execution because the pinned accessibility engine was not installed; installing its exact lock resolved setup. Every fixture was cleaned up.

## Limits and next action

No migrations, existing learner changes, content approvals or new DTZ activation. Unknown package point values remain explicitly unknown. Physical iPhone/Android keyboard/audio and qualified content/translation acceptance remain separate from headless Chromium evidence. Main still equals deployed `3938b9fa`. Review the exact PR head and required hosted checks; merging would invoke the production workflow and needs Ron's explicit authorization.
