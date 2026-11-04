# Scheduled browser coverage repair

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
