# INTEGRATE-20261002-A — reviewed integration candidate

2 October 2026. Continues COMPLETE-20261002-A / issue96. One final candidate brings the completed learner app, Docker/SaaS cutover and retained contracts to current main. Normal merge `a85d35d` combines completion `79a1659` with main `4f76b94`; only historical MASTER-PLAN/BOARD records conflicted. PR89 and rejected PR33 are excluded and remain held. No production deployment or live-provider execution is included.

## Changes and independent review

- Coordinator account consistency fix `f62e200`: each new app page binds to the verified account and supplies a consistency precondition on owned requests and sign-out. A cookie switched by another tab cannot silently change the owner of deletion/settings/export/new work. Expired/changed pages freeze, suppress late responses and preserve recovery text. Header-less programmatic clients retain their contract; already-open old app pages need a reload. Entry reviewer independently reviewed the core and reran9/9 focused checks.
- D8 worker `da970c2` (adopted `b6291ca`): explicit Vorlesen/Stoppen for German dictionary examples and saved comments, using only a matching voice reported as local by the device. No autoplay, remote fallback, text upload or new provider. Rendered comment language is authoritative; unavailable voices/errors and lifecycle cancellation are explicit. Coordinator reviewed the diff and desktop/mobile evidence.
- Actual Claude CLI `e38b4a7` (adopted `136afe2`): a stale draft discard cannot remove any already-submitted writing, cancel its job or release its reservation. Existing tombstoned submission text/results remain in export with a tombstone flag. Backend reviewer independently inspected the adapter and provided real PostgreSQL race/export checks `e91bb35` (adopted `d30fea4`).
- Coordinator recovery `ba094a0` and catalogue restoration `e386109`: persistent account-change message, preserved dirty editor and saved feedback, no false revision-conflict recovery, honest unknown deletion outcomes, historical rubric reuse, explicit submitted-discard refusal, and a sibling writing editor so closing restores the task catalogue. Entry reviewer found no remaining blocker at `e386109` and inspected all132 browser legs and desktop/mobile recovery evidence.

## Executed evidence

- Complete disposable Compose/Chromium journey: **132/132**, including actual two-tab shared-cookie identity changes, refused deletion/settings/sign-out, retained unsaved text, no stale presave control re-enable, submitted draft preservation and close/reopen. All124 existing legs also pass. Final artifacts: ignored `.qa/browser/2026-10-02T10-57-09-870Z/` in the integration worktree.
- Read-aloud adapter **8/8** and actual-app source-only browser with synthetic voices **24/24**. Dictionary/comments at desktop/mobile in light/dark: ignored `.qa/read-aloud/`. These are rendering/behavior checks, not physical-device audio evidence.
- Account context **9/9**, submission preservation **7/7** (old-code discrimination fails5/7), memory owned API **33/33**, memory history **8/8**.
- Disposable PostgreSQL: independent controlled two-connection races/export **9/9**, coordinator rerun **9/9**, owned API **33/33**, history/policy/export **10/10**, hard account deletion **19/19** and HTTP journeys **11/11**, no pending legs. The journey fixture required explicit migrations before startup; missing migrations correctly refused readiness.
- Design **14/14** (two existing structural warnings), workflow-shape **12/12**, new checks added to existing CI jobs. Staged source guard and CI results are recorded with the final PR.

The first combined browser run passed124 existing legs, then stopped on syntax in the new test helper; subsequent debugging corrected real-page reload in that helper and uncovered the writing catalogue defect. The final complete run above passed132. No failure was waived. Disposable tests never used the learner's4300 app or its database volume.

## Remaining acceptance

Code review and green tests do not constitute external-pilot/product acceptance. Physical iPhone/Android keyboard/audio checks, reviewed listening recordings, qualified exam-content review, operator/legal copy and human security/privacy review remain open. Writing feedback remains explicitly labelled deterministic simulation. D10 provider/cost/privacy decisions and D12 refill are not activated by this integration. Existing learner data/volumes and held branches are preserved.
