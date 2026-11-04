# CI browser helper migration

Execution `CI-HELPERS-20261104-C`, issue [181](https://github.com/ronslink/hatoove/issues/181), base `6f4f84ca749e335cc77534bcfd6e3094bafcf233`. Author scope is `tools/exam-s1-browser.mjs`, `tools/review-ux-browser.mjs` and this receipt. No runtime, workflow, learner data or production changes.

S1 now follows the current single-item drill, Schreiben catalogue and Verlauf routes. The checks retain exact selected-preparation/sitting bindings, saved text and history isolation, delayed write/read navigation fences, failed-save preservation, archive behavior and narrow layouts. Settings assertions use the confirmed language catalogue. An uncertain account-language save is checked against the current read-after-write reconciliation contract: retain the committed preparation date, restore the server-confirmed language and show explicit reconciliation. Date conflicts still preserve unsaved form choices until explicit recovery.

Review-UX now checks reading-part controls against the served catalogue, the exact set/version actually returned by the part-opening request, and its visible rendered identity. Long LV3 option text is compared with the exact authored API payload in the visible option bank, with a corresponding keyboard-selectable choice. Desktop, 390px and 320px checks retain full-text, wrapping, unclipped and no-page-overflow assertions. The current complete-set action returns to the part index. Schreiben retains exact task/version/rubric binding and real double-click/open-draft verification plus owned cleanup.

Retired assumptions: the old per-set `#task-list` catalogue, one-answer buttons, `#/fortschritt`, objective close button and tooltip-era option-button markup were replaced by the redesigned client. Their semantic coverage is carried by the current controls above. No assertion is removed to conceal an actual runtime failure.

Validation: both files pass `node --check`. Full disposable browser integration and independent review are pending; this is a candidate delivery, not a passing-browser claim. The coordinator/primary CI author will run the complete app suite with all slices integrated. No physical-device or content acceptance is inferred.

## Follow-up: correlate the reading action with its own response

Execution `CI-HELPERS-20261104-C2`, base `51827141a801a7e93673393b09c4de2491dbcf61`, branch `codex/ci-helpers-20261104-c2`. The coordinator assigned only the Review-UX helper and this receipt through 16:25 UTC on 4 November 2026. The earlier candidate branch remains preserved.

The unmodified response-arrival filter failed naturally in a focused disposable run: 15 passed, 2 failed. With click event mark 627, dashboard request `46240.101` began at event 585 and responded at event 630; LV3 request `46240.109` began at event 648 and responded at event 656. Both returned 200 from the same fixture origin and `/api/v1/practice/next` path. Only the latter URL had `family=LV3`; both used the same synthetic preparation. Counting responses after the click therefore incorrectly included the earlier dashboard request and caused the dependent option check to have no target. This was observed directly without an artificial delay or fabricated response.

The helper now requires exactly one `Network.requestWillBeSent` after the click mark matching GET, the exact fixture origin/path, LV3 family and the selected preparation. It then requires exactly one response with that request ID. Real navigation, the exact released set/version check, visible rendered identity, full authored text, keyboard selection, desktop/mobile layout, return to index and writing duplicate-draft checks are unchanged.

Local evidence is deliberately untracked under the isolated worktree `D:/Hatoove/.worktrees/ci-helpers-20261104`:

- `.qa/ci-maint/review-ux-focus.mjs`: coordinator-approved focused runner derived from `tools/app-browser-check.mjs` at the base above. Only relative imports/root resolution and the main journey body changed: the body registers through the real form and invokes `verifyReviewUx`. Source-only copying, environment filtering, isolated Compose project/ports, synthetic account, project verification and verified teardown remain the shared harness implementations. No `--keep`, live app, provider call or learner data is used.
- `.qa/ci-maint/rux-c2-before.log`: naturally reproduced failure and temporary metadata-only CDP trace with the actual request IDs/URLs/event order. The temporary trace is absent from the delivered helper.
- `.qa/ci-maint/rux-c2-after.log`: final helper, 17 passed, 0 failed, including all 11 Review-UX legs. Both runs verified removal of their disposable projects.
- `.qa/browser/rux-c2-after/`: desktop, 390px dark and 320px light screenshots from the unchanged Review-UX captures.

The final helper passes `node --check` and `git diff --check`. This focused proof does not claim the full combined browser suite, axe coverage, physical-device acceptance or production deployment. Final combined integration and independent review remain the coordinator's next steps.
