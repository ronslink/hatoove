# OCLI-N1R — independent review of the owned-client note closures @ `c5a39b4`

- **Reviewer:** Clawdbot (local, independent; not the author)
- **Execution:** `ocli-n1r-clawd-20260930-a` (coordinator `COORD-TAKEOVER-20260930`)
- **Candidate:** `origin/codex/owned-client-n1` = `c5a39b410baeb7aa241381daa8e2767b763d3182`
- **Base:** `origin/codex/owned-client-01` = `009d93139bf6157a2637a2dab07f69e969d7ef3a`
- **Method:** candidate extracted read-only (`git archive` → temp dir); baseline `check.js`/`writing-check.js`/`feedback-check.js`, the candidate's `owned-client-check.mjs`, and an **independent** AbortSignal-ignoring probe were run locally. No browser, server, database, `.env`, provider, live-AI call or credential was used. Structural consistency is not an exam/security/privacy approval.

## Verdict: **ACCEPT**

All six required checks pass. The three low-severity notes are correctly closed, the delta is honestly scoped to the four allowed files with no deletions, and — the decisive point — the new regression genuinely discriminates: it **fails 2/31 on the old implementation and passes 31/31 on the new one**. My own independent probe reproduces the same discrimination.

---

## Check 1 — Is the delta honestly scoped? ✅ PASS

Command:

```
git diff --name-status 009d93139bf6157a2637a2dab07f69e969d7ef3a c5a39b410baeb7aa241381daa8e2767b763d3182
```

Observed:

```
M	docs/contracts/OWNED-CLIENT.md
M	public/js/owned-client.js
M	tools/owned-client-check.mjs
A	work/implementation/OCLI-N1.md
```

`git diff --stat` = **4 files changed, 194 insertions(+), 12 deletions(-)** — exactly the coordinator's measurement. Exactly the four allowed paths; **no deletions**; **nothing outside those four changed** (the name-status list is the complete base→candidate delta). This rules out the previous failure mode where an integration silently reverted unrelated files.

## Check 2 — Does the Note 1 regression actually discriminate? ✅ PASS (the key check)

The new checker was run unchanged against the **old** `public/js/owned-client.js` (base `009d931`):

```
$ node tools/owned-client-check.mjs      # with the OLD impl in place
...
FAIL a superseded auth failure is stale_session, not network_error, when the transport ignores AbortSignal
  expected code stale_session, got network_error (The request did not reach the server)
FAIL a sign-out supersedes an in-flight auth call as stale_session
  expected code stale_session, got network_error (The request did not reach the server)
...
29 passed, 2 failed            (exit 1)
```

And the new checker against the **new** implementation:

```
$ node tools/owned-client-check.mjs
...
31 passed, 0 failed            (exit 0)
```

This matches the coordinator's observation exactly (29/2 on old, 31/31 on new), and the two failures are precisely the two Note 1 checks. **The regression discriminates — it is not worthless.** Integrity of the comparison was verified by content hash:

- old impl blob = `7495441f6e47f0efc976ab0c40215d35f608a8e9` (= `009d931:public/js/owned-client.js`) — the file actually run as "old" hashed to this;
- new impl blob = `7b15a79d712c0dda4c16209fee7ddb66c5576a05` (= `c5a39b4:public/js/owned-client.js`).

## Check 3 — Is Note 1 really fixed, by my own probe? ✅ PASS

I wrote an **independent** probe (separate from `tools/owned-client-check.mjs`) with a fake transport that **never honours `AbortSignal`**, with `globalThis.AbortController` removed so the signal is truly `undefined` — exactly the condition the note describes. It supersedes an in-flight `signIn` with `clear()` and again with `signOut()`, then lets the request fail, and asserts the rejection code. It also runs controls.

Independent probe results:

```
=== NEW (candidate c5a39b4) ===
OK   superseded-by-clear  failing auth: expected stale_session, got stale_session
OK   superseded-by-signOut failing auth: expected stale_session, got stale_session
OK   current-generation auth transport failure: expected network_error, got network_error
OK   current-generation auth 401: expected unauthenticated, got unauthenticated
OK   successful sign-in: got account id user-acct-a
PROBE RESULT: PASS

=== OLD (base 009d931) ===
BAD  superseded-by-clear  failing auth: expected stale_session, got network_error
BAD  superseded-by-signOut failing auth: expected stale_session, got network_error
OK   current-generation auth transport failure: expected network_error, got network_error
OK   current-generation auth 401: expected unauthenticated, got unauthenticated
OK   successful sign-in: got account id user-acct-a
PROBE RESULT: FAIL (2)
```

So my probe, built independently of the author's, distinguishes old from new and confirms: (a) the fix works for both `clear()` and `signOut()` supersession; (b) the **successful** path is unchanged; (c) a **current-generation** auth transport failure still reports `network_error` and a current-generation auth `401` still reports `unauthenticated` — the fix does not mask real failures with a wrong code.

