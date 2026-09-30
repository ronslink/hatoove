# SAAS CONVERSION — the authoritative feature inventory and conversion rules

| | |
|---|---|
| Direction | Ron, 2026-10-01: **the original application is being converted to a SaaS application.** |
| This document's job | to be the **definition of done** for that conversion: the complete list of what the app does today, and the rule for when each item may be called converted |
| Source of the inventory | read out of the code at `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e` — `public/` (19 modules), `server.js`, `tools/` (34 checkers) — not from memory or from a plan document |
| Companion records | `AUTH-USER-AUDIT.md` (is the user model there?), `FEATURE-PARITY-PORT.md` (what each function assumes), `MULTI-USER-TRANSITION.md` (why the findings cluster) |

## The distinction that governs the whole conversion

The app has exactly two kinds of state, and only one of them needs converting:

| | Shared, tenancy-independent | Per learner, must become per account |
|---|---|---|
| Examples | the exam blueprint, the 36 content packs in `data/`, the guides (`guides.js`), vocabulary and lexicon, the item generators' rules, the scoring rules, the writing-feedback rubric, the app's CSS identity | progress and history, the ability/weakness model, the error notebook, the study plan, the exam date and settings, drafts, submissions and assessments, the writing text itself |
| Conversion work | **none.** These must be served identically to every learner | **all of it.** Every item must be selected by the verified account |

**So "convert to SaaS" does not mean rebuilding the app.** It means: keep every shared component byte-identical,
and put a verified account boundary between each learner and their own state. Where that boundary already exists
(PostgreSQL with `FORCE ROW LEVEL SECURITY`), it is done; where it does not, it is the remaining work.

## A. Complete inventory — every surface the app has today

Views are the authoritative list: `app.js` registers **21** of them. "State class" is **S** for shared content and
**P** for per-learner state that must become per-account.

| # | View / route id | What the learner does there | State class | Converted? |
|---|---|---|---|---|
| 1 | `home` (Übersicht) | sees countdown, today's plan, stats | **P** | no — reads the single record |
| 2 | `plan` (Lernplan) | follows a dated study plan to the exam | **P** | no — needs the account's exam date |
| 3 | `drill` (Adaptive Übungen) | trains against their own weak tags | **P** + S rules | no — the ability model is shared-record |
| 4 | `vocab` (Wortschatz) | browses vocabulary | S | n/a (shared) |
| 5 | `vocabdrill` (Wortschatz-Training) | drills vocabulary, results feed the ability model | S content + **P** results | no |
| 6 | `notebook` (Fehlerheft) | reviews their own mistakes; the nav badge counts them | **P** | no — single unscoped notebook |
| 7 | `paper` (Prüfungsteile) | practises exam parts and is marked | S content + **P** attempts | no |
| 8 | `listening` (Hörverstehen) | the same, filtered to HV, with audio | S + **P** | no — and `C-04` (audio rights) is a human gate |
| 9 | `writing` (Schreiben) | writes a letter and gets formative feedback | S task + **P** text via the provider | no — and key custody is undecided |
| 10 | `speaking` (Sprechen) | speaking practice with browser speech | S + **P** | outside the pilot scope |
| 11 | `mock` (Mocktest) | sits timed blocks and sees an honest result | S content + **P** session | no — one in-flight mock, in browser memory |
| 12 | `reference` (Nachschlagen) | hub for the guides | S | n/a |
| 13–18 | `speakingguide`, `writingguide`, `casesguide`, `nounsguide`, `grammarguide`, `sentenceguide` | reads reference material | S | n/a |
| 19 | `settings` (Einstellungen) | sets exam date, daily goal, model, theme; **key entry** | **P** (and an operator control) | no — device-local, and not account-scoped |
| 20 | *(not a view)* account identity | sign up, sign in, sign out | **P** | **server side done, no UI** |
| 21 | *(not a view)* export / recover / delete | backs up, restores or deletes their record | **P** | partial — delete semantics proven, F-5 in PR #59 |

Supporting surfaces that are also part of "the app's functions":

