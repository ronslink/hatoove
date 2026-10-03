# Q-01: automated rendered accessibility checks

Execution PILOT-Q01-AXE-20261003-A. Base is S6 `2f0ca7cac3f1be93350aba65b66702eb7b256485` (PR120). This is verification engineering under PILOT_BUILD_PLAN and Q-01. Automated checks do not establish full accessibility, physical-device behavior or product acceptance.

## Owned implementation

The author owns new `tools/a11y/package.json`, `tools/a11y/package-lock.json`, `tools/a11y-browser.mjs`, and scan/isolation edits only in `tools/app-browser-check.mjs`, `tools/learner-completion-browser.mjs`, `tools/exam-s5-browser-check.mjs`, `tools/exam-s5-browser.mjs`, `tools/payment-browser-check.mjs`, `tools/payment-browser.mjs`. Root owns CI, central records, this contract and any separately assigned product fixes. No application schema, runtime dependency, CDP framework or Docker configuration change is included.

Pin test-only `axe-core` exactly4.13.0, MPL-2.0; registry verification on3October2026 returned integrity `sha512-UzGt8zg7Ny8djbYMhxl2zuEevVa7r2gJjYY5Lwr1xM7+XU2nd6CkIWFTVcCIbAP63vSz71NaVyyuSk9lHKcy0A==`. Install with `npm ci --prefix tools/a11y --ignore-scripts --no-audit --no-fund`. Load locked local bytes; no CDN or production exposure. Assert reported engine version. [Upstream API](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md) and [releases](https://github.com/dequelabs/axe-core/releases) are the primary references.

## Gate and evidence

Enable via explicit `--axe` on the three runners. After the existing behavior assertion proves a state is visible, scan the whole document, including navigation and alerts. Use tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`. Every selected-rule violation fails, without blanket exclusions, severity filtering or disabled contrast rules. Preserve incomplete findings as manual-review work; never count them as passes. Engine/dependency/timeout/injection failure, zero scans or a missing required state fails.

Use a frozen required-state list per runner: auth sign-in/register/error; reset request/acknowledgement/new-password/invalid-token; objective pre-answer/post-answer; writing draft/rubric/pending/failed/assessed; history list/detail and conflict/offline/uncertain-save recovery; audio load-error/retry/loaded/playing/recovery/exhausted; checkout unavailable/offer/pending/error/activated. Preserve current real behavior assertions. A state may be renamed or split only with equivalent explicit coverage recorded before final review. Do not label a loading skeleton as its completed state.

All required states get desktop/light scans. Repeat representative auth, objective, writing result/recovery, audio and checkout at390px/dark and320px/light, restoring the original viewport/theme. Await fonts and stable DOM, scan serially; do not consume playback allowance to manufacture a state. Use a sufficiently long bounded technical audio fixture if necessary and record that it is synthetic.

Prove the gate discriminates: a separate same-origin disposable tab must scan clean, then a visible unnamed button must fail the exact production assertion specifically with `button-name` and its unique selector; removal must restore clean. Close the tab in finally. Separately prove omission of a required state fails. Expected control violations are labelled separately from application results.

Persist per-state JSON and a summary even on failure: source revision, engine/configuration, state ID, viewport/theme, token-free URL path, pass count, violations with selectors and incomplete findings. Capture a screenshot for failed states. Keep artifacts ignored or in CI artifacts; no cookies, credentials, reset links or browser storage. Terminal output is a concise state/rule summary.

## Isolated execution

Fence the app runner's inherited deployment/payment/content/OWNAPI/COMPOSE environment, explicitly choosing internal-preview, payments off and empty keys. Preserve only needed browser/tool settings. All fixtures use generated unique Compose project names, free loopback ports and source-only copies that exclude `.env`, private QA, learner data and node_modules. No learner4300/55440 or existing volumes. Verify actual project/schema/labels before synthetic administrative setup and project-only cleanup. Payment behavior uses the existing stub/synthetic callback; reset uses synthetic unknown-email/invalid-token paths. No external provider, email, Stripe call or real approval.

A local author run is authorized only under its current explicit disposable-service lease. Run the three suites sequentially to bound resource use; stop and report meaningful product violations with exact state/selector before requesting extra source ownership. Do not suppress a defect to make green.

## Integration and acceptance

Root wires the locked dependency and existing app/S5/payment `--axe` runs into the scheduled/manual rendered CI job, with always-retained private artifacts using a verified SHA-pinned upload action. The hosted app command explicitly selects `--design-evidence=served-only` because design originals are intentionally untracked: it records original-reference verification as not performed, retains all pinned served-asset and rendered checks, and rejects unknown modes. Default local runs still require the supplied originals through HATOOVE_DESIGN_ROOT and verify them; no missing reference becomes a passing original audit. Measure duration before adjusting timeouts. This is not a new mandatory PR browser gate; actual hosted runs and the existing account block stay explicit.

Independent review verifies the lock, isolation, discriminator, coverage manifest and any fixes. Accept only when required scans and retained behavior checks pass, incomplete manual items are listed and generated resources are removed. Human screen-reader, keyboard, touch, real iPhone/Android and qualified accessibility review remain separate.