## Check 4 — Are Notes 2 and 3 correctly reflected in the docs? ✅ PASS (I agree with scoping vs. changing behaviour)

The doc delta (`git diff … -- docs/contracts/OWNED-CLIENT.md`) does three things, each matching the code:

1. **Note 2.** The wrong "read **per call**" sentence is replaced with: `config.fetchImpl` "defaults to `globalThis.fetch` and is captured **once, when `createOwnedClient()` is called** … never re-read per call", plus an explicit note that replacing `globalThis.fetch` afterwards does not change an existing client. This matches the code, which reads `const fetchImpl = config.fetchImpl === undefined ? globalThis.fetch : config.fetchImpl;` **once** at factory creation (the code already did this at `009d931`; only the doc/JSDoc were wrong). I confirmed the old doc literally said "read **per call**".
2. **Note 3 (scoping).** The generation list now reads "a current-generation `401` from a **learner call** (`refreshAccount`, `createAttempt`, … `deleteAttempt`)" and adds "An auth POST is **not** one of these boundaries".
3. **Note 3 (explicit statement + reason).** A new "### The auth POSTs" section states that a `401` from an auth POST does **not** clear an existing verified identity — "the learner's other session may still be valid" — and that `getAccount()` stays `null` only when no identity had been verified. This matches the code: `authRequest` maps a non-2xx to `failure()` without calling `invalidate()`; only `interpret()`'s current-generation learner `401` invalidates. The doc also records the new Note 1 behaviour ("a superseded sign-in/sign-up failure is also `stale_session` rather than `network_error`").

**On the model/queue question — I agree with the coordinator's decision to scope the wording rather than change behaviour.** A failed `signIn`/`signUp` (e.g. bad password) is not authority for tearing down an already-verified session; preserving the existing identity there is the more defensible semantics, and it is what the code does. Scoping the doc to learner calls is the correct fix; changing behaviour would have been the wrong call.

## Check 5 — Are the security boundaries preserved? ✅ PASS

Greps over `cand/public/js/owned-client.js`:

- **No imports / `require`:** none (`^\s*import\b|require\(` → empty).
- **No `process.env`:** none (`process\.` → empty).
- **No storage/DOM/timers:** none (`setTimeout|setInterval|localStorage|sessionStorage|document\.|window\.|indexedDB` → empty anywhere, not just at module scope).
- **No absolute URL / `baseURL` parameter:** the only hit is a prose comment; no `new URL`, no `https?://` usage, no `origin` header set.
- **Fixed same-origin routes only:** the URL literals are the five path constants (`/api/v1/account`, `/api/v1/attempts`, `/api/auth/sign-up/email`, `/api/auth/sign-in/email`, `/api/auth/sign-out`) plus the two `/api/v1/submissions/…` templates; the checker's route-allowlist check passes.
- **No automatic POST retries:** the checker's "attempted exactly once / never replayed" assertions pass on the candidate.
- **`events`/`eventId` preserved for an uncertain POST:** `submit()` still sends the caller's `eventId` and the suite's uncertain-POST case asserts the same `eventId` is reused with no automatic replay.

The impl diff between base and candidate is limited to the Note 1 catch-path re-check plus two comment lines — no boundary was loosened. Nothing blocking.

## Check 6 — Actual counts (measured, not trusted) ✅ PASS

On the extracted candidate (`D:\clawdbot\cand`):

| Suite | Command | Observed |
|---|---|---|
| owned-client (new) | `node tools/owned-client-check.mjs` | **31 passed, 0 failed** |
| baseline | `node tools/check.js` | **101 passed, 0 failed** |
| baseline | `node tools/writing-check.js` | **9 passed, 0 failed** |
| baseline | `node tools/feedback-check.js` | **14 passed, 0 failed** |

All four match the claims (31/31, 101, 9, 14).

---

## Non-blocking observations

1. **`signOut()`'s own catch path still lacks a generation re-check.** The author flagged this in `OCLI-N1.md` (decision #2). A `signOut()` that is itself superseded by a later `clear()`/`signIn()` and then fails without `AbortController` would report `network_error` rather than `stale_session`. The note scoped the fix to `authRequest()`, and the documented sign-out semantics ("a failed sign-out still leaves the local identity cleared and reports the real failure") arguably want the real failure reported; this is a coordinator call, not a defect in scope. I did not treat it as a finding.
2. **The third added check (Note 3 wording) also passes on `009d931`** (as the author notes). That is expected: it is documentation evidence, not a behaviour change. Both failing checks on the old code are Note 1 behaviour checks, so the discrimination is real and minimal.

## Bottom line

`c5a39b4` closes all three notes without widening the change surface: honest 4-file delta, a regression that fails on the old code and passes on the new, an independently reproduced semantics fix that leaves success and current-generation-failure paths intact, doc wording that now matches the code, and every transport boundary still intact. **Accept.**

---

*Independent review, injected transports only. No server, browser, database, provider or learner data was touched; no security/privacy/educational gate is closed by this report.*
