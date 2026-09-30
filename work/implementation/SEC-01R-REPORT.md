# SEC-01R — independent review of the F-1 origin / baseUrl security fix

- **Reviewer:** Clawdbot 🏴‍☠️ (local, this machine) — independent reviewer, **not** the author.
- **Coordinator:** `COORD-TAKEOVER-20260930`. **Execution id:** `sec-01r-clawd-20260930-a`.
- **PR under review:** #38 (`codex/sec-01-origin`).
- **Commit under review:** `8e0a94be10883b4b9590e7e0025870a1670029a9` (repo clone `rosslink/hatoove`, reviewed against `origin/main` = `82ae9c2`).
- **Pre-fix code:** `git show 82ae9c2:server.js` (git blob `9cbfc1c04aeb4632bb96231359d28b3ca0d3e250`).
- **Date:** 2026-09-30.

## Verdict: **accept-with-notes**

The fix closes finding F-1 reproducibly and resists every bypass I could construct at the
HTTP layer. I found **no way to reach a state change through the new gate**. The notes
below are non-exploitable (a dead code clause and two "by design" clarifications), not
defects that block the fix.

Scope honesty is unchanged: the server binds `127.0.0.1`, so this was never remotely
exploitable; the reachable attackers are other local software and browser-mediated
requests such as DNS rebinding. I neither upgrade nor downgrade that classification.
This review closes **no** gate — human `P-03` review is still required.

---

## Method — my own probe (not the author's checker)

I wrote an **independent** probe (`scratch/probe.mjs`, reviewer-authored, not committed to
any branch) that starts both the fixed and the pre-fix server as **subprocesses** and drives
them over raw `node:http`. It:

- runs the fixed server with `B1PREP_ENV_FILE` pointed at a throwaway temp file and a
  synthetic key `SEC01R-probe-synthetic-not-a-real-key` (deliberately not `sk-` shaped);
- runs the pre-fix server from a temp directory, so its hard-coded `<ROOT>/.env` **is** the
  throwaway file and the repository `.env` is never in play;
- asserts HTTP status **and** that the throwaway env file is byte-unchanged after every
  rejected write.

The point of "write your own" is proven directly below: the probe **distinguishes old from
new**. A probe that passes on both would prove nothing.

```
== A-discriminate ==
  PASS  OLD foreign-origin baseUrl POST status            [expected 200 got 200]
  PASS  OLD .env rewritten to attacker baseUrl            [expected "http://attacker.example/v1" got ...]
  PASS  NEW foreign-origin baseUrl POST status            [expected 403 got 403]
  PASS  NEW error code                                    [expected "origin_rejected" got ...]
  PASS  NEW .env unchanged                                [expected null got null]
```

The single attack used in A (a foreign-`Origin` `POST /api/config` that tries to set
`baseUrl` to a non-loopback http host) **succeeds (200) and rewrites `.env` on
`82ae9c2`** and is **rejected (403 `origin_rejected`) with `.env` untouched on `8e0a94b`**.
That is the F-1 hole, closed.

Totals: **78/78 assertions pass** — 5 discrimination, 43 bypass/functional, 30 baseUrl.
Plus 3 raw-socket edge probes (all rejected).

---

## Check 1 — does the fix close the hole, reproducibly?

- Command (distinguishing probe): `node scratch/probe.mjs`
- New code: `POST /api/config` with `Origin: http://attacker.example`, body
  `{"baseUrl":"http://attacker.example/v1"}` → **403**, body
  `{"ok":false,"code":"origin_rejected",...}`, throwaway `.env` **unchanged** (still absent).
- Pre-fix code (`82ae9c2`) same request → **200**, `DEEPSEEK_BASE_URL=http://attacker.example/v1`
  **written into the throwaway `.env`**.

Result: **reproducible, and the probe distinguishes the two revisions.** PASS.

## Check 2 — attempt to bypass the gate (all against `8e0a94b`)

Every row: expected status / observed status / env-unchanged / "correct?".

