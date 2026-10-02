# CONFIG-ANON-01 — delete the unauthenticated machine-global config write

Current verification, 2 October 2026, COMPLETE-20261002-A: the route is deleted. The outer authentication boundary returns exact401 for anonymous calls; authenticated calls return exact404 Unknown endpoint. The seven-leg probe checks both states, a working synthetic session, and byte-identical configuration. The original pre-fix tree fails five legs. Earlier404-only expectations below record the prior SaaS gate and are superseded by this contract.

| | |
|---|---|
| Why | `POST /api/config` required no identity and wrote the shared `EXAM_DATE` into the server's `.env` for any same-origin browser; `GET /api/config` then read it back to every visitor |
| Base | `codex/integration-01` @ **`20f89433dfa22d3d9135d833232d32236466b739`** |
| Branch | `codex/config-anon-01` |
| PR | https://github.com/ronslink/hatoove/pull/83 (against `codex/integration-01`) |
| Method | the real `node server.js` over real HTTP, `B1PREP_SAAS=1`, a throwaway `B1PREP_ENV_FILE`, a disposable PostgreSQL database, and **no cookie at all**. Synthetic data only |
| Status | **Done.** All baseline suites re-run green; the probe fails on the pre-fix tree and passes here |

## 1. Base

The dispatch names the base `df1924a` ("it must be df1924a or later on that branch"). **That commit does not
exist on the remote**: `git cat-file -t df1924a` → *not a valid object name*; `git ls-remote origin | grep df1924a`
→ nothing; `gh api repos/ronslink/hatoove/commits/df1924a` → **HTTP 422 "No commit found for SHA"**. The current
tip of `codex/integration-01` is `20f8943`, and the defect, the file layout and the dispatch's own line references
(`server.js:927-948`, `:239-242`, `saas-runtime-check.mjs:676-680`) all match that tip exactly. The base used is
therefore the branch tip, `20f89433dfa22d3d9135d833232d32236466b739`.

The dispatch also states that `tools/coord-config-anon-probe.mjs` "already exists" on the base. **It does not exist
anywhere in the repository** (checked every remote branch and the full history for the filename). It was authored
here to the dispatch's four-leg description, and it reproduces the defect exactly as described (below).

## 2. The defect, reproduced (pre-fix tree)

`tools/coord-config-anon-probe.mjs` against the base tree (`server.js` @ `20f8943`), a real hosted runtime,
`B1PREP_SAAS=1`, a throwaway env file and **no cookie**:

```
coord-config-anon-probe: the unauthenticated machine-global config write (CONFIG-ANON-01)
  real hosted runtime (B1PREP_SAAS=1), throwaway env, disposable database, NO cookie sent.
  tree server @ /root/workspaces/hatoove-config01/server.js
  PASS  control-anonymous-learner-route-refuses  [GET /api/v1/account (no cookie) -> 401]
  FAIL  anonymous-post-config-is-404  [expected 404 for an anonymous POST /api/config, got 200 ({"ok":true,"examDate":"2099-01-01","saved":["EXAM_DATE"]})]
  FAIL  anonymous-post-config-writes-no-env  [the env file was rewritten with EXAM_DATE=2099-01-01]
  FAIL  anonymous-get-config-is-404  [expected 404 for an anonymous GET /api/config, got 200 ({"examDate":"2099-01-01"})]
  NOTE  add --server <path> to run the same probe against the pre-fix tree and show it fail.
  FAIL  3 of 4 leg(s) failed on this tree.
```

3 of the 4 legs fail on the base — exactly as the dispatch reported. The mechanism is the one in the dispatch:
the handler refused only the three provider **field names** (`server.js:933`) and then handed the rest to
`saveEnv(updates)` (`:945`), which merged whatever it was given into `.env` and assigned it into `process.env`
(`saveEnv` below). So the D1 refusal was keyed on names rather than identity, and `saveEnv` wrote any key.

## 3. The fix

`server.js`, in `handleApi`, before the `/api/config` handlers:

```js
  if (saas && pathname === '/api/config') {
    return false;            // falls through to the server's one generic 404
  }
```

