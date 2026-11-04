# Browser launch lifecycle — 4 November 2026

Execution `CI-MAINT-20261104-A5`, issue [#181](https://github.com/ronslink/hatoove/issues/181).
Branch `codex/ci-maint-20261104-a5-browser-launch`; base
`3efab64ce5a1dda9f0b668e7c5a6ab190ab5bc42`. This slice changes browser tooling only.

## Observed failure and limits

Hosted run [41856726637](https://github.com/ronslink/hatoove/actions/runs/41856726637),
job `126667264730`, failed before any feedback page interaction. Chrome's debugging endpoint
`/json/version` did not answer within the existing 15-second readiness window. The shared launcher
discarded stderr and did not inspect child liveness, so the original log cannot distinguish a bind
failure, child exit or a slow startup. Its orphan-cleanup log lists Chrome and wrapper/crashpad
processes. The `--version` preflight took about 10.8 seconds on image `ubuntu24/20261101.360.1`,
Chrome `156.0.8078.79`; the earlier run used a different image/build. This is evidence of an
environment difference, not proof of the original root cause or of a fixed hosted failure.

The feedback fixture also allocated and released its debugging port before Compose build/import,
leaving it unused until Chrome started. It now allocates immediately before launch. No collision was
proven in the historical failure.

## Change

- Keep the 15-second connection deadline and Chrome sandbox defaults. Bound each HTTP readiness
  request and the WebSocket/domain-enable phase by the remaining deadline; no launch retry is added.
- Reject an occupied debugging port before spawn. Capture at most 16 KiB of startup stderr and child
  spawn/exit facts, then match the debugging endpoint to that child's announced browser identity.
  Refuse foreign browser/page endpoints. Stop retaining stderr once identity is confirmed, before app
  navigation, so later application console output is not captured.
- On connection failure, retain bounded diagnostics and clean the owned launch. POSIX cleanup targets
  only its dedicated process group; Windows retains normal child termination with an exact-PID,
  hidden, bounded fallback if necessary. Await root closure and group termination. Profile-removal
  errors are reported without preventing the caller's remaining browser/Compose teardown. Cleanup is
  idempotent. This does not claim control over a Chrome descendant that creates an unrelated group.
- Clear resolved CDP command timers. Startup commands use the remaining connection budget; ordinary
  later commands retain their existing timeout.
- Feedback failures retain `chrome-startup.json` in the already-uploaded synthetic evidence directory.

## Evidence

- `node --test tools/cdp-launch.test.mjs`: Windows 8 passed, 1 POSIX-only skip; Linux Node 24 container
  9 passed. These use synthetic Node children and loopback HTTP/WebSocket, with no Chrome or Docker
  dependency in the test itself. They prove abort of a non-answering HTTP peer, refusal of an occupied
  port without touching its listener, prompt child/spawn failure, bounded stderr, browser/page identity
  refusal, no later stderr retention, a silent CDP peer stopped at the 15-second deadline, and private
  POSIX descendant cleanup while an unrelated child survives.
- Native Windows Chrome `156.0.8078.80` baseline connected in 425 ms; the owned-endpoint version
  connected in 510 ms. A three-browser smoke connected three distinct throwaway profiles and verified
  root closure/profile removal for all three, with no cleanup errors.
- The affected disposable feedback suite passed all 12 named legs, including desktop/phone audio,
  screenshot masking, survey persistence and upload recovery. The refined cleanup/deadline version
  also passed: `.qa/ci-maint/browser-launch-a5-final.log`, screenshots
  `.qa/browser/ci-launch-a5-final/`. A subsequent byte-bound tightening is covered by the focused
  multibyte-stderr test; it does not change launch or cleanup behavior.
- Linux private-group cleanup is proven with synthetic Node children. Native Linux Chrome/crashpad
  cleanup and the historical hosted startup condition still require the next hosted run.

Raw logs/screenshots remain ignored under `.qa/ci-maint/` and `.qa/browser/`. No app, provider,
production or deployment changes are included. Independent review and final hosted validation remain
the coordinator's responsibility; this author does not push or merge.
