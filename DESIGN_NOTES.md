# Certa Academy interface — 23 September 2026

The chosen direction is a modern exam academy: white study surfaces, a deep navy navigation rail, restrained blue actions and clear, readable typography. The existing Certa name is retained as the working identity.

## What changed

- A learning cockpit with one next action, today's existing study plan, separate written/oral practice estimates and direct entry to all five exam skills.
- Forecasts distinguish unpractised areas from measured work. A new learner sees no invented score. Partial forecasts explicitly include model assumptions and are not presented as exam results or pass probabilities.
- Activity, due error reviews and practice counts use the existing learner record. Plan ticks say “geübt”, because the current engine recognises practice activity rather than proving a whole planned session was completed.
- A consistent application shell, course identity, real exam countdown, compact navigation, breadcrumbs and a keyboard-accessible mobile drawer.
- Updated shared exercise, feedback, reference and input styling; light, dark and system themes; self-hosted fonts; no new dependencies or external font requests.
- Navigation restores the top of the page and heading focus. Related reference and vocabulary subpages retain the correct active navigation item.

The adaptive engine, question content, AI connection, server and learner-storage format are retained. The redesign is not a claim that the current exam content is ready for commercial release.

## Files and working copies

The live application is `D:\B1_Prep`. The development copy is `<user-home>\OneDrive\Documents\ChatGPT\B1_Prep`.

`public/js/dashboard.js` owns the new dashboard. `public/shell-refresh.css` owns the application shell. `public/studio.css` owns shared design tokens, component refinements and dashboard layout. Both stylesheets load after the original `styles.css`; existing exercise class names remain compatible.

Installation copies only the seven changed/new interface files plus these product documents. Before installation, the prior `public` directory and any documents being replaced are copied into a timestamped `_backup_academy_*` directory inside the live app. It does not copy `.env`, `progress.json`, content packs or the server, and does not restart the running app. Complete an active answer or submission, then refresh to see the new interface.

To undo the interface change, copy the backup's `public` directory contents over `D:\B1_Prep\public` and refresh. The extra new dashboard/style files can remain: the restored HTML and modules do not load them. Learner progress is outside the restored directory.

## Verification

Verified on 23 September 2026: **98 logic/content checks, 86 existing browser checks, 29 mock-AI checks and 26 redesign/accessibility checks passed**. Desktop, phone, light and dark screenshots were inspected. These are implementation/regression checks; they do not certify the existing exam content, which has the release blockers documented below. The mock-AI suite verifies integration with a simulated response, not real model grading quality.

Use `node tools/check.js` for the existing logic/content checks. Browser tests use the repository's existing dependency-free headless Chrome/Edge harness; the `agent-browser` CLI was not installed on this machine.

Run browser suites only against isolated test servers and separate progress files:

```powershell
$env:PORT = '4323'
$env:B1PREP_FORCE_OFFLINE = '1'
$env:B1PREP_PROGRESS_FILE = Join-Path (Get-Location) '.qa\progress-offline.json'
$env:EXAM_DATE = '2026-12-01'
node server.js
```

In another terminal, `node tools/e2e.js http://127.0.0.1:4323` checks the original learning flows and persistence. `node tools/redesign-check.js http://127.0.0.1:4323` checks forecast empty states, five skill routes, responsive layout, mobile keyboard interaction and theme persistence. Run these sequentially because they share the test progress file. The AI suite uses `tools/mock-deepseek.js`, a fake test key and another isolated server; no paid model call is needed for interface verification.

The `.qa` directory is ignored by Git. It contains test logs, screenshots and a separate offline preview copy of the learner record. The real study record on D: is never a test fixture.

## Product direction

See [the exam and product review](exam-product-review.md) for the evidence and staged roadmap. The next release milestone is exam fidelity: correct the writing prompts, speaking task and rubrics together, have educators review the content, and preserve historical scoring versions. Then validate one paid German exam product before building accounts, billing and a wider catalogue. Additional languages need their own certification blueprints and assessment content.
