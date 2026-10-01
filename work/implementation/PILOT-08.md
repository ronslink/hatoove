# PILOT-08 — the Hatoove client: the shell replaces Certa at `/`

| | |
|---|---|
| Slice | PILOT-08 (client). **Partly delivered** — see §6 |
| Base | `1e7272c`; checker-first `6a55f63`; shell `3eaf0e9` (WIP) → `11d3671` |
| Branch | `codex/pilot-01-local-bringup` |
| Status | **Shell delivered, 5/5 legs. Not independently reviewed, not merged.** |

---

## 1. What was wrong

The design is the product's driver, and it drove exactly one page (`/signin`). Everything else at
`/` was the old single-user application — and it was still branded **Certa**, a different product's
name on our front page, in every screenshot and every record.

`tools/app-shell-check.mjs` put a number on it before the change: **six occurrences of "Certa"** on
the entry point, no link to the design system, and `/js/app.js` — the legacy SPA — still loaded.

## 2. What was built

```
public/app/index.html   the shell: sidebar + tabbar, four views (Heute, Üben, Fortschritt,
                        Einstellungen), skip link, German chrome
public/app/app.css      a thin TOKEN-ONLY layer. The design system already carries the layout,
                        dark mode and the 1100/860 px rules, so this adds only what a single-page
                        shell needs and never a raw value
public/app/app.js       session boot, account + settings from the owned API, a hash router,
                        settings save with explicit conflict handling, sign-out, account deletion
server.js               `/` now serves /app/index.html
```

The design system is loaded from `public/assets/design/` — the curated, hash-pinned assets from
PILOT-08a. This is the first view built on them.

## 3. Verbatim check output

```
=== PILOT-08 app shell check (port 4395) ===

PASS S1-entry-still-gated             an unauthenticated / is still redirected to /signin
     302 -> /signin
PASS S2-shell-is-hatoove              an authenticated learner receives the Hatoove shell
     8212 bytes; design system linked; shell layout present
PASS S3-no-certa-leak                 the served page contains no "Certa"
     the previous product name is gone from the entry point
PASS S4-no-legacy-modules             the shell loads no legacy SPA modules and holds no learner state
     1 shell script(s) scanned; no local storage API
PASS S5-real-endpoints-answer         the shell talks to the real owned endpoints
     /api/v1/account 200; /api/v1/settings 200 at revision 0

5 passed, 0 skipped, 0 failed
```

On the base (`6a55f63`) the same check reported `2 passed, 3 failed` — S3 with six occurrences of
"Certa", S2 with no design-system link, S4 still loading `/js/app.js`. `tools/page-auth-check.mjs`
remains **8/8**, so the gate did not regress.

Also verified inside the container: sign-up `200`, then `GET /` → `200` (8212 bytes), zero "Certa",
design system linked.

## 4. Three decisions inside the shell worth naming

1. **No browser storage, deliberately.** There is no client-side store. A fresh browser recovers by
   signing in again, because the session cookie and the server records are the whole of memory. That
   is why the check scans the shell's script for the storage APIs: their absence is the property, not
   an accident, and it is what stops a stale cache disagreeing with the database.
2. **It does not invent a working product.** The task catalogue route does not exist, so *Üben* and
   *Fortschritt* say exactly that, and the dashboard names the missing route
   (`GET /api/v1/tasks`). Sample data would have read as a working feature.
3. **uk/ar/tr are listed and disabled, with the reason shown.** The shipped font subsets lack their
   glyphs — measured in `MFP-DESIGN-DECISIONS.md` (231 and 226 mapped codepoints; no Cyrillic, no
   Arabic). Disabling them honestly is not the same as dropping them from the agreed target.

The settings form handles a `409` by loading the current values and telling the learner their view
was stale, rather than pretending the save succeeded.

## 5. What this changes about the plan's ordering

The plan placed the client after the backend slices. That was wrong for two reasons, and this slice
is the evidence: the design was the stated driver and drove nowhere, and a backend slice with no
client cannot be *seen*. The shell now exists, so PILOT-04's task list has somewhere to appear.

## 6. LIMITS — what this does not deliver

- **No rendered evidence. A browser was never run.** This proves the markup, the gate and the
  endpoints; it does **not** prove the layout is correct at 320/390/768/1024/1440 px, in both
  themes, or that Arabic would shape correctly. The real-device gate stays open, and emulation would
  not close it either.
- **PILOT-08 is partly delivered.** The shell, sign-in, settings and the honest empty states work.
  **Missing: the task list, the objective runner, writing, the result view with the explanation, and
  history** — each blocked on PILOT-04/05/06/07. The shell is a frame; the journey is not in it.
- **The old SPA still exists** in `public/` and is still reachable by its own paths for an
  authenticated learner. `/` no longer serves it, but retiring it is **PILOT-17** and has not
  happened. (Earlier text called this "PILOT-11a", which collided with PILOT-11 — the second exam,
  an unrelated slice.)
- **The invite code is not implemented.** Sign-up is open to anyone who can reach the server
  (`/api/auth/sign-up/email` has no invite check and no throttle) — R6, and the reason the pilot is
  intended to be invite-only.
- **The settings language is not validated by the server.** `SETTINGS_LANGUAGES` is empty
  (`settings.mjs:41`), so any ≤16-character string is accepted; the shell's dropdown is the only
  constraint. That is a server-side gap, not a UI one.
- Not independently reviewed; not merged; nothing pushed.

## 7. Next

1. **PILOT-04** — exam-scoped identity and `GET /api/v1/tasks`, which turns *Üben* from an honest
   empty state into a real list and unblocks PILOT-05.
2. **PILOT-02** — re-verify the unverified PR #89. The runtime still holds the `provisioner` role
   pool as a documented stopgap for the sign-up allowance insert, which is a security item rather
   than a display one.
3. **PILOT-14** — the platform-dependent migration digests: measured, unfixed, and it will bite the
   moment CI or a Linux worker touches a database this machine migrated.

See it with:

```
node tools/local-bringup.mjs        # or: docker compose up -d --build
open http://localhost:4300          # -> /signin -> the shell
```
