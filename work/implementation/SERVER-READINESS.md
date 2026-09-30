# SERVER-READINESS — what still assumes a local, single-install machine

| | |
|---|---|
| Prompted by | Ron, 2026-10-01: *"however again we are running this application on a server not locally."* |
| Why this record exists | the programme has been fixing **findings** one at a time. This is the complementary view: the **structural** assumptions that a hosted deployment breaks, regardless of any individual finding |
| Source | every path and line below was read out of the code at `origin/codex/ownapi-03-persistent` @ `767e3fb` on 2026-10-01 |
| Verdict | **the application cannot be served from a server today.** Not because of a bug, but because four load-bearing pieces assume one machine and one learner behind `127.0.0.1` |

## 1. HARD BLOCKERS — a hosted deployment fails or is insecure on these, today

### B1. Same-origin checking only accepts a loopback origin

`server.js:250-285`: `LOOPBACK_HOSTNAMES` and `isLoopbackHostname()` are what `isSameOriginRequest()` accepts. A
request from `https://app.example.com` therefore **fails the origin check**, and since the SEC-01 gate refuses
foreign mutations, **every sign-in, save and settings write is rejected with 403** on a real host.

This is the single most blocking item: the security control that was correct for a local app is exactly what
prevents it from working on a server. The fix is not to loosen it — it is to make the **trusted origin
configuration-driven** (the deployment's own public origin) while keeping everything else rejected.

### B2. The server binds to loopback

`server.js:855`: `server.listen(PORT, '127.0.0.1', ...)`. Nothing outside the machine can connect. A hosted
deployment needs a configurable bind address, and the banner's hard-coded `http://127.0.0.1:${PORT}` (`:861`) says
the wrong thing to an operator.

### B3. Provider configuration is read once from a file, and written to that file

`server.js:28-30, 116, 182`: `ENV_PATH` defaults to `path.join(ROOT, '.env')`, read on load and **written on
`POST /api/config`**. Consequences on a server: configuration is **immutable without a restart and a writable
filesystem**, and the container may reasonably mount the code read-only. This is also the mechanism D1 removes —
after D1 the provider comes from the **environment**, which is the correct hosted shape.

### B4. Session cookies have no `Secure` attribute and no proxy awareness

`server/owned-postgres/sessions.mjs:82,153`: `HttpOnly; SameSite=Lax` only. On HTTPS a session cookie must be
`Secure`, and behind a load balancer the app needs to know it is on HTTPS. Loopback testing cannot exercise this, so
it is a real gap rather than an untested nicety. The session implementation is also the small synthetic port, **not
Better Auth** — no expiry sweep, rotation, revocation, recovery or abuse controls.

## 2. SCALING BLOCKERS — fine for one process, wrong for a service

| # | What | Where | Why it breaks |
|---|---|---|---|
| S1 | **Learner progress is a single JSON file**, written whole | `server.js:36-38, 74` (`PROGRESS_PATH`, per-account `${PROGRESS_PATH}.${id}`) | two processes cannot share it; a container filesystem may be ephemeral; and the whole record is rewritten per save, so it does not grow gracefully. The owned PostgreSQL attempt tables are the replacement |
| S2 | **Provider base URL is validated as loopback-or-https** with a local-file fallback | `server.js:305-306` | that rule exists to police a *learner's* choice; a server's own provider URL is operator configuration |
| S3 | **No `X-Forwarded-For` / trusted-proxy handling** | no occurrence in `server.js` | any rate-limiting or logging added later would see every learner as the load balancer's address |
| S4 | **In-process timers only** | the assessment **job** model is a PostgreSQL `jobs` table with leases (good), but nothing runs the worker in a hosted process | the job model is right; the *runner* for a deployed service is not yet defined |
| S5 | **Static files served from the repository tree** | `PUBLIC_DIR`, `DATA_DIR` (`server.js:23-24`) | workable if the code is baked into an image and served read-only, but it must be a stated deployment property rather than an accident |

## 3. What this changes about the plan

The ordered work in `PROVIDER-CONFIG-01.md` §4 stands, and this record **adds the four blockers as its own slice,
before or beside D1**, because D1 alone does not make the app servable:

| Order | Slice | Why here |
|---|---|---|
| 0 | **SERVER-READY-01 — B1 and B2** | nothing else can be tested on a real host until the origin check accepts the deployment's own origin and the server can bind beyond loopback. Both are small and both are **security-sensitive**, so they need their own checker with discrimination (a foreign origin must still be refused) |
| 1 | **D1** — provider operator-only and invisible | removes B3's write path as a side effect |
| 2 | **B4** — `Secure` cookies, documented proxy trust, and a decision on the session implementation | needs the deployment shape confirmed; it is a **security gate** item, not a tweak |
| 3 | **S1** — stateful views move to per-account owned attempts | this is the same work as "the stateful views move to the account record", and it is what retires the JSON file **and** `mergeProgress` together |
| 4 | **S4/S5** — define the job runner and the deployment's static-file contract | deployment-shape decisions |

## 4. The one-line summary

**Everything merged so far made the *boundary* multi-user. Nothing merged so far made the *process* a server.**
`SERVER-READY-01` is the slice that does, and it is the prerequisite for demonstrating any of the account work on a
real host.

**No gate is closed by this record.** `P-03`/`X-01` remain open, and three of the four blockers are security-relevant
enough that a human should read the fix, not just the checker.
