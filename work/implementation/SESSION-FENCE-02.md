# SESSION-FENCE-02 — close two HIGH findings in the sign-out boundary (F-A, F-C), plus F-B

- Status: working
- Owner: Hetzner OpenClaw worker (bounded assignment)
- Branch: `codex/session-fence-02`
- **Base SHA: `e126d8c4b18a2beaf58eca2d279fe8d191e825ae`** (`origin/codex/ownapi-03-persistent`)
- PR: (opened after first commits)

## Findings addressed

| ID | Severity | One line |
|----|----------|----------|
| F-A | HIGH | A late mock-test answer crosses into the NEXT account's record (writing and speaking paths; mock gate's `isCurrent` stays true across an identity transition). |
| F-C | HIGH | A browser that never signed in is permanently locked out of its own record by a 500/malformed `/api/v1/account` answer. |
| F-B | MEDIUM | The N-2 discard notice is recomputed (not latched) and overwritten by the Konto view's own second resolve. |

## Coordinator product decision (F-C) — recorded

**The fix must NOT fail closed for a browser with no account history.**
Reason: the local single-user learner is the population that cannot recover. A browser that
never signed in has no server-side account to restore from, so moving it to `signed-out` on a
transient 500/malformed body destroys the only copy of their record. Treat an unreachable or
odd account endpoint as "accounts unavailable" (single-user, degraded), exactly as the 404
case already does.

## Checks (verbatim output in §Checks)

- F-A: failing check first, committed failing, then made to pass; discrimination leg for each.
- F-C: same.
- F-B: same.

## Discrimination legs

Every check: break the fix in a scratch copy, watch the check FAIL, restore.
Recorded per check below.

## LIMITS (unhedged)

- (filled in at completion)

## Baseline re-run (at base `e126d8c`, before any change)

Command environment: `OWNAPI_PG_HOST=127.0.0.1 OWNAPI_PG_PORT=55436 OWNAPI_PG_DATABASE=hatoove_fence02
OWNAPI_PG_USER=postgres`; disposable `postgres:17-alpine` container; `CHROME_PATH=/usr/bin/chromium-browser`.

```text
node tools/check.js                             101 passed, 0 failed
node tools/design-check.mjs                     11 passed, 0 failed  (exit 0)
node tools/repository-check.mjs                 Repository check passed: 326 tracked files; 255 text blobs screened.
node tools/draft-session-check.mjs              18 passed, 0 failed
node tools/owned-client-check.mjs               31 passed, 0 failed
node tools/session-boundary-check.mjs           13 passed, 0 failed
node tools/session-boundary-browser-check.mjs   52 passed, 0 failed  (headless Chromium, emulated viewports)
```

All seven match the dispatch's required baseline exactly.
