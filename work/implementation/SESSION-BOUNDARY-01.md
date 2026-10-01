# SESSION-BOUNDARY-01 — one application session boundary (issue #63 S4)

- Execution id: `session-boundary-01-claude-20261001-a` · coordinator `COORD-TAKEOVER-20260930`
- Worker: Claude (local Windows)
- Branch: `codex/session-boundary-01`
- Base: `origin/codex/ownapi-03-persistent` @ `9cccd97ae5d8c88a4f1a6d50d5b02b1f5dfa6ac3` (PR #60)
- Status: **delivered** — not independently reviewed, CI not yet observed on this head, not merged,
  not product-accepted. Closes **no** gate: P-03/X-01 stay open, and the session port is still the small
  synthetic implementation, **not Better Auth**.

## What changed

| Path | Change |
| --- | --- |
| `public/js/account.js` | `createSessionBoundary({client, store, pointers})` and the page's single `session()`. `resolve()` asks `/api/v1/account` first and only then opens the store in the matching scope; `signIn/signUp/signOut`, `saveSettings`, `openDraft`, `subscribe`. The Konto view drives the boundary instead of the client. Honest German copy for what the account now does. |
| `public/js/app.js` | No `store.load()` before identity. Boot awaits `session().resolve()`, then renders. Subscribes a repaint (`onSessionChange`) for sign-in/out/switch/expiry; re-resolves on tab return. The `/api/config` exam date is adopted only on the single-user path. |
| `public/js/store.js` | Scope epoch fencing every `/api/progress` read/write/delete/409 re-read across a scope change; `serverRev` reset per scope; the 409 re-read now carries the scope header; `setAccountScope(id, {adoptLegacy})`; `clearAccountScope({forget})`. Defaults unchanged. |
| `public/js/ui.js` | Einstellungen saves the account settings through `session().saveSettings()`; writes the shared `/api/config` exam date only on the single-user path. |
| `public/js/owned-client.js` | `saveSettings` accepts `expectedRevision: 0` (see below). No method added. |
| `tools/session-boundary-check.mjs` | New. Real server process, real HTTP, disposable PostgreSQL, real boundary/client/store. |
| `tools/session-boundary-browser-check.mjs` | New. Headless Chromium, disposable source-only copy, isolated ports. |

`public/js/draft-session.js` and `public/js/shell.js` were **not** changed.

### Phases and the fail-closed rule

`unresolved` → one of `single-user` · `signed-in` · `signed-out`.

| Server says | Browser never signed in (`legacy` scope) | Browser held an account (`scoped` / `signed-out`) |
| --- | --- | --- |
| verified account | `signed-in` (scope = that account, no legacy adoption) | `signed-in` |
| 401 | `single-user` — **unchanged legacy path** | `signed-out` (`expired`) — never the single-user record |
| 404 (accounts off) | `single-user` — unchanged | `signed-out` (`accounts_off`) |
| network failure | `single-user` (offline toast, as before) | at boot: `signed-out`; while signed in: kept (transient) |

Item 6 ("signed out behaves as today") is read as **never signed in on this browser**: that path is
byte-for-byte the old `syncFromServer()`. A browser that has signed out keeps the F-4 `signed-out` mode
(holds and persists nothing learner-derived), because the brief's acceptance check requires a refused
session to fail closed rather than return to the single-user record. **If the product wants a signed-out
browser to resume the single-user mode, that is a coordinator decision.**

### Sign-out, switch, expiry

- **Sign-out**: the last change is sent under the account's own scope (bounded, 4 s); then draft sessions
  drop their text, the store drops the record (`clearAccountScope`), and — only if that final save reached
  the server — the account's namespaced cache is removed from this browser (`forget`). Then the server is
  told. Draft pointers (ids only, no text) are kept so the same account can resume in this browser.
- **Switch**: a verified identity with a different id replaces the scope (`setAccountScope`), closes drafts
  and re-reads settings; owned-API late answers are fenced by the client generation (`owned-client.js`,
  reused, not re-implemented) **and** by the boundary's `live()` re-check; progress late answers by the
  store's scope epoch.
- **Expiry**: a 401 on any boundary-mediated call (settings, drafts) or on re-resolve fails closed to
  `signed-out`. An expired session keeps the account's local cache (no confirmed final save), unreadable by
  the app; that is the documented F-4 plaintext limitation.

### Deviations to review

1. **`owned-client.js` existing method changed.** The brief allows only adding a method. `saveSettings`
   required `expectedRevision >= 1`, but a settings record starts at revision 0 and the server's first
   write is `expectedRevision: 0`, so an account's **first** settings save from the page was impossible
   (the D2 settings page silently fell back to "lokal gespeichert"). Changed to accept 0 for settings only;
   drafts still require ≥ 1; `owned-client-check` stays 31/31.
2. **`store.js` 409 re-read had no scope header**: a signed-in account's conflict re-read adopted the
   legacy single-user record. Fixed as part of the fencing.
3. **Exam-date leak through `/api/config`** (shared server config) — found while wiring settings; fixed
   in `app.js`/`ui.js` and covered by the browser check.
4. **No legacy adoption.** The boundary passes `adoptLegacy: false` (issue #63 S1: never assign the local
   blob to an account automatically). The legacy key is left untouched. `setAccountScope`'s default is
   unchanged so `progress-scope-check` (which proves the F-4 adoption) stays 7/7.

## Evidence (actual output)

See the PR description for the pasted runs; summary:

- `node tools/session-boundary-check.mjs` — **6 passed, 0 failed** (disposable `postgres:17-alpine` on
  127.0.0.1:55435, `OWNAPI_PG_DATABASE=hatoove_spike`, same settings as CI).
- `node tools/session-boundary-browser-check.mjs` — **19 passed, 0 failed** (`CHROME_PATH` = local Chrome).
  Screenshots (scratch, not committed): `.openclaw/tmp/session-boundary/desktop-notebook-signed-in.png`,
  `desktop-notebook-signed-out.png`, `desktop-konto-signed-out.png`, `phone-konto-signed-out.png`.
- Discrimination: scratch copies under `D:\hatoove-work\sb01-scratch\mutants\<name>` (outside the
  repository), each re-opening one path; results in the PR.
- Baseline counts: see the PR.

## What is NOT done / NOT verified

- **Writing UI is not wired.** The writing view lives in `public/js/exam.js`, which another slice owns. The
  boundary gives `createDraftSession` its production caller (`session().openDraft(taskId)`, closed on every
  transition) but no view calls it yet.
- **A fresh browser cannot resume a writing draft.** Contract 0.1.0 has no owned list route and draft
  pointers are browser-local (issue #63 S6, server files out of scope). A fresh browser resumes the
  progress record (notebook, ability, history) and the account settings — not drafts.
- **`/api/progress` is still the F-4 header-attributed path** (issue #63 S1), not session-authorised. The
  boundary scopes it correctly, but the server would serve any caller naming the header. This slice does
  not and cannot fix that (server.js is out of scope).
- **Real devices**: headless Chromium with emulated 390/1440 viewports only — no iPhone/Android, keyboard
  or audio checks.
- **The real owned mount behind a page**: the browser check uses a synthetic in-process store; the
  real-mount + PostgreSQL proof is the Node check, which has no DOM.
- **`tools/e2e.js`** was not run (live server). Its 12-view nav count is asserted in the browser check.
- **Multi-tab**: a sign-out in another tab is noticed on `visibilitychange`, not instantly; no `storage`
  event listener was added.

---

# SESSION-BOUNDARY-02 — the defects the independent review found (appended)

- Execution id: `session-boundary-02-claude-20261001-a` · coordinator `COORD-TAKEOVER-20260930` · worker Claude (local Windows)
- Review answered: `session-boundary-review-hermes-20261001-a` (F1 HIGH, F2 HIGH, F3 MEDIUM, F4 LOW, F7)
- Branch: `codex/session-boundary-02`, a new branch, as the brief and dispatch name it, so PR #65
  (`codex/session-boundary-01`) stays exactly the head the reviewer attacked.
- Base: `origin/codex/session-boundary-01` @ `521e383a575aa7b4d43a5a09c466936457405be6`
- Commits (each verified with `git cat-file -e`): F1 `80c1500779c59272c4d1a616c9f99b051af1a45a` ·
  F2 `80bb32129df82954c26c19c676ad9523d860298c` · F3 `74a05fd464a869f907c266bffeb3b9b3fa484172` ·
  phone evidence and this record follow in the same branch (see the PR).
- Status: **delivered**. Not independently reviewed, CI not observed, not merged, not product-accepted. Closes
  **no** gate: issue #63 is not a production-security approval; `P-03`/`X-01` stay open; the session port is
  still the synthetic implementation, not Better Auth.

## F7 — the base SHA above is wrong

Line 6 of this record cites `9cccd97ae5d8c88a4f1a6d50d5b02b1f5dfa6ac3`. **That object does not exist.** The
real base of SESSION-BOUNDARY-01 is `9cccd97ee2660154e649d1d0bf6efb283ee62c56` (the parent of `c093786`, on
`origin/codex/ownapi-03-persistent`). Checked here:

```text
$ git cat-file -e 9cccd97ae5d8c88a4f1a6d50d5b02b1f5dfa6ac3^{commit}   -> MISSING
$ git cat-file -e 9cccd97ee2660154e649d1d0bf6efb283ee62c56^{commit}   -> OK
$ git rev-parse c093786^                                                -> 9cccd97ee2660154e649d1d0bf6efb283ee62c56
```

The record is append-only, so line 6 stays as written; **this correction supersedes it.** Every SHA in this
addendum was checked with `git cat-file -e` before it was written down.

## F1 — the browser copy is forgotten unconditionally (sign-out, expiry, switch)

**Decision: discard, not keep-in-another-form.** Any form the browser could reopen on its own (an encrypted
copy whose key lives in the same browser) is obfuscation, not protection: whoever can read the plaintext can
read the key. A form only the server can reopen needs a server-held key, and `server.js`/`server/**` are out of
scope. So the copy is removed, and the learner is told when that discarded a change.

| Transition | What happens to `b1prep.state.v1::<id>` in this browser |
| --- | --- |
| Sign-out (confirmed, held past 4 s, or offline) | removed — **every** account's record (`clearAccountScope({forget: true})`) |
| Any 401 on resolve or an account call (`expired`, `signed_out`) | removed — every account's record |
| Switch to another verified account | every **other** account's record removed (`setAccountScope(id, {forgetOthers: true})`) |
| Offline / refused (non-401 error) / accounts off, at boot | **kept, unread** (the store holds nothing; mode `signed-out`) for the same account to resume; the next 401, sign-out or switch removes it |

- The learner is told: when the final save did not confirm, the Konto page says *"Deine letzte Speicherung hat
  den Server nicht erreicht. Änderungen seit der letzten erfolgreichen Speicherung wurden zum Schutz deiner
  Daten aus diesem Browser gelöscht."* (also when the server sign-out itself fails). The "Was passiert mit
  deiner Arbeit?" card says the copy is deleted on sign-out even then. `signOut()` resolves with
  `lastSaveReached`; a failed server sign-out rejects with the same field on the error.
- **What is lost:** changes since the last confirmed save, on a sign-out/expiry/switch where the final save does
  not land. That is the price of not leaving plaintext behind; it is disclosed to the learner.
- **Pending-reset flags are now kept** (previously `forget` removed the current account's). They hold no text,
  and removing one would cancel a reset the learner asked for before it reached the server.
- **Kept on purpose, stated precisely:** at boot, offline / a refused answer / accounts off say nothing about the
  session, so the account's copy stays on disk unread. This is the one remaining case where an account's
  plaintext is in `localStorage` while the page is signed out.
- **Found while writing the check, pre-existing, not fixed:** an **offline** sign-out clears everything locally,
  but the server never hears it and the `HttpOnly` session cookie cannot be dropped by the page — so once back
  online the page resolves to the same account again (and re-reads its record from the server). The browser
  check signs out again online for that reason. A real fix needs the server (cookie expiry) or a persisted
  "signed out locally" intent; coordinator decision.

## F2 — the writing feedback path is fenced; a signed-out page refuses notebook text

- `store.js`: `scopeToken()` / `isScopeCurrent(token)` expose the existing scope epoch to view-level writers;
  `addError()` returns `null` on a signed-out page (defence in depth — the reviewer's M7).
- `exam.js` (writing feedback path only, +5 lines): the token is taken before `await ai.gradeWriting(...)`; if
  the scope moved (sign-out, expiry, switch) the answer is neither painted nor recorded.
- **M7 alone is not enough** (measured, below): with only the `addError` gate, A's late grading still lands in
  **B's** record and B's `localStorage` on a switch, and the attempts land on a signed-out page. The fence is
  what closes that.
- **Not fixed, outside the lease (exam.js writing path only):** the speaking feedback
  (`exam.js` ~1116 `await ai.gradeSpeaking` → `recordAttempt`/`addError`) and the mock writing grade (~1389
  `await gradeMockWriting` → `addError` ~1404) write after an `await` the same way. On a signed-out page their
  notebook text is now refused by the store gate; their `recordAttempt` calls and the **switch** case are not
  fenced. Same fix pattern; needs a lease on those paths.

## F3 — the single-user tab return

- **Fixed rather than re-worded, without weakening the hardening.** The single-user path reconciles once, when the
  page first resolves (the old boot-time `syncFromServer()`). A later `resolve()` on a page that is single-user and
  stays so re-checks identity only — no `/api/progress` request, and the in-memory record is never replaced.
- **What still differs from the pre-S4 app, precisely:** a tab return now issues one `GET /api/v1/account` (404
  with accounts off, 401 when nobody is signed in) — and if another tab of the same browser has signed in, the
  single-user tab moves into that account (the hardening; a guard check proves it is kept).
- **Found while checking F3, not fixed (reasoned from code, not executed):** on a browser that **never signed
  in**, an `/api/v1/account` answer that is not 401/404/offline (e.g. a 500 or a malformed body) — at boot or on a
  tab return — falls to `enterSignedOut('refused')` and **persists** the `signed-out` marker. From then on that
  browser never shows its single-user record again. That is a single-user behaviour change from SESSION-BOUNDARY-01;
  whether a never-signed-in browser should fail closed there is a coordinator decision.

## F4 — `theme` is not sent; recorded, not changed

The theme is browser-local (`certa-theme`, `app.js`) and was never in the store's settings, so the pre-S4 call
always sent the constant `'system'`, overwriting whatever the account held with a value the learner never
chose. Re-adding it would restore that. The right fix (send the theme actually applied) is in `ui.js`, outside
this slice's paths.

## Evidence (actual output, this machine)

Disposable `postgres:17-alpine` on 127.0.0.1:55435 (`OWNAPI_PG_DATABASE=hatoove_spike`, the CI settings);
`CHROME_PATH` = local Chrome; synthetic accounts; the AI provider is a stub in the browser check (no live call).

`node tools/session-boundary-check.mjs` at `74a05fd` — **12 passed, 0 failed**:

```text
PASS order: identity resolves before any learner data is read
PASS sign-out: the previous account text, notebook and settings are unreadable afterwards
PASS sign-out while offline: the account copy is gone from this browser and the learner is told
PASS sign-out with the final save held past the budget: the account copy is gone, before and after the answer lands
PASS expiry: a refused session forgets the account copy in this browser
PASS account switch: the previous account copy is gone from this browser
PASS account switch: B never sees A, and late responses for A do not land
PASS fresh browser: a clean profile resumes the account from the server, importing nothing
PASS expiry and a refused session fail closed to signed-out, not to the single-user record
PASS single-user path: accounts off, or never signed in, behaves as before
PASS single-user: a second resolve (tab return) neither reconciles again nor replaces the in-memory record
PASS single-user: a tab return still notices another tab signing in (the hardening is kept)
12 passed, 0 failed
```

`node tools/session-boundary-browser-check.mjs` at this branch's head — **38 passed, 0 failed** (19 before; the
new records are the F1, F2 and F3 branches above plus a 390 px check of the new notice). Screenshots (scratch,
not committed): `.openclaw/tmp/session-boundary/desktop-konto-signed-out-offline.png`,
`phone-konto-signed-out-offline.png`, plus the four from SESSION-BOUNDARY-01.

### Discrimination — the final checkers against `521e383` and against mutants

Scratch trees outside the repository (`git archive` of the commit, or a copy of the working tree with one exact
replacement, anchor asserted), run with `SESSION_BOUNDARY_ROOT`. The `521e383` row uses the **final** checkers
(12 Node checks, 38 browser records). The other rows were run with the checker as it stood at that step — 10
Node checks after F1; 26, 35 and 37 browser records after F1, F2 and F3 — and their totals are for that
version.

| Tree | Node check | Browser check | What fails |
| --- | --- | --- | --- |
| `521e383` (review head) | **7 passed, 5 failed** | **26 passed, 12 failed** | node: offline, held, expiry, switch, tab-return; browser: tab-return, held ×3, offline ×2, writing ×6 |
| `80c1500` (F1 only) | — | 29/35 (35-record version) | the 6 writing records |
| `80bb321` (F1+F2) | single-user subset: tab-return fails | 36/37 (37-record version) | `single-user-tab-return-does-not-replace-the-record` |
| M3 (reviewer's: sign-out never forgets) | 7 passed, 3 failed | — | confirmed, offline, held sign-out |
| f1a (forget only if the save landed — the 521e383 rule) | 8 passed, 2 failed | 23/26 | offline, held (node); held ×2, offline (browser) |
| f1b (expiry keeps the copy) | 9 passed, 1 failed | — | expiry |
| f1c (switch keeps the copy) | 9 passed, 1 failed | — | switch |
| f2a (no exam.js fence = the M7 gate alone) | — | 32/35 | attempts after sign-out; A's grading lands in B; reaches storage |
| f2b (no `addError` gate) | — | 34/35 | `a-signed-out-page-refuses-a-notebook-entry` |
| f3 (re-reconcile on every resolve) | tab-return fails | 36/37 | `single-user-tab-return-does-not-replace-the-record` |
| f3g (a single-user tab never re-checks identity) | both single-user F3 checks fail | 36/37 | `single-user-tab-return-rechecks-identity` |

On `521e383` the browser record shows the reviewer's S8 replacement through the real `visibilitychange` handler:
`/api/progress on tab return: [GET], newer record adopted: true`. (A first run said `adopted: false`: the
check's seeded notebook entries all had one id, so the server merge folded the newer entry into the old one —
a check defect, fixed before the commit.) Positive control for F2: with nothing changing while the grading is
held, it **does** land (`{"notebook":true,"writingAttempts":7}`), on every tree.

### Baseline at this head (unchanged)

```text
check.js 101 passed · writing-check 9 · feedback-check 14 · server-origin 16 · keymask 12 · reset-check 8 ·
revision 8 · progress-equal 10 · owned-client 31 · owned-api 24 (memory) · draft-session 18 · mock-outcome 19 ·
progress-scope 7 · design-check 11 passed, exit 0 · provider-config 11 · repository-check passed
```

## What is NOT verified

- **The reviewer could not run either checker** (no PostgreSQL, no browser in its container). The 12/12 and
  38/38 above, and the discrimination table, are **mine, on one Windows machine** — not independently reproduced.
- Headless Chromium with emulated 390/1440 viewports; no real iPhone/Android, keyboard or audio.
- The browser check uses a synthetic in-process account store and a stubbed AI provider; the real mount +
  PostgreSQL proof is the Node check, which has no DOM.
- The "500 on `/api/v1/account` makes a never-signed-in browser signed-out" finding and the bfcache/back-navigation
  risk (review §F6) are reasoned from code, not executed.
- The speaking and mock late writers (F2 residual) are not fenced and not tested.

## SESSION-BOUNDARY-04 — N-1: another tab re-created the account record after the forget

Execution `session-boundary-04-claude-20261001-a`. Branch `codex/session-boundary-04`, base
`origin/codex/ownapi-03-persistent` @ `c6bd889` (store/boundary code identical to `34c992c`). Draft PR #68.

**The defect** (review `session-boundary-02-review-hermes-20261001-a`, `S7b`/`S17`): `forgetAccountRecords()` was a
one-off sweep in the tab that ran it. Another tab still held the account in memory, and its ordinary write path
called `setItem` for `b1prep.state.v1::<id>` again — re-creating the key with the learner's text — while it kept
showing the account's notebook.

**The fix, both halves.**

1. **Marker + fence** (`store.js`). The scope marker `b1prep.scope.v1` was already shared by every tab; it is now
   the durable signal. It is written **before** the sweep (sign-out and switch), carries `forget: true` when the
   transition removed records, and holds no learner text. `writeLocal()` and `sendProgress()` refuse while the
   marker **positively** contradicts the scope the page holds in memory; `writeLocal()` re-checks after `setItem`
   and takes back a write that raced a marker change. A missing or unreadable marker does not fence.
2. **Follow** (`store.watchScopeChanges` / `followScopeChange`, `account.js followElsewhere`, `app.js`). The
   `storage` event (and a bfcache `pageshow`) makes the other tab drop the record and its queued writes, remove
   its own key again if the other tab forgot, go to the signed-out state and repaint — badge, open view and
   Konto. It never writes the marker (that is the other tab's).
   - A **sign-out** is followed without asking the server: the signing-out tab writes its marker before its
     sign-out request reaches the server, and a resolve in that window would verify the old session and sign the
     page back in. The Konto view paints a followed sign-out as it stands for the same reason.
   - A **switch** is resolved with the server like a tab return (the new cookie is set before the marker moves).
   - A page that is **already** signed out no longer overwrites another tab's newer sign-in marker or sweeps its
     record (`clearAccountScope`).
3. **The primary risk — the next sign-in must still save.** `setAccountScope()` always replaces the signed-out
   marker before anything is loaded or saved; if storage refuses that write, the marker is **removed** (a removal
   needs no quota), so the fence cannot lock out the account that just signed in.

### Evidence (actual output, this machine)

Same setup as above (disposable `postgres:17-alpine` on 55435, local Chrome, synthetic accounts, stubbed provider).
The browser check drives **two real pages of one headless Chromium profile** (second target via `/json/new`):
one cookie jar, one `localStorage`.

| Tree | `session-boundary-check` | `session-boundary-browser-check` | What fails |
| --- | --- | --- | --- |
| head `7b4d448` | **13 passed, 0 failed** | **52 passed, 0 failed** (three runs) | — |
| base (`c6bd889` code) | 12 passed, 1 failed | 43 passed, 9 failed | every N-1 record; the 38 earlier records and both save controls pass |
| step 2 `77c4f63` (marker, no follow) | 13 passed | 46 passed, 6 failed | tab 2 still scoped / shows A's notebook / badge "2"; tab 1 does not follow a switch |
| m1: sign-in does not replace the marker | 10 passed, 3 failed | aborts: `A copy back in localStorage (held-save precondition)` | the save control: "a sign-in after the forget could not save to the server" |
| m2: no write fence (follow kept) | 12 passed, 1 failed | 52 passed, 0 failed | node: "the second page re-created the account record" |

m2 is worth reading: in a real browser the storage event arrives fast enough that the follow alone kept storage
clean in this run — the fence is what holds when the event is late or absent (the Node check has no storage
event, which is exactly that case). Each half is discriminated by one checker.

Base detail (S17): `account keys holding A's text right after the sign-out: []; after tab 2 wrote:
[b1prep.state.v1::<A>]`, tab 2 `{"mode":"scoped"}`, `A marker on tab 2's screen: true`, `badge="2"`. S7b:
`sign-out finished 10 ms after tab 2 queued its 250 ms save; account keys holding A's text afterwards:
[b1prep.state.v1::<A>]`. Head controls: `flushNow=true; local keys: [b1prep.state.v1::<A>]; server record holds
it: true` (the tab that signed out) and the same for B signing in on the tab that only followed.

Baseline at the head, unchanged: check.js 101 · writing 9 · feedback 14 · server-origin 16 · keymask 12 ·
reset-check 8 · revision 8 · progress-equal 10 · owned-client 31 · owned-api 24 (memory) · draft-session 18 ·
mock-outcome 19 · progress-scope 7 · design-check 11 passed, exit 0 · provider-config 11 · repository-check
passed. Also run: account-ui-browser-check 25 passed.

### What is NOT verified (N-1)

- **No real phone, and no bfcache restore was exercised.** The `pageshow` follow is reasoned, not executed.
  Headless Chromium only; no Safari/Firefox, whose storage-event timing may differ.
- **Residual window:** a tab RETURN (or a page reload) in the few milliseconds between another tab's marker and
  its server sign-out landing still resolves against the old session and signs that page back in. The follow
  itself does not ask the server; the existing tab-return resolve does.
- A single-user (never signed in) page is not fenced or followed: it writes only the unscoped legacy key, which
  no forget removes. Not changed here.
- Only the progress record is fenced. Draft pointers (`b1prep.draft-pointers.v1`) hold identifiers, not text.
- Mine, on one Windows machine — not independently reproduced. Closes no gate; P-03/X-01 stay open.
