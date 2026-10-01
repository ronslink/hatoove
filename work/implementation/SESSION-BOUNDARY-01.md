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
