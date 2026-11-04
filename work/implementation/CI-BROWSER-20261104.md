# Scheduled browser coverage repair

**Hosted follow-up:** the original nine-suite results below are local results. Hosted run [41853452292](https://github.com/ronslink/hatoove/actions/runs/41853452292) passed the main app suite (234/234) and S3 (14/14), then S4 stopped at fresh-document bootstrap (3 passed, 1 failed). The full hosted gate is not green; the B13 investigation below does not claim the cause is fixed.

Task [181](https://github.com/ronslink/hatoove/issues/181), execution `CI-BROWSER-20261104-B`. Base `6f4f84ca749e335cc77534bcfd6e3094bafcf233`; separate branch `codex/ci-browser-20261104-checks`. Coordinator runtime fix `6e114c3` is applied for final validation (local equivalent `92891b6`). This slice owns test harnesses and this record only; runtime fixes are authored and reviewed separately.

## Why the later checks failed

The scheduled suite stopped before these tests at an earlier authentication check. Running the later checks exposed selectors from the pre-redesign navigation, partial-form start cards that no longer exist, and text geometry that counted clipped screen-reader text as visible wrapping. The checks now drive current controls and history routes. [RETIRED-CHECKS](RETIRED-CHECKS.md) records each retarget and the remaining supported property.

S3/S4 use exact synthetic API-created historical section runs to verify preserved saved-work behavior. They do not reintroduce removed partial-form start cards. The complete public DTZ flow in S6 still starts through the real learner interface. Save, conflict, recovery, original text, exam ownership, credit, audio, finalisation and immutable result assertions remain enforced.

## Baseline discrimination

| Suite | Before repair | Observed cause |
| --- | --- | --- |
| S3 | 2 passed / 4 failed | Replaced settings acknowledgement copy; unsupported-view switch regression; removed per-set and partial-start controls. |
| S4 | 2 passed / 2 failed | Removed partial-start catalogue prevented the remaining historical writing lifecycle from running. |
| S5 with axe | 21 passed / 2 failed | Retired return link; practice form tested against mock-mode allowances. |
| Payments with axe | 23 passed / 1 failed | Focus probe used removed `lang-btn`, now `header-language`. |

After the S3 harness retarget, 13 of 14 checks passed; the one remaining failure was the real preparation-switch bug. Its unsupported-section assertion was retained and reported to the coordinator before the runtime correction. After the S4 retarget, the full lifecycle ran and produced 12 passes plus two false geometry alarms: visible criterion text was on one line, but the old range counted clipped `sr-only` text and nested translation spans. The corrected geometry examines visible text nodes and must detect a deliberately wrapped band before checking real layouts.

The first later sweep also exposed old full-mock intro/history attributes and the explanation suite's retired per-set cards. S6 now uses the current complete-start control and clicks the actual saved-run history link after admission closes. The old explanation per-answer/race and exact DTZ LV4 review scenarios are explicitly module-unavailable fallback compatibility, with the browser block cleared in `finally`. The normal telc runner is separately exercised: visible prose must match the actual evidence response, language rereads must request/acknowledge English, and displayed prose language/direction must match the authoritative returned language, including truthful fallback. Independent review identified and closed that language-request assertion gap before final delivery.

## Validation

All nine downstream suites are green; delivered for independent final review and coordinator integration. Completed final checks:

| Command | Result | Disposable project / evidence |
| --- | --- | --- |
| `node tools/exam-s3-browser-check.mjs` | 14 passed, 0 failed | `.qa/exam-s3/hatoove-s3-browser-1793803111363-55032` |
| `node tools/exam-s4-browser-check.mjs` | 14 passed, 0 failed | `.qa/exam-s4/hatoove-s4-browser-1793803207069-53596` |
| `node tools/exam-s5-browser-check.mjs --axe` | 23 passed, 0 failed | `.qa/exam-s5/hatoove-s5-browser-1793803302447-51872` |
| `node tools/payment-browser-check.mjs --axe` | 24 passed, 0 failed | `.qa/payments/hatoove-payments-browser-1793803412074-43480` |
| `node tools/exam-s5b-browser-check.mjs` (unchanged) | 8 passed, 0 failed | `.qa/exam-s5b/hatoove-s5b-browser-1793802465035-7476` |
| `node tools/exam-s6-browser-check.mjs` | 7 passed, 0 failed | `.qa/exam-s6/hatoove-s6-browser-1793803752020-22376` |
| `node tools/exam-s6-browser-check.mjs --locale` | 18 passed, 0 failed | `.qa/exam-s6/hatoove-s6-browser-1793802803662-54004` |
| `node tools/exam-s6-browser-check.mjs --review` | 10 passed, 0 failed | `.qa/exam-s6/hatoove-s6-browser-1793803606658-19292` |
| `node tools/explanation-browser-check.mjs` | 21 passed, 0 failed | `.qa/exam-s6/hatoove-explanation-browser-1793804006653-42860` |

All ten edited JavaScript modules pass `node --check`. The sequential sweep uses source-only disposable Docker projects, random loopback ports, synthetic accounts and stub payment/assessment providers. No live learner install, production data, real payment or live model call is used. Each suite owns and removes its temporary containers, volumes and source fixture. Logs and screenshots remain in ignored `.qa` evidence. Early S6/review/explanation cleanup guards rejected the current `media` service; those exact owned fixture projects were inspected and removed with their own Compose files and unique image tags. The corrected guard retains strict project-label/tag checks. No global prune or other fixture cleanup was performed.

The 320-pixel final S4 feedback and S6 player screenshots were visually inspected: criterion labels, bands, German evidence and player controls fit without the false text-range collisions. The final current-runner explanation screenshots at 1440/light and 390/dark were inspected: actual German original prose and the truthful unavailable-English fallback status are visible. Relevant files are `s4-feedback-320.png`, `s6-public-player-320-dark.png` and `p07-current-telc-runner-explanation-{1440-light,390-dark}.png` within the corresponding evidence directories above. Axe results include explicit incomplete/manual findings; zero automated failures does not claim all manual accessibility checks passed.

## Preserved limitations and separate defect

[Issue 182](https://github.com/ronslink/hatoove/issues/182) records a pre-existing opt-in DTZ presentation defect: `public/app/part-index.js` still builds from telc-only part order/fallback facts, dropping DTZ LV4/LV5 and displaying telc-specific numbers. `public/app/mock-intro.js` also has static telc block metadata. This test repair does not certify those DTZ displays or alter exam facts. The retained S3 snapshot `.qa/exam-s3/hatoove-s3-browser-1793801984653-23428/s3-current-dtz-reading-tiles-known-gap.png` visibly shows the three telc-style reading tiles under the DTZ heading. Full-current S6 tests cover access, bindings and saved-run behavior, not the validity of those metadata labels.

Headless desktop and 390/320-pixel viewport evidence is not physical iPhone/Android keyboard or audio acceptance. Official exam validity, qualified content/language review and production publication remain separate.

## B13 hosted bootstrap investigation

Execution `CI-BROWSER-20261104-B13`, base `3ea1b78e7bc8f3ba682fcfcf0409417e8b509181`, branch `codex/ci-browser-20261104-b13-bootstrap`. Hosted job `126655608659` reported successful historical-run creation, then timed out waiting for the visible app shell and preparation picker after a fresh document. It did not capture the boot message, route or network state, so neither a timing race nor a preparation chooser cause is established. Source inspection confirms the existing bare `#/lauf/<id>` route reads the saved run and resolves its owning preparation before unlocking the shell; that supported route remains unchanged.

The diagnostic correction rejects a failed `Page.navigate`, requires the exact destination origin, app path and unique navigation token, and validates the fixture's returned run/preparation identity. It retains the existing 20-second readiness timeout and all S4 journey assertions. A failure now records the requested and observed route, navigation result, shell state, boot message/choices, API response statuses, failed/pending request paths and bounded JavaScript exceptions, plus `s4-bootstrap-failure.png`. Headers, cookies and response bodies are excluded. It rethrows the original failure without choosing a preparation or retrying automatically.

The hosted failure did not reproduce in two new isolated local fixtures. The S4 baseline with diagnostic capture passed 14/14 in `.qa/exam-s4/hatoove-s4-browser-1793805183375-37364`, and the final document-identity diagnostic version passed 14/14 in `.qa/exam-s4/hatoove-s4-browser-1793805320949-39552`. Each exercised independent browser documents, fresh saved-run navigation and the complete writing/recovery lifecycle. Both projects were removed by their fixture cleanup. A new hosted run is required to collect the missing evidence or establish repeatability; these local passes do not establish a hosted fix.

## B14 player and writing-choice readiness

Execution `CI-BROWSER-20261104-B14`, base `187b0ac1650eaa0beb206e7466fca8171685fc2a`, branch `codex/ci-browser-20261104-b14-listening`. The coordinator's exact-head local run produced S5 with axe 22 passed / 1 failed at S5B8's immediate Load click, and S5B 7 passed / 1 failed at S5B07's immediate prompt-B click. The original server allowance, schedule and identity assertions had already passed.

The S5 failure was reproduced by holding the actual successful playback response for the newly created mock. Its real body retained zero plays used and a maximum of one. The player already had a status node, but the captured UI said `Hörstand wird bestätigt …` and contained only a disabled Reload button. The old immediate pointer operation deterministically raised the original `control unavailable [data-listening-action="load"]` error. The response is released and interception removed in `finally`, including setup failures. S5 actions now wait within the existing 15-second control budget for the exact requested control to be enabled and visible; all once-only, independent-attempt, recovery, fixed-deadline and cross-exam assertions remain.

The S5B failure screenshot and `mock.js` show the writing schedule can be active while boundary reconciliation still disables prompt choices. S5B07 now captures the choice/timing state at that point, then waits up to 10 seconds for the actual visible, enabled B control before clicking it. The local rerun observed an already enabled B with the confirmed-boundary message; it did not reproduce a disabled-B sample. The test still verifies the selected prompt is B and that finalisation preserves 45 objective items, two answers and the empty/unassessed writing outcome. No schedule, application or saved-work rule is changed.

The first corrected S5 run passed 23/23 in `.qa/browser/b14-s5`; its pending-response screenshot was visually inspected and matches the captured DOM/real response. S5B passed 8/8 in `.qa/exam-s5b/hatoove-s5b-browser-1793809379940-46672`. The final `node tools/exam-s5-browser-check.mjs --axe --shots .qa/browser/b14-s5-final` run, after independent review's interception-cleanup correction, also passed 23/23 in disposable project `hatoove-s5-browser-1793809476018-55696`. The final evidence includes `s5-mock-playback-receipt-pending.png` and the existing desktop/390/320 player captures; logs are `.qa/b14-s5-final.log` and `.qa/b14-s5b.log`. All three disposable projects were removed by their wrappers. These remain synthetic/headless checks, not physical-device acceptance.