| Probe | Expected | Observed | Correct? |
|---|---|---|---|
| No `Origin`, no `Referer` (POST json) | 403 | 403 | yes — blind cross-site POST is refused |
| `Origin: null` | 403 | 403 | yes — opaque origin refused |
| `Referer` merely *contains* loopback substring (`http://evil.example/?u=http://127.0.0.1:PORT/`) | 403 | 403 | yes |
| `Referer` loopback at a **different port** | 403 | 403 | yes |
| `Host` loopback at wrong port **+ `Origin` matching that wrong port** | 403 | 403 | yes — Host must be our port |
| `Origin` loopback, **different port** than the server | 403 | 403 | yes |
| `Origin: http://127.0.0.1:PORT@attacker.example` (userinfo `@` trick) | 403 | 403 | yes — parsed host is `attacker.example` |
| `Origin: http://127.0.0.1.evil.com:PORT` (loopback as a subdomain) | 403 | 403 | yes |
| `Origin: http://127.0.0.1:PORT@attacker.example` (Referer form, no Origin) | 403 | 403 | yes |
| `Host: attacker.example` (rebinding name) + matching `Origin` | 403 | 403 | yes — DNS-rebinding denied |
| `Origin: https://127.0.0.1:PORT` (same port, https scheme) | 403 | 403 | yes (fail-closed; app is http) |
| `Origin: http://localhost.:PORT` (trailing dot) | 403 | 403 | yes |
| **raw socket:** no `Host` header at all, foreign `Origin` | reject | 403 | yes |
| **raw socket:** duplicate `Origin` (loopback + evil) | reject | 403 | yes — comma-join fails parse |
| **raw socket:** absolute-form request URI + evil host | reject | 400 | yes — rejected by the HTTP parser first |
| `Content-Type: text/plain` (same origin) | 415 | 415 | yes |
| `Content-Type: application/x-www-form-urlencoded` | 415 | 415 | yes |
| `Content-Type: multipart/form-data; boundary=…` | 415 | 415 | yes |
| no `Content-Type` | 415 | 415 | yes |
| `Content-Type: application/json; charset=utf-8` (same origin) | 200 | 200 | yes — normal use preserved |
| `localhost:PORT` host **+** `http://localhost:PORT` origin | 200 | 200 | yes |
| `Origin: HTTP://127.0.0.1:PORT` (uppercase scheme) | 200 | 200 | yes — URL canonicalises scheme |
| `Origin: http://0177.0.0.1:PORT` (octal, canonicalises to 127.0.0.1) | 200 | 200 | yes — genuinely loopback |
| `PUT /api/config` foreign Origin | 403 | 403 | yes |
| `DELETE /api/progress` foreign Origin | 403 | 403 | yes |
| `GET /api/health` foreign Origin | 200 | 200 | yes — read path unaffected |
| `GET /api/config` no Origin | 200 | 200 | yes |
| `GET /index.html` | 200 | 200 | yes |
| `HEAD /index.html` | 200 | 200 | yes |

Every rejected case also left the throwaway `.env` byte-identical. **No bypass found.**
Notably, the simple-request/`text/plain` downgrade that the audit used to dodge preflight
is closed by the `415 json_required` rule, and the `Origin`-absent path is closed by the
deliberate "absent ≠ same-origin" choice.

## Check 3 — is the `baseUrl` constraint sound?

| `baseUrl` value | Status | Stored | Correct? |
|---|---|---|---|
| `https://api.deepseek.com` | 200 | `https://api.deepseek.com` | yes |
| `http://127.0.0.1:4321/v1` (documented mock path) | 200 | as given | yes |
| `http://localhost:9/v1` | 200 | as given | yes |
| `http://[::1]:9/v1` | 200 | as given | yes |
| `http://2130706433:9/v1` / `http://0177.0.0.1:9/v1` | 200 | as given | yes — canonicalise to `127.0.0.1` |
| `http://attacker.example/v1` | 400 | not written | yes |
| `http://localhost.attacker.com/v1` | 400 | not written | yes |
| `http://127.0.0.1.attacker.com/v1` | 400 | not written | yes |
| `file:///etc/passwd` | 400 | not written | yes |
| `gopher://127.0.0.1:70/_` | 400 | not written | yes |
| `javascript:alert(1)` | 400 | not written | yes |
| `https://user:pass@attacker.example/v1` | 200 | as given | **by design — see note 2** |
| `http://[::ffff:127.0.0.1]:9/v1` (IPv4-mapped IPv6 loopback) | 400 | not written | **fail-closed — see note 1** |

`https:` accepted, the documented loopback http mock path accepted, `http://attacker.example`
refused. Sound in the fail-closed direction. Two observations in Notes.

## Check 4 — did the fix change learner behaviour?

