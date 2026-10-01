# SESSION-BOUNDARY-01 — issue #63 step B/S4: one session boundary for the application

Worker: **Claude (local Windows)** — the more complex slice, and Claude has quota again.
Execution id: `session-boundary-01-claude-20261001-a`.
Coordinator: `COORD-TAKEOVER-20260930`. Issued 2026-10-01. **Checkpoint 30 minutes · Expires 180 minutes.**

## Base

**`origin/codex/ownapi-03-persistent`** — record the exact SHA you check out. That branch is PR #60, the single
consolidated candidate, independently reviewed as **sound**, CI green on its reviewed head and again after the
review fixes. It carries the account mount, PostgreSQL persistence, account settings, D1 (operator-only provider),
the account UI, the design gate and the D2 language control.

## Why this slice, and why it is the next milestone

**[`ronslink/hatoove` issue #63](https://github.com/ronslink/hatoove/issues/63)** is the authority. Read it first.
Its verdict is that the application is still a **hybrid** — accounts and durable PostgreSQL modules sitting beside
active single-user paths — and that the next milestone is *"one complete authenticated, server-owned learner
journey."*

This is its **S4**, quoted:

> **S4 — The sign-in page is not yet the application's identity lifecycle.** `public/js/account.js` explicitly
> leaves progress, drafts and settings unwired. `app.js` loads the old progress store **before** account identity,
> then opens home. Only `account.js` imports the owned client in product code; `createDraftSession` and
> `setAccountScope` still have **no application callers**. Sign-out therefore does not establish clearing of the
> learner views, local store, late requests or pending writing work.
>
> **Required:** one application session boundary controlling route access, cache/store lifetime and all API
> clients. On startup, resolve identity **before** reading learner data; on sign-out, account switch or expiry,
> **clear private state and fence late responses**. Wire settings and writing to it. A fresh browser must list or
> resume its account's saved work without importing local files.

## What to build

1. **One session boundary, resolved before learner data.** Today `app.js` reads the progress store and opens the
   home view, and identity is a separate page. The order must become: **resolve identity → then read learner
   state**. A signed-in learner's data must not be rendered from a local record and then swapped; that is how a
   stale or foreign record flashes on screen.
2. **Sign-out, account switch and expiry clear private state and fence late responses.** Concretely: no learner
   text, notebook entry, ability model or settings value from the previous account may remain readable, and an
   in-flight response that resolves **after** the switch must not land. `public/js/owned-client.js` already
   provides generation fencing — use it, do not re-implement it.
3. **Wire the pieces that already exist but have no caller.** `public/js/store.js` exports
   `setAccountScope`/`clearAccountScope` (F-4, proven by `progress-scope-check` 7/7) and
   `public/js/draft-session.js` is the account-scoped draft service (proven by `draft-session-check` 18/18). The
   boundary is what gives them a production caller.
4. **Settings and writing go through it too.** The settings page already writes the account-scoped record when
   signed in (`public/js/ui.js`); make that go through the boundary rather than reaching for the client itself.
5. **A fresh browser must resume from the server.** Sign in on a clean profile and the account's saved work must be
   listed or resumable **without importing any local file**.
6. **Do not break the single-user path.** With accounts disabled or the learner signed out, the app must behave
   exactly as it does today. That is a hard constraint, and it is what makes this slice safe to land.

## Acceptance checks — report ACTUAL output

1. **New `tools/session-boundary-check.mjs`**, following the real-HTTP, real-server-process pattern of
   `tools/accounts-http-check.mjs` (read it first — it already proves sign-up, ownership, the restart property and
   the origin gate). Using **synthetic accounts only**, it must show:
   - **order**: learner data is not read before identity resolves (assert the request order, not just the result);
   - **sign-out**: the previous account's text, notebook and settings are unreadable afterwards;
   - **account switch**: account B never sees account A's record, and an in-flight response for A that resolves
     after the switch **does not land**;
   - **fresh browser**: a clean profile that signs in can list or resume the account's saved work with **no local
     file imported**;
   - **expiry or a refused session** fails closed to signed-out rather than to the old single-user path.
2. **New `tools/session-boundary-browser-check.mjs`**, headless Chromium, isolated port, disposable source-only
   copy, following `tools/account-ui-browser-check.mjs`. It must prove the same three things a page can show:
   the correct order, that sign-out clears the visible learner state, and that a **late response after sign-out
   does not repaint** the previous learner's work. `$env:CHROME_PATH` on this host.
3. **Discrimination for each new refusal**: in a scratch copy outside the repository, re-open one path (for
   example let a late response land) and show the checker **fails**. Paste both outputs.
4. **Baseline unchanged**: `check.js` **101** · writing **9** · feedback **14** · server-origin **16** ·
   `reset-check.mjs` **8** (deliberately reduced; do not restore 9) · revision **8** · keymask **12** ·
   progress-equal **10** · owned-client **31** · owned-api **24** · draft-session **18** · mock-outcome **19** ·
   progress-scope **7** · design-check exit **0** · provider-config **11** · `accounts-http-check` **6** ·
   repository-check passes.
5. **`node tools/design-check.mjs` must stay at exit 0** — it is a gate, and a new view that introduces a raw
   colour, a raw font family or a computed German navigation label will fail it. That is intended.
6. `git diff --cached --check` clean; every `.mjs` run from a file; any file you write is **LF**, not CRLF.

## Deliverable

- Branch `codex/session-boundary-01` from the base you recorded.
- Allowed paths: `public/js/app.js`, `public/js/account.js`, `public/js/store.js`, `public/js/shell.js`,
  `public/js/ui.js`, `public/js/draft-session.js` (**only** to add what the boundary needs, never to change its
  contract), `public/js/owned-client.js` (**only** to add a method the boundary needs; say why),
  `tools/session-boundary-check.mjs` (new), `tools/session-boundary-browser-check.mjs` (new),
  `work/implementation/SESSION-BOUNDARY-01.md` (new).
- **Do not touch** `public/js/exam.js` (another slice's), `server.js`, `server/accounts.mjs`,
  `server/owned-api.mjs`, `server/owned-postgres/**`, `.github/**`, `package.json`, `MASTER-PLAN.md`,
  `IMPLEMENTATION_PLAN.md`, `work/BOARD.md`.
- **Commit and push EARLY AND OFTEN**: push the branch after each numbered item above, not once at the end. Two
  agent runs have died late in this programme having never committed; the rule exists because of them.
- Commit, push, open a **draft** PR.

## Boundaries

- **Synthetic accounts and a stubbed provider only.** No live AI call, no real credential, no real learner record.
  Never touch `D:\B1_Prep`.
- No deployment, no DNS, no production access.
- This closes **no** gate. Issue #63 states explicitly that it is not a production-security approval, and
  `P-03`/`X-01` remain open. The session port is still a small synthetic implementation, **not Better Auth** — do
  not imply otherwise in the UI or the report.
- **If the boundary cannot be built without breaking the single-user path, stop and report** rather than choosing
  for the product.
