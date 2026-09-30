# OCLI-N1: closing the three review notes on OWNED-CLI-01

Execution `ocli-n1-hermes-20260930-a` (Hermes/Docker, slot 2), the author of `codex/owned-client-01`,
closing its own low-severity review notes from `ocli-r1b-20260930-a` (ACCEPT-WITH-NOTES).
Base `009d93139bf6157a2637a2dab07f69e969d7ef3a` (unrewritten); branch `codex/owned-client-n1`.
Changed paths: `public/js/owned-client.js`, `tools/owned-client-check.mjs`, `docs/contracts/OWNED-CLIENT.md`,
this file. No other file, dependency, CI, board or plan change. No push, no deployment, no live call,
no credential, no learner data, no browser, no database.

## Note 1 — superseded auth failure (hardening, implemented)

`authRequest()` now repeats the superseded-generation re-check in its catch path, exactly as
`refreshAccount()` already did, so a sign-in/sign-up that fails after `clear()`/`signOut()` reports
`stale_session` instead of `network_error` when there is no `AbortSignal` to honour. No authority
semantics changed: the local identity and generation are untouched by the error path, and an
unsuperseded auth failure is still `network_error` (asserted as a control in the new check).

## Note 2 — `fetchImpl` wording (documentation, implemented)

The contract doc claimed `config.fetchImpl` "is read **per call**". The code captures it once when
`createOwnedClient()` runs, so the doc now says **captured once, when `createOwnedClient()` is called**
and records that replacing `globalThis.fetch` afterwards does not change an existing client. The same
wrong sentence in the module's own JSDoc was corrected; the implementation is unchanged.

## Note 3 — 401 scoping (documentation, implemented per coordinator decision)

Behaviour is unchanged and the wording is now scoped: the "current-generation `401` invalidates the
local context" sentence applies to **learner calls** only, and a new "### The auth POSTs" section records
that a `401` from an auth POST is reported as `unauthenticated` and does **not** clear an existing
verified identity, because the learner's other session may still be valid; `getAccount()` stays `null`
only when no identity had been verified.

## Observed results

- `node tools/owned-client-check.mjs`: **31 passed, 0 failed** (28 at `009d931`; three checks added).
  Same checker against the unmodified `009d931` source: **29 passed, 2 failed** — both Note 1 checks
  failed with `expected code stale_session, got network_error (The request did not reach the server)`.
  That pair is the only difference between the two runs, so the fix is exactly as wide as the note.
- New checks: a superseded auth failure after `clear()` (plus a control proving an unsuperseded
  signal-less auth failure is still `network_error`), a superseded auth failure after `signOut()`, and
  the Note 3 wording (a `401` from an auth POST leaves `getAccount()`, the identity and the generation
  intact, and is not retried). All three run with `AbortController` removed from `globalThis`, which is
  the condition the note describes; the real `AbortController` is restored in a `finally`.
- Baseline unchanged: `check.js` **101 passed**, `writing-check.js` **9 passed**,
  `feedback-check.js` **14 passed**. `node --check` clean on both changed JavaScript files.
- `node tools/repository-check.mjs` passes (235 tracked files, 164 text blobs screened) and
  `git diff --cached --check` is clean.
- Boundaries still hold in `public/js/owned-client.js`: no `import`/`require`, no `process.env`, no
  storage/DOM/timer/navigator use, no absolute URL or `new URL`, no loop, no manual `Origin`; the only
  URL literals are the five fixed `/api/auth` + `/api/v1` path constants and the two
  `/api/v1/submissions/…` templates. Retry behaviour is unchanged: the suite still asserts that a
  timeout/uncertain POST is attempted exactly once and never replayed automatically.

## Decisions for the coordinator

1. I also corrected the duplicate "read per call" sentence in `owned-client.js`'s JSDoc. It is the same
   documentation defect in an allowed path; say the word if the JSDoc should stay byte-identical to
   `009d931` instead.
2. **Not changed, flagged:** `signOut()`'s catch path still has no generation re-check, so a sign-out
   that is itself superseded by another `clear()`/`signIn()` and then fails without `AbortController`
   would also report `network_error`. The note scoped the fix to `authRequest()`, and the documented
   sign-out semantics ("a failed sign-out still leaves the local identity cleared and reports the real
   failure") argue against changing it here. Needs a coordinator decision if uniformity is wanted.
3. The third added check asserts the Note 3 wording against the code. It passes on `009d931` as well, so
   it is documentation evidence, not a behaviour change; drop it if the note should carry no new check.
4. The doc's provenance line (execution `ocli-20260930-a`, base `074aebf`) is left as the historical
   record of the original execution.
5. No decision needed, recorded for completeness: nothing in the `009d931` history was rewritten; this
   is an additive delta on the reviewed commit.

## Limitations

Transport-boundary checks over injected fakes only. No server, browser, database, provider or learner
data was touched or verified, so no integration behaviour of a real `/api/auth` or `/api/v1` server is
established here. This closes no security, privacy or educational gate.