| Surface | Where | State class | Converted? |
|---|---|---|---|
| Progress merge on save | `progress-merge.js`, `server.js` POST | **P** | **store yes** (`progress-scope-check` 7/7), **wired no** |
| Reset / clear | `server.js` DELETE, `store.js` | **P** | yes — `reset-check` 9/9, `revision-check` 8/8 |
| Backup and portable build | `tools/recover-progress.js`, `tools/build-portable.ps1` | **P** | PR #59 |
| Provider configuration | `POST /api/config` writes `DEEPSEEK_BASE_URL` | operator control, not a learner feature | **must change** — needs Ron's decision |
| Health/config status | `/api/health`, `/api/config` | S | yes — `keymask-check` 12/12 |
| Theme | `localStorage: certa-theme` | **P** | no — browser key, should move to the account's settings |
| Offline behaviour | `B1PREP_FORCE_OFFLINE`, browser provider calls | architecture | **must change** — a server calls the provider, not the learner's browser |

## B. The conversion checklist, in dependency order

| Step | Scope | Why here |
|---|---|---|
| **1. Account surface** | sign-up / sign-in / sign-out, session display, in the existing shell and visual style | the server side is proven (`accounts-http-check` 5/5 over real HTTP and a real restart); nothing else can be exercised as an account without it |
| **2. Account-scoped settings** | new server record: exam date, daily goal, model, theme; `language` when it exists | the dashboard, the study plan and the practice engine all read it, so it is the cheapest way to make several views account-aware at once |
| **3. Point the stateful views at the account's record** | `home`, `plan`, `drill`, `vocabdrill`, `notebook` → the account-scoped progress store (F-4) | F-4 is merged and proven but has no caller; this is the step that gives it one |
| **4. Per-account attempts** | `paper`, `listening`, `mock` → owned attempts | the owned API and PostgreSQL RLS already model exactly this |
| **5. Writing via the server** | `writing` → server-side provider call | blocked on key custody; the browser must stop holding or redirect the key |
| **6. Export and deletion per account** | export, recover, delete, retention | closes F-5 and F-6 honestly; needs the retention policy decided |
| **7. Shared content serving** | `paper`, `listening`, guides, vocabulary | already shared; verify it stays shared and is cached, not per-account |

Steps 1–3 make the stated user journey real (log in, configure, use, log out, return to find data and
performance). Steps 4–6 complete the conversion. Step 7 is a check, not a build.

## C. What "converted" is allowed to mean — one test, applied per row

An item is **converted** when a checker demonstrates, with a **signed-in account**:

1. **behaviour parity** — the same input produces the same output as for the single user, checked against the
   existing baseline (`check.js` 101, `writing-check.js` 9, `feedback-check.js` 14) rather than a new opinion;
2. **isolation** — a second account cannot read, change or inherit it, and the failure is indistinguishable from
   "does not exist";
3. **durability** — it survives sign-out and sign-in **on a new server process** (the pattern already proven for
   session and draft in `accounts-http-check`);
4. **authority** — the account-scoped store is the source of truth, not the legacy blob;
5. **no regression** — the existing checker for that behaviour still passes.

**An item that merely still works while one anonymous user is present is NOT converted.** This is the single most
important sentence in this document, because the app's current green test suite would look identical in both cases.

## D. Where the conversion stands

| Layer | State |
|---|---|
| Shared content and rules (the "S" rows) | **already correct** — must be preserved, not rebuilt |
| Data model and isolation (PostgreSQL, FORCE RLS, roles, persistent install) | **built and proven** |
| HTTP contract (accounts, owned attempts, submissions) | **built and proven, and now mounted** (`server/accounts.mjs`, `B1PREP_ACCOUNTS=1`) |
| Browser transport and stored session | **built and proven** (`owned-client` 31/31) |
| **Account UI** | **not built** — the first step of B |
| **Account-scoped settings, language** | **not built** |
| **Stateful views pointed at the account record** | **not built** — F-4 merged, unmounted |
| Key custody, session hardening, retention policy | **undecided / not built** |

Honest reading: **the platform conversion is largely done; the product conversion has barely started.** The four
gaps in the bottom block are the whole of the remaining user-visible work for steps 1–3.

## E. Decisions this document needs from Ron

1. **Deployment shape** — hosted multi-tenant, multi-account local, or one codebase for both? It decides whether
   the browser may hold a provider key at all.
2. **Key custody** — should `POST /api/config` stop accepting a base URL, so the provider key is operator-only?
3. **Retention and deletion policy** — what an account deletion must actually remove (records, backups, exports,
   logs) — this is what turns F-5/F-6 from findings into a specification.
4. **Language** — which languages, and does `C-06` native review gate the feature's release? Today `language` is
   not a stored setting at all.

**No gate is closed by this document**, and nothing in it is an exam-validity, security, privacy or legal approval.
