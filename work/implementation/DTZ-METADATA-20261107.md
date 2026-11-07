# DTZ-METADATA-20261107 — selected-exam practice and mock facts

## Assignment

- Issue: https://github.com/ronslink/hatoove/issues/182
- Status: implementing; no merge or production deployment authorized.
- Coordinator: local Codex; execution `DTZ-METADATA-20261107-A`.
- Base: `3938b9fa159f47a057286328661dbacd1100ba71`.
- Integration: `codex/dtz-metadata-20261107`, `D:\Hatoove\.worktrees\dtz-metadata-20261107`.
- Issued: 2026-11-07 10:22 UTC; checkpoint every 15 minutes; author leases expire 11:22 UTC unless renewed.
- Active slots: coordinator, backend author, client author; fourth slot reserved for independent review. No recursive delegation.
- Existing canonical dirty work is preserved; no learner data or production changes.

## Contract and scope

The existing preparation-scoped `/api/v1/exam-parts` route gains additive release/blueprint identity, section structure and time groups from one eligible release snapshot. Its existing parts stay filtered by servable content. The existing `listExamParts` array contract remains intact. The pure assembler preserves blueprint order and exposes known part numbers; absent facts remain unknown. Mock forms gain their already validated `time_groups`.

The client calls the existing scoped route. Part order, membership, item counts, playback and section timing come from that response. The exact `telc-deutsch-b1` identity may retain the documented telc point/label supplement; it must never supplement DTZ or an unknown exam by family alone. DTZ part labels use localized section/part labels. Mock introduction timing comes from the selected complete form; telc-only totals/pass-rule copy cannot appear on DTZ or unknown exams. No overall result calculation, content approval, new exam activation, migration, saved-run rewrite or hosting change.

## Path ownership

- Backend `DTZ-METADATA-20261107-B`: `server/exam-parts.mjs`, `server/owned-postgres/adapter.mjs`, `server/owned-postgres/packages.mjs`, `server/owned-api.mjs`, new `tools/dtz-metadata-server-check.mjs`. Worktree/branch suffix `-backend`.
- Client `DTZ-METADATA-20261107-C`: `public/app/api.js`, `public/app/part-index.js`, `public/app/mock-intro.js`, `public/assets/i18n/practice-messages.js` if needed, `tools/part-index-check.mjs`, `tools/mock-intro-check.mjs`. Worktree/branch suffix `-client`.
- Coordinator: browser evidence/checks, CI wiring if required, paired central records and this receipt. Other shared paths require explicit allocation.
- Coordinator follow-up allocation: `public/app/part-index.css` for the observed 320px section-title/badge wrapping, plus the matching rendered assertion; no shared design tokens changed.
- Reviewer: independent, read-only, assigned after implementation.

## Acceptance

- DTZ displays every released LV1–LV5/HV1–HV4 in package order with correct counts/playback and no telc-only SB/points/timing/labels.
- Selected complete DTZ mock uses its own ordered timing groups; telc behavior remains correct.
- Unknown/missing/withheld metadata never produces telc defaults; preparation/account switches cannot show stale facts.
- Five instruction locales, Arabic RTL/German LTR, failure/reload, archived preparations and saved mock history/start idempotency remain intact.
- Focused discriminating tests, relevant offline baseline and isolated source-only Docker PostgreSQL/browser checks pass. Desktop/mobile screenshots are inspected. Physical iPhone/Android and qualified content acceptance remain separate.
- Independent diff/evidence review, staged repository check and reviewed file list before pushing a PR. Main auto-deploys, so merge/deployment awaits Ron's explicit authorization.

## Evidence

Pending implementation and validation.
