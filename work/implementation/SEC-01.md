# SEC-01 — reject cross-origin API state changes and constrain `baseUrl` (fixes F-1)

| | |
|---|---|
| Task / execution | SEC-01 / `sec-01-openclaw-20260930-a` (coordinator `COORD-TAKEOVER-20260930`) |
| Worker | OpenClaw/Hetzner, slot 3, independent of the auditor (finding written by Claude) |
| Base | `origin/main` @ `82ae9c28081893076243babd77ce21c1354496c2` |
| Branch | `codex/sec-01-origin` |
| Allowed paths | `server.js`, `tools/server-origin-check.mjs`, `tools/server-origin-check.test.mjs`, `work/implementation/SEC-01.md` |
| Fixes | `work/implementation/P-03A-PRIVACY-AUDIT.md` finding **F-1 (High)** |
| Status | Boundary fix implemented and proven at the HTTP layer. **This closes no security or privacy gate.** Human `P-03` review remains required. |

## What F-1 was

The local server binds `127.0.0.1` only, so it is **not remotely exploitable** and must not be
described as internet-exposed. But the learner's own browser can be pointed at the port by any
page they visit: the same-origin policy stops that page *reading* a response, not *sending* a
request. `POST /api/config` parsed the body as JSON regardless of `Content-Type`, so a
cross-origin "simple request" (no preflight) reached the handler, which wrote `DEEPSEEK_BASE_URL`
into `.env`. The AI path then sends the stored key as `Authorization: Bearer …` to that URL.

## The fix (`server.js`)

1. **Same-origin gate for state changes.** Any non-GET/HEAD request under `/api/` must come from
   this server's own origin, else `403 {code:"origin_rejected"}`. The `Host` header must be a
   loopback name on the port the server is listening on (blocks DNS rebinding), and `Origin` (or
   `Referer` when `Origin` is absent) must be `http://<loopback>:<that port>`.
   - **Deliberate choices** (documented in a comment at `isSameOriginRequest`): a missing `Origin`
     is *not* trusted, because browsers send `Origin` on every non-GET request including
     same-origin ones, so trusting an absence would reopen the blind-POST path. `Origin: null` and
     a foreign/absent `Referer` are rejected too.
2. **JSON content type required** for body methods (POST/PUT/PATCH): non-`application/json`
   (parameters such as `; charset=utf-8` tolerated) is `415 {code:"json_required"}`. This closes
   the "simple request" path that needed no preflight.
3. **`baseUrl` constrained.** `validateBaseUrl` accepts `https:` always, and `http:` only when the
   host is loopback (the documented local mock-provider path); anything else is
   `400 {code:"invalid_base_url"}` and `.env` is not written.
4. **No learner-facing change.** `public/**` is untouched; no login system; GET/HEAD read paths and
   static assets are unaffected.
5. **Testability, not a behavioural change.** `createServer()` is exported and `server.js` only
   binds a port when it is the directly-invoked entry point, so the suite can start it in-process.
   A new `B1PREP_ENV_FILE` override (mirroring `B1PREP_PROGRESS_FILE`) lets the tests point `.env`
   at a throwaway path; the learner's real `.env`, if any, is never read or written.

Precedent: `spikes/auth-runtime/server.mjs:22,25` (`403 origin_rejected`, `415 json_required`).

## Before / after (same probes, HTTP layer)

Against the pre-fix `server.js` (`git show 82ae9c2:server.js`, offline, synthetic values):

| Probe | Before | After |
|---|---|---|
| `POST /api/config`, foreign `Origin`, JSON | **200**, wrote `.env` | **403** `origin_rejected`, `.env` untouched |
| `POST /api/config`, no `Origin`, JSON | **200** | **403** `origin_rejected` |
| `POST /api/config`, own `Origin`, `text/plain` | **200** (`Content-Type` ignored) | **415** `json_required` |
| `POST /api/config`, `baseUrl: http://attacker.example/v1` | **200**, `.env` wrote that host | **400** `invalid_base_url`, `.env` untouched |
| `GET /api/health`, foreign `Origin` | 200 | 200 (read paths unchanged) |
| `POST /api/config`, own `Origin`, JSON | 200 | 200 (learner path unchanged) |

The "before" run really did persist `DEEPSEEK_BASE_URL=http://attacker.example/v1` from a
foreign-origin request, which is exactly F-1.

**Proven at the HTTP layer only.** No browser was started, so this does not prove what any
specific browser sends or blocks; it proves the server's own decision for each request.

## Acceptance checks — all real and reproducible

`node tools/server-origin-check.mjs` — **16/16 PASS** (exit 0). `node --test
tools/server-origin-check.test.mjs` — **10 tests, 10 pass**. Each check starts the fixed server
in-process on an ephemeral loopback port with no real `.env` (a throwaway temp `.env`), asserts
the status and the stable token, and where relevant diffs the throwaway `.env` before/after.
Required checks: `post-foreign-origin-rejected-without-env-write`, `post-absent-origin-rejected`,
`post-text-plain-rejected`, `post-same-origin-json-accepted`, `baseurl-http-nonloopback-rejected`,
`baseurl-https-accepted`, `get-foreign-origin-still-works` (plus `Origin: null`, foreign `Referer`,
missing `Content-Type`, Host-rebinding, `file://`, loopback-`http`, no-`Origin` GET and static GET).

Existing baseline still passes:

| Command | Result |
|---|---|
| `node tools/check.js` | **101 passed, 0 failed** |
| `node tools/writing-check.js` | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | **14 passed, 0 failed** |
| `node tools/repository-check.mjs` | passed (245 tracked files; 174 text blobs screened) |

## Boundaries observed

- No `.env` with a real key: every value is synthetic (`origin-check-synthetic-value-not-a-real-key`),
  and the suite writes only to a temp directory. No credential was read, printed, committed or sent.
- No browser, database, live provider or AI call. Node tests only, offline.
- No edits to `public/**`, `docs/**`, `tests/fixtures/**` or `spikes/**`.

## Not done / not verified

- Browser-level behaviour was not observed; the cross-origin attack is proven at the HTTP layer.
- `referer`-only requests from a same-machine page are accepted as same-origin (a Referer is not a
  security boundary); the `Host`+loopback+port check is what keeps this narrow.
- Remaining F-2..F-11 are out of scope for this task. This fix does not close finding F-7
  (masked key on `/api/health`) or F-3 (AI disclosure).
- `P-03` human review remains required; no security or privacy gate is closed here.
