# ACCOUNT-UI-01 — the sign-in surface (Konto)

Execution: `account-ui-01-openclaw-20261001-a` (OpenClaw/Hetzner). Coordinator: `COORD-TAKEOVER-20260930`.
Branch: `codex/account-ui-01`. Draft PR to `main`.

## Base

`origin/main` does **not** carry `server/accounts.mjs` (checked: `git cat-file -e origin/main:server/accounts.mjs`
fails). As the task allows, this branch is based on **`origin/codex/ownapi-03-persistent` @
`6af93cb4e59ee822d823be76095bc02826af2b30`** — the branch that mounts the owned API (`server/accounts.mjs`) and
the settings port. `origin/main` at fetch time was `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e`.

## What this slice adds

The account server side was built and proven (`tools/accounts-http-check.mjs`), but no page imported the client,
so no human could reach it. This slice is the surface and nothing more.

- **`public/js/account.js`** (new) — the Konto view. It creates the transport exactly once with
  `createOwnedClient({ fetchImpl })` (a thin `globalThis.fetch` wrapper, because calling `fetch` detached from
  `window` throws "Illegal invocation"). Signed out it shows an e-mail/password sign-in form and a sign-up form
  (name, e-mail, password); signed in it shows the account e-mail and a sign-out button. While a request is in
  flight every control is disabled and no outcome is shown; a refused sign-in renders as an error, never as a
  signed-in state. Failure messages are derived from the client's stable `code` plus the server's error token
  (`detail`), so e.g. a 401 `invalid_credentials` reads "E-Mail-Adresse oder Passwort stimmt nicht." and a 409
  `user_exists` reads "Für diese E-Mail-Adresse gibt es schon ein Konto."
- **`public/index.html`** — one `<div id="account-nav">` in the sidebar, beside `#nav` and above the footer.
- **`public/js/app.js`** — imports the view, registers `account`, and builds the "Konto" entry into that div.
  The entry navigates through the existing `[data-shell-view]` delegation, so the drawer/close behaviour is
  reused. It is deliberately **not** a `#nav .nav-item`, so the legacy "all 12 views" navigation (and
  `tools/e2e.js`'s count) is untouched.
- **`public/js/shell.js`** — `markActiveNav` also marks the Konto entry when the account route is active.
- **`public/styles.css`** — a small account block, and `input[type="email"]` added to the shared control rule so
  the two e-mail fields are not the only inputs left with a browser-default width.
- **`tools/account-ui-browser-check.mjs`** (new) — the browser evidence (below).

## Honest copy and boundaries

The Konto page says plainly what the account is for ("Versuche, Entwürfe und Einstellungen dir folgen statt nur
in diesem Browser") and equally plainly that **this step only creates/opens the account**: existing browser
progress is not changed and **not yet** linked to the account, and without signing in the app works exactly as
before. No "synchronised everywhere" claim, no cross-device claim, no retention claim.

Also out of scope by instruction (and NOT done): attempts, drafts, progress and settings are not wired to the
account. `store.js` already exports the F-4 account-scope API (`setAccountScope` / `clearAccountScope`); this
slice deliberately leaves it unwired, which is why a signed-out learner keeps the exact legacy single-user path.
The account store behind this UI is the small synthetic session port, **not** Better Auth; nothing here implies
otherwise.

## Checks (actual output)

Run from files, one process each:

| checker | result |
| --- | --- |
| `node tools/check.js` | 101 passed, 0 failed |
| `node tools/writing-check.js` | 9 passed, 0 failed |
| `node tools/feedback-check.js` | 14 passed, 0 failed |
| `node tools/server-origin-check.mjs` | 16 check(s) passed |
| `node tools/reset-check.mjs` | 9 check(s) passed |
| `node tools/revision-check.mjs` | 8 check(s) passed (incl. pre-fix discrimination) |
| `node tools/keymask-check.mjs` | 12 check(s) passed |
| `node tools/progress-equal-check.mjs` | 10 check(s) passed (incl. pre-fix discrimination) |
| `node tools/owned-client-check.mjs` | 31 passed, 0 failed |
| `node tools/owned-api-check.mjs` | 24 passed, 0 failed |
| `node tools/draft-session-check.mjs` | 17 passed, 0 failed |
| `node tools/mock-outcome-check.mjs` | 19 check(s) passed (incl. pre-fix discrimination) |
| `node tools/progress-scope-check.mjs` | 7 check(s) passed (incl. pre-fix discrimination) |
| `node tools/repository-check.mjs` | passed (305 tracked files, 234 text blobs screened) |

## Browser evidence

`node tools/account-ui-browser-check.mjs` — **19 passed, 0 failed** (exit 0).

Chromium used: `/usr/bin/chromium-browser` on this host (`CHROME_PATH` unset; the check falls back through a
candidate list). It materialises its own disposable source-only copy, refuses ports 4321/4381, and mounts the
copy's `createServer` in-process twice: once with accounts off, once with a synthetic in-memory account store
that speaks the same `/api/auth/*` + `/api/v1/account` contract. No PostgreSQL, no provider call.

Proved on a real page over real HTTP:

1. accounts disabled — app boots (Übersicht), Lernplan and Einstellungen still render, `#nav` still has 12
   items, the Konto page honestly says "Konten sind auf diesem Server nicht aktiviert." and offers no fake form;
2. synthetic store — sign-up creates the account, the view shows the account e-mail, the forms are hidden, and
   sign-out returns to the signed-out forms;
3. a refused sign-in shows the server error and does **not** show a signed-in state;
4. no console errors; no horizontal overflow at 390 px (Konto) and 1440 px (dashboard).

Screenshots (headless, emulated viewports): `.openclaw/tmp/account-ui/desktop-konto-signedout.png`,
`desktop-konto-signedin.png`, `desktop-konto-unavailable.png`, `phone-konto.png`, `desktop-dashboard.png`.
The check prints them to stdout on each run; they are scratch and are not committed.

## Discrimination

In a scratch copy **outside** the repository (`/tmp/acctui-discrim`, source-only), one central behaviour was
broken: the sign-in catch branch was changed to `paintSignedIn(view, { email })`, i.e. a **failed sign-in renders
as signed in**. The same check then fails exactly where it should:

```
FAIL  failed-sign-in-shows-an-error-from-the-server  [no error appeared]
FAIL  failed-sign-in-does-not-show-a-signed-in-state  [a refused sign-in rendered as signed in]
17 passed, 2 failed   (exit 1)
```

Same file, unmodified tree: `19 passed, 0 failed` (exit 0). The probe discriminates.

## What could NOT be verified

- **Server-side account behaviour over real HTTP with PostgreSQL.** `tools/accounts-http-check.mjs` owns that
  evidence and was not re-run here (it needs a database); this slice is only the page surface. The browser check
  uses a synthetic in-process store.
- **The real owned mount behind this page.** The browser proof mounts a synthetic API, not
  `server/accounts.mjs` + PostgreSQL; a live page against the real mount is not exercised.
- **Real devices.** Headless Chromium with emulated viewports only: no iPhone/Android, no software keyboard, no
  audio path. Emulated viewports do not replace device checks.
- **`tools/e2e.js`** was not run (browser, live server); only the `#nav .nav-item` count it pins (12) is asserted
  in the new check.
- **Any claim about account-scoped progress/drafts/settings.** Deliberately not wired here.
