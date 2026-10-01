# CONFIG-ANON-01 — delete the unauthenticated machine-global config write

| | |
|---|---|
| Why | In hosted mode an anonymous same-origin caller could rewrite the server's machine-global `EXAM_DATE` through `POST /api/config`, and every later visitor then read it from `GET /api/config` |
| Base | `codex/integration-01` @ **`df1924abe90feae10293a2df476fdefa3b3fb33b`** |
| Branch | `codex/config-anon-01` |
| PR | https://github.com/ronslink/hatoove/pull/83 (against `codex/integration-01`) |
| Method | the real `node server.js` over real HTTP, `B1PREP_SAAS=1`, a throwaway `B1PREP_ENV_FILE`, a disposable PostgreSQL database, and **no cookie at all**. Synthetic data only |
| Status | **Done.** The probe fails 3/4 on the pre-fix tree and passes 4/4 here; every baseline suite re-run green |

## 1. Base

The dispatch names the base `df1924a`. When this branch was first cloned, `origin/codex/integration-01` was at
`20f8943`, and `df1924a` did not yet exist (`gh api …/commits/df1924a` → HTTP 422). It landed **while this slice was
in progress**: `df1924a` = `20f8943` + `tools/coord-config-anon-probe.mjs` (the coordinator's probe), and the tip
then advanced to `08acb21` (docs only). This branch is now based on **`df1924a`**, so the probe the dispatch refers
to — *"`tools/coord-config-anon-probe.mjs` already exists on the base"* — is present, unchanged, and gated here.

`df1924a` touches only the probe, and `08acb21` only adds two design documents, so `server.js` and
`saas-runtime-check.mjs` are byte-identical to `20f8943`. The earlier probe this branch briefly carried was
dropped in favour of the coordinator's.

## 2. The defect, reproduced (pre-fix tree)

`tools/coord-config-anon-probe.mjs` (the base's, unchanged) against the base tree, a real hosted runtime,
`B1PREP_SAAS=1`, a throwaway env file and **no cookie**:

```
FAIL V2: an ANONYMOUS same-origin POST /api/config is refused (expected 401/403/404)
     status 200 body {"ok":true,"examDate":"2099-01-01","saved":["EXAM_DATE"]}
FAIL V2: the server's env file was NOT rewritten by an anonymous caller
     env file now: # B1 Prep configuration.
# The provider key, base URL and model are operator settings: set DEEPSEEK_API_KEY,
# DEEPSEEK_BASE_URL and DEEPSEEK_MODEL in the server environment, never through a route.

E
FAIL V2: a later anonymous GET /api/config does not report the attacker's date
     status 200 body {"examDate":"2099-01-01"}
PASS V2 control: an anonymous GET of a learner route is still refused (401)
     GET /api/v1/account

1 passed, 3 failed
A FAIL here means the defect is REAL: the route must be deleted, not gated.
```

3 of the 4 legs fail on the base, exactly as the dispatch reported. The mechanism: the handler refused only the
three provider **field names** (`server.js:933`) and then handed the rest to `saveEnv(updates)` (`:945`), which
merged whatever it was given into `.env` and assigned it into `process.env` (`:239-242`). The D1 refusal was keyed
on names rather than identity, and `saveEnv` wrote any key it was given.

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

`saveEnv` (`server.js:220`) **still exists**. Its only caller is the `POST /api/config` handler (`:945`), which is:

* **unreachable from any HTTP route on a hosted runtime** — `saas && /api/config` returns early, so neither
  method is handled there; and
* still reachable on the **local single-user install** (`B1PREP_SAAS` off), where it remains the settings view's
  server-side persistence.

No other caller exists (`grep -n saveEnv server.js` → definition + the one call site). So the honest answer is:
**nothing from a hosted request path reaches `saveEnv`; the local single-user install still does.**

## 5. Checks — verbatim output

**`tools/coord-config-anon-probe.mjs` → 4/4** (now gated in CI's `postgres` job):

```
PASS V2: an ANONYMOUS same-origin POST /api/config is refused (expected 401/403/404)
     status 404 body {"ok":false,"error":"Unknown endpoint /api/config"}
PASS V2: the server's env file was NOT rewritten by an anonymous caller
     env file now: EXAM_DATE=
PASS V2: a later anonymous GET /api/config does not report the attacker's date
     status 404 body {"ok":false,"error":"Unknown endpoint /api/config"}
PASS V2 control: an anonymous GET of a learner route is still refused (401)
     GET /api/v1/account

4 passed, 0 failed
```

**`tools/saas-runtime-check.mjs` → 10/10.** Count unchanged at 10; **what changed is the one assertion** in §7:

```
10 passed, 0 failed
NOTE real server processes, real HTTP, synthetic accounts, stubbed provider, disposable database.
```

with the inverted check reporting
`[sign-up accepted=200, POST /api/config=404, GET /api/config=404, foreign=403, rebound=403]`.

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
6 passed, 0 failed
NOTE real server processes, real HTTP, real owned client. Database schema "hatoove" is reused, not dropped.
```

## 6. Discrimination — the check fails on the pre-fix tree

Rule 4: a check that cannot fail is not evidence. The base's probe, run against the base tree (`server.js` @
`20f8943`/`df1924a`) fails 3 of 4 legs (§2); against the fixed tree it passes 4/4 (§5). Its control leg passes on
both trees, so the failing legs are the route being present, not a dead runtime. CI runs it in the `postgres` job
precisely so the runtime is *ready* (leg 4's 401 control needs a live accounts port); without a database the
hosted runtime answers 503 and the probe would pass trivially — which is not discrimination (see LIMITS).

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
recorded in the check's body and in commit `29051d2`.

## 8. LIMITS

* **The route is removed on the hosted runtime only.** The local single-user install (`B1PREP_SAAS` unset) still
  serves `GET`/`POST /api/config` and still reaches `saveEnv` from a request path. If the dispatch's line — *"an
  env-writing function reachable from a request path is the thing that must be gone"* — is meant mode-independently,
  **this slice does not satisfy it**: closing that is the local-install cutover, not this slice. The hosted
  runtime, which is where the defect was reported, no longer reaches `saveEnv` from any route.
* **The gate is keyed on `B1PREP_SAAS`, not on "a session exists."** An accounts-mounted runtime *without*
  `B1PREP_SAAS` (which is exactly what `tools/session-boundary-browser-check.mjs` starts, with a synthetic owned
  API) still serves the route, and `GET` there still reports the shared `examDate`. Keying on the session
  condition (`identityRequired = saas || Boolean(owned)`) was implemented first and **rejected**: it breaks that
  reviewed rendered gate, whose "shared exam date" scenario is set through `POST /api/config`. A deployment that
  mounts accounts but omits `B1PREP_SAAS` is out of this slice by the dispatch's own §4 ("removing
  `B1PREP_SAAS`/`B1PREP_ACCOUNTS` is a separate slice").
* **D1's refusal is now unreachable on a hosted runtime** because the whole route is absent. That is a
  strengthening, but it means `provider-config-check`'s `POST` assertions only still pass because they run the
  local install. They were not touched, per the dispatch; they prove the local contract, not the hosted one.
* **The probe discriminates only on a ready runtime.** With no `OWNAPI_PG_*`, hosted mode answers 503 for every
  API route and all four legs pass regardless of whether the route exists. CI therefore runs it in the `postgres`
  job. Read outside that job, a green probe is not evidence.
* **Browser suites were not run.** The dispatch's baseline list does not include them, and none sets
  `B1PREP_SAAS` (`grep -rln B1PREP_SAAS tools/` → the probe, `coord-readiness-origin-probe`, and
  `saas-runtime-check`), so the hosted-scoped change cannot reach them. That is reasoning, not a run.
* **`/api/ai` metering is not fixed here** (the next slice, per §4). The open-sign-up + unmetered-proxy defect
  was observed and left alone.
* **`GET /api/config` on the local install still reports the machine-global `EXAM_DATE`.** That is the same
  value the hosted fix removes for visitors; on the local install it is the operator's own single-user setting.