On a hosted runtime (`B1PREP_SAAS=1`) **neither method is handled**; the request falls through to the server's
existing 404 (`{"ok":false,"error":"Unknown endpoint /api/config"}`), the same body any unknown endpoint gets. The
read goes with the write because `GET /api/config` reports the same machine-global `EXAM_DATE` to every visitor.

This is **deletion, not a gate**: an identity check on the route would leave a shared value that any signed-in
tenant could still write and every visitor still read. The replacement already exists — `GET`/`PUT
/api/v1/settings` serves `examDate` per account under the session-derived owner, with the revision and
validation story already proven (`accounts-http-check` 6/6, the stale-write `409`).

**D1 untouched.** The provider-field refusal and everything else about the handler are unchanged. The local
single-user install (`B1PREP_SAAS` off) keeps the route: its only consumers are its own single-user branch, and
removing it is the local-install cutover, not this slice (see LIMITS).

`public/js/` was **not** changed. Both `/api/config` consumers (`public/js/ai.js:28` `refreshStatus`, `:141`
`saveExamDate`; `public/js/app.js:306`'s single-user seed) are on the single-user branch, which keeps the route,
so no caller needed removing.

## 4. `saveEnv` — still exists, and what can reach it

`saveEnv` (`server.js:220`) **still exists**. Its only caller is the `POST /api/config` handler (`:945`), which
is:

* **unreachable from any HTTP route on a hosted runtime** — `saas && /api/config` returns early, so neither
  method is handled there; and
* still reachable on the **local single-user install** (`B1PREP_SAAS` off), where it remains the settings view's
  server-side persistence.

No other caller exists (`grep -n saveEnv server.js` → definition + the one call site). So the honest answer is:
**nothing from a hosted request path reaches `saveEnv`; the local single-user install still does.**

## 5. Checks — verbatim output

**`tools/coord-config-anon-probe.mjs` → 4/4** (the new permanent check; gated in CI's `postgres` job):

```
  tree server @ /root/workspaces/hatoove-config01/server.js
  PASS  control-anonymous-learner-route-refuses  [GET /api/v1/account (no cookie) -> 401]
  PASS  anonymous-post-config-is-404  [POST /api/config (no cookie) -> 404]
  PASS  anonymous-post-config-writes-no-env  [no EXAM_DATE=2099-01-01 in env-38749]
  PASS  anonymous-get-config-is-404  [GET /api/config (no cookie) -> 404]
  OK    4 leg(s) passed.
```

**`tools/saas-runtime-check.mjs` → 10/10.** Count unchanged at 10; **what changed is the one assertion**
described in §7:

```
PASS configured-public-origin-accepted-and-foreign-refused  [sign-up accepted=200, POST /api/config=404, GET /api/config=404, foreign=403, rebound=403]

10 passed, 0 failed
```

**`tools/check.js` → 101/0**

```
101 passed, 0 failed

All checks passed.
```

**`tools/design-check.mjs` → 11/11**

```
11 passed, 0 failed
```

**`tools/repository-check.mjs` → passed**

```
Repository check passed: 344 tracked files; 273 text blobs screened. This is not a complete secret audit.
```

**`tools/server-origin-check.mjs` → 16/16** (local install; unchanged, as the fix is hosted-scoped):

```
  OK    16 check(s) passed.
```

**`tools/provider-config-check.mjs` → 11/11** (local install; unchanged — D1 stays):

```
  OK    11 check(s) passed.
```

**`tools/owned-api-check.mjs` → 24/24** (memory backend):

```
24 passed, 0 failed (backend: memory)
```

**`tools/accounts-http-check.mjs` → 6/6** (disposable database):

```
PASS accounts-are-off-by-default
PASS a-learner-can-sign-up-and-own-an-attempt-over-http
PASS the-session-and-the-draft-survive-a-server-restart
PASS another-account-sees-nothing-and-sign-out-really-ends-the-session
PASS the-owned-routes-sit-behind-the-origin-gate
PASS settings-are-per-account-and-refuse-a-stale-write

6 passed, 0 failed
```

## 6. Discrimination — the check fails on the pre-fix tree

Rule 4: a check that cannot fail is not evidence. The **same** probe, run against the base tree
(`git worktree` of `20f8943`) via `--server`, fails 3 of 4 legs; against the fixed tree it passes 4/4:

```
  BEFORE/AFTER - same probe, source /root/workspaces/.configanon-prefix/server.js
  scratch server @ /root/workspaces/.configanon-prefix/server.js
  PASS  control-anonymous-learner-route-refuses  [GET /api/v1/account (no cookie) -> 401]
  FAIL  anonymous-post-config-is-404  [expected 404 for an anonymous POST /api/config, got 200 ({"ok":true,"examDate":"2099-01-01","saved":["EXAM_DATE"]})]
  FAIL  anonymous-post-config-writes-no-env  [the env file was rewritten with EXAM_DATE=2099-01-01]
  FAIL  anonymous-get-config-is-404  [expected 404 for an anonymous GET /api/config, got 200 ({"examDate":"2099-01-01"})]
  OK    discrimination: 3/4 legs fail on the source above (a fix whose probe cannot fail on the pre-fix tree is not evidence).
  OK    4 leg(s) passed.
```

The control leg passes on both trees, so the failing legs are the route being present, not a dead runtime.

## 7. The superseded assertion

`tools/saas-runtime-check.mjs`, `configured-public-origin-accepted-and-foreign-refused`, previously asserted:

```js
assert.equal(allowed.status, 200, 'the deployment origin must be accepted')   // POST /api/config
```

That asserted the defect as a pass. It is **superseded, not deleted**, because the property it names — *the
deployment's own origin is accepted by the gate* — is still true and still worth proving; only its vehicle
(`POST /api/config`, which no longer exists) is gone. The check now shows acceptance with a same-origin sign-up
(`POST /api/auth/sign-up/email` → 200) and then requires `POST /api/config` → 404 and `GET /api/config` → 404
under the deployment origin. The foreign-origin and rebinding-`Host` refusals are unchanged. The reason is
recorded in the check's body and in commit `5263428`.

## 8. LIMITS

* **The route is removed on the hosted runtime only.** The local single-user install (`B1PREP_SAAS` unset) still
  serves `GET`/`POST /api/config` and still reaches `saveEnv` from a request path. If the dispatch's line — *"an
  env-writing function reachable from a request path is the thing that must be gone"* — is meant mode-independently,
  **this slice does not satisfy it**: closing that is the local-install cutover, not this slice. The hosted
  runtime, which is where the defect was reported, no longer reaches `saveEnv` from any route.
* **The gate is keyed on `B1PREP_SAAS`, not on "a session exists."** An accounts-mounted runtime *without*
  `B1PREP_SAAS` (which is exactly what `tools/session-boundary-browser-check.mjs` starts, with a synthetic owned
  API) still serves the route, and `GET` there still reports the shared `examDate`. Gating on the session
  condition (`identityRequired = saas || Boolean(owned)`) was implemented first and **rejected**: it breaks that
  reviewed rendered gate, whose "shared exam date" scenario is set through `POST /api/config`. A deployment that
  mounts accounts but omits `B1PREP_SAAS` is out of this slice by the dispatch's own §4 ("removing
  `B1PREP_SAAS`/`B1PREP_ACCOUNTS` is a separate slice").
* **D1's refusal is now unreachable on a hosted runtime** because the whole route is absent. That is a
  strengthening, but it means `provider-config-check`'s `POST` assertions only still pass because they run the
  local install. They were not touched, per the dispatch; they prove the local contract, not the hosted one.
* **Browser suites were not run.** The dispatch's baseline list does not include them, and none sets
  `B1PREP_SAAS` (checked: `grep -rln B1PREP_SAAS tools/` → the probe, `coord-readiness-origin-probe`, and
  `saas-runtime-check`), so the hosted-scoped change cannot reach them. That is reasoning, not a run.
* **`/api/ai` metering is not fixed here** (the next slice, per §4). The open-sign-up + unmetered-proxy defect
  was observed and left alone.
* **The probe needs a disposable database.** Leg 4 (the 401 control) requires a *ready* accounts runtime, so the
  probe refuses to run without `OWNAPI_PG_DATABASE` rather than degrade to "not ready" 503s, which would make the
  control meaningless. It refuses `postgres`/`template0`/`template1`.
* **The probe is authored here, not inherited.** The dispatch asserted it already existed; it did not. The four
  legs are the dispatch's, verified failing on the base.