- `git diff --stat 82ae9c2 8e0a94b -- public` → **empty**: `public/**` is untouched.
- `git diff --name-status 82ae9c2 8e0a94b` → only `server.js` (M) and
  `tools/server-origin-check.mjs`, `tools/server-origin-check.test.mjs`,
  `work/implementation/SEC-01.md` (A). No redesign, no login/redesign surface, no new deps.
- Static serving, `GET /api/health`, `GET /api/config`, `GET /api/progress` behave as before
  (verified in Check 2). Static and HEAD paths still serve `200`.

## Check 5 — actual counts (measured, not trusted)

Run on the extracted `8e0a94b` worktree:

| Command | Claimed | Measured | Result |
|---|---|---|---|
| `node tools/server-origin-check.mjs` | 16/16 | **16/16, exit 0** | matches |
| `node --test tools/server-origin-check.test.mjs` | 10 pass | **tests 10 / pass 10 / fail 0** | matches |
| `node tools/check.js` | 101 | **101 passed, 0 failed** | matches |
| `node tools/writing-check.js` | 9 | **9 passed, 0 failed** | matches |
| `node tools/feedback-check.js` | 14 | **14 passed, 0 failed** (`public/js/ai.js`) | matches |

No per-suite split was misquoted; every published number reproduces exactly.

## Check 6 — are the testability changes safe?

- **`createServer()` export:** importing the module does **not** listen
  (`import('./server.js')` → `createServer` is a function, no banner, process exits).
  Safe and correct.
- **Port bind only when run directly:** `invokedDirectly` compares `process.argv[1]` to the
  module URL; behaviour confirmed (subprocess run binds; import does not).
- **`B1PREP_ENV_FILE` override:** resolved once at module load and used for **both** reads
  (`loadEnvIntoProcess`) and writes (`saveEnv`). It is reachable only from the launching
  process's environment — not remotely — so it is not an attack surface. Residual caveat in
  note 4.
- **Does the test path ever read a real `.env`?** No. The suite sets `B1PREP_ENV_FILE` before
  the dynamic import and its env path is asserted to live under the OS temp dir. I also
  placed a **synthetic sentinel** `.env` at the repo root, ran the author's checker, and the
  sentinel content was **unchanged**; sentinel then removed. The repository `.env` (which
  does not currently exist) is never read or written by the suite.

---

## Notes (non-exploitable)

1. **Dead clause / documented-intent gap (fail-closed).** `isLoopbackHostname` includes the
   bare string `'::ffff:127.0.0.1'`, but `new URL()` canonicalises an IPv4-mapped IPv6
   address to `'[::ffff:7f00:1]'` (bracketed, hex). The clause therefore never matches, and
   `http://[::ffff:127.0.0.1]:PORT` is **rejected** where the comment implies it is allowed.
   This is the safe direction (rejects rather than admits), so it is a cleanup note, not a
   vulnerability. No effect on the documented loopback mock path.
2. **`https:` to an arbitrary host is accepted _by design_.** `https://user:pass@attacker.example`
   and any other `https` host are stored. The constraint only blocks plaintext non-loopback
   http and the loopback-mock exception is narrow. The real control that prevents an attacker
   from retargeting the key is the **origin gate on the `POST`**, not the scheme rule — worth
   stating explicitly so the scheme rule is not mistaken for a host allow-list.
3. **Numeric loopback aliases** (`http://2130706433/`, `http://0177.0.0.1/`) are accepted
   because `URL` canonicalises them to `127.0.0.1`. They are genuinely loopback, so this is
   correct, not a bypass.
4. **`B1PREP_ENV_FILE` also redirects writes.** If someone is already able to set the server
   process's environment they can redirect `.env` writes; that presupposes local code
   execution, so it is not a privilege escalation. Flagged only for completeness.

## Could I break it? (explicit)

I tried: absent `Origin`, `Origin: null`, substring/different-port/`@`-userinfo/trailing-dot
origins, loopback-as-subdomain, Host/Origin port mismatches, DNS-rebinding `Host`, https
origin, duplicate `Origin`, missing `Host`, absolute-form URI, the four "simple request"
content types, `PUT`/`DELETE`, and the scheme/host forms in Check 3. **Every attempt was
rejected (or correctly allowed when it was genuinely same-origin/loopback).** No bypass.

## Limits of this review

- **HTTP layer only.** No browser was run and none is claimed; this proves the server's
  decision for each request, not any browser's behaviour.
- Offline. No real `.env`, no credential, no live provider/AI call, no database, no deploy.
  The only credential-shaped value anywhere is the synthetic string above.
- Read-only on the fix branch; the only file written here is this report.
