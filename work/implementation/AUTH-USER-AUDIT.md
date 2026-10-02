# AUTH-USER-AUDIT — does the application meet the SaaS user model?

| | |
|---|---|
| Asked by | Ron, 2026-10-01 |
| The requirement, verbatim | *"a user can login, configure their language etc in settings, and use the application, logout and find their data still exists and keeps track of their performance"* |
| Method | every claim below was read out of the code at `origin/main` `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e` on 2026-10-01, not from memory or from a worker report |
| Verdict | **the requirement is NOT met. Every one of its five steps is missing or only half-built.** |

## 1. The flow, step by step, against the code

| # | Step the user must be able to take | State in the code | Evidence |
|---|---|---|---|
| 1 | **Log in** | **Missing.** There is no sign-in, sign-up or sign-out surface anywhere in `public/**`: no route, no form, no session cookie handling. The browser never calls `/api/auth/*`. | `public/` contains one page (`index.html`) and one entry module (`app.js`); grepping `public/**` for `signIn`, `signUp`, `signOut`, `/api/auth` or `/api/v1` finds **only comments inside `owned-client.js` and `draft-session.js`** |
| 2 | **Configure language etc. in settings** | **Device-local only, and not per account.** The settings view writes into the same unscoped progress record that everything else uses; there is no server-side settings concept at all. | `app.js:245` registers the `settings` view; `store.getState().settings` holds `examDate`, `dailyGoal`, `model`, `writingTaskIndex`; theme is a bare `localStorage` key `certa-theme` (`app.js:157`) |
| 3 | **Use the application** | **Works, for one anonymous user.** Objective practice, writing, the mock exam and feedback all run against a single implicit learner. | the app is fully functional today *because* it assumes exactly one user |
| 4 | **Log out** | **Missing.** Nothing to log out of. `owned-client.js` implements `signOut` (31/31 checks) and `draft-session.js` implements a fenced sign-out, but **nothing in the app calls either**. | the only `signOut` implementations are in modules with no caller |
| 5 | **Come back and find the data, with performance tracked** | **Half-built, and the half that exists is unreachable.** Progress is a single `progress.json` plus one `localStorage` blob, merged rather than replaced; it is *not* account-scoped in the running app. Attempts, drafts, submissions and assessments are account-scoped **in PostgreSQL**, behind an API that `server.js` never mounts. | `server.js:757` `createServer({ ownedApi = null })` and `server.js:807` calls `createServer()` **with no argument**, so the owned API is never active; the account-scoped store merged as `3a8c266` (F-4) has **no production caller** — it needs `setAccountScope`, which only the missing sign-in could supply |

## 2. What exists but is unreachable

This is the strange state of the repository: the hard parts of a SaaS boundary have been built and proven, and
**none of them is wired to the application.**

| Component | Proof it works | Why the user cannot reach it |
|---|---|---|
| `server/owned-api.mjs` — accounts, owned attempts, drafts, submissions, idempotency, allowances | `owned-api-check` **24/24** | `server.js` never injects it |
| `server/owned-postgres/**` — real PostgreSQL, FORCE RLS, least-privilege roles, persistent install | `owned-api-pg-check` 6/6 · `postgres-provision-check` 5/5 · the same 24 checks **24/24 on a persistent installation** | only a checker calls it |
| `public/js/owned-client.js` — session transport with generation fencing | `owned-client-check` **31/31** | no page imports it |
| `public/js/draft-session.js` — per-account recoverable draft | `draft-session-check` **17/17** | no page imports it |
| `public/js/store.js` account scoping (F-4) | `progress-scope-check` **7/7** with discrimination | `setAccountScope` has no caller |

**The correct diagnosis is not "the boundary is unbuilt". It is "the boundary is built and unmounted."**

## 3. What the SaaS model additionally requires, that is not merely unwired

These are gaps in the *design*, not just in wiring. Each needs a decision or new code.

1. **A settings store on the server.** Today `settings` is part of the progress blob. The requirement says the
   user configures language etc. and finds it again after logging in **on any device** — so settings must be an
   account-scoped server record, not a browser key. There is no settings table in the pinned auth schema and no
   route for one. **This is new work.**
2. **Language is not configured at all yet.** The search finds `examDate`, `dailyGoal`, `model` and
   `writingTaskIndex` but **no language setting**, and `C-06` (reviewed native-language explanations) is an open
   human gate. "Configure their language" is currently not a feature that exists, so it cannot be persisted.
3. **The learner's performance record is split across two stores with different scopes.** Objective attempts live
   in the legacy progress blob; owned submissions and assessments live in PostgreSQL. A returning user would see
   *some* of their history, from the wrong store, and the two are not reconciled. Nothing in the code defines
   which one is authoritative for "keeps track of their performance".
4. **Key custody.** The app still lets the browser write `DEEPSEEK_BASE_URL` into a server-side `.env`
   (`POST /api/config`). That is an operator control being offered to a tenant. On a shared server the provider
   key must be server-only. **This is a behaviour change to a merged feature and needs Ron's decision.**
5. **Session lifecycle for the internet.** The session implementation is a small synthetic port, **not Better
   Auth**: no expiry sweep, no rotation, no revocation on password change, no `Secure` cookie attribute, no
   abuse controls, no email verification or recovery. Loopback testing cannot exercise any of it.
6. **Single-tenant assumptions that must go**, each currently load-bearing: one `progress.json` path, one
   server-side `.env`, one Node process serving one learner's static files, and a `B1PREP_FORCE_OFFLINE` flag
   that exists because there is no server-side provider call at all.

## 4. The honest size of this

| Layer | Status |
|---|---|
| Data model and isolation (PostgreSQL, RLS, roles) | **built and proven**; needs production provisioning decided (who supplies the database, who applies migrations) |
| HTTP contract (accounts, owned attempts, submissions) | **built and proven**; needs mounting |
| Browser transport (owned client, fenced draft session) | **built and proven**; needs a page that imports it |
| Account surface (login/logout UI, session lifecycle) | **not built** |
| Account-scoped settings, including language | **not built**; `language` itself is not a feature yet |
| One authoritative performance record for a returning user | **not designed**; two stores exist with different scopes |
| Key custody, session hardening, abuse controls | **not built**; key custody needs a decision |

**So: roughly the bottom third of the stack is done and the top two thirds are not.** That is consistent with the
"~30–35 % of the work needed" estimate given on 2026-10-01, and it is the most useful thing this audit produces:
the remaining work is **concentrated in the application and account layers, not in the security-hardening layer**
that the last several rounds have been polishing.

## 5. Recommended order, smallest useful increments

1. **Mount the owned API in `server.js`** behind explicit configuration, using the persistent provisioning just
   merged (`OWNAPI-03`, PR #60). Without this nothing else in the account layer can be tested end to end.
2. **Add the account surface**: sign-up, sign-in, sign-out, and session display, as one view in the existing shell
   and existing visual style. Small, and it makes steps 1 and 4 of the requirement real.
3. **Wire the account scope into the progress store** (F-4) so "their data" means *their* data, and decide the
   authority question in §3.3: which store owns performance.
4. **Add an account-scoped settings record** server-side (exam date, daily goal, model, theme and, when it exists,
   language), replacing the browser-only settings.
5. **Then** the draft wiring into the writing surface, which needs 1–3 to mean anything.

Each of these is small enough to be one bounded slice with its own checker. None of them is blocked on a human
gate; **§3.4 (key custody) and the provisioning policy in §4 are the two that need Ron.**

**No gate is closed by this audit, and nothing in it is an exam-validity, security or privacy approval.**
