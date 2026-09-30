# SAAS CONVERSION — the target feature set, and what changes from the original app

| | |
|---|---|
| Direction | Ron, 2026-10-01: the original application is being **converted to a SaaS application**, and — also Ron, same day — *"the original app acts as a guideline of what functionality we need, but it's not necessarily one to one; for example we do not need sync functionality any more."* |
| This document's job | to state the **target feature set** as a decision, item by item: **carry** (same user-facing function, now per account), **transform** (same need, different shape because the server owns what the browser used to), or **drop** (deliberately not needed in the SaaS product). It is the definition of done for the conversion. |
| Source of the inventory | read out of the code at `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e` — `app.js` registers 21 views — not from a plan document |
| Supersedes | the earlier "one-to-one parity" framing in this file. **Parity with the old app is not the goal and must not be used as an acceptance rule.** Behavioural parity *within a carried function* still is, and is checked against the existing baselines (`check.js` 101, `writing-check.js` 9, `feedback-check.js` 14). |

## 0. The two rules that govern every row

1. **The server is the single source of truth.** Anything that existed only to move data between two copies of
   the same browser — syncing, exporting, backing up, portable builds, recovery files — is **not needed**, because
   there is now one authoritative copy that every signed-in device reads.
2. **Shared content stays shared; learner state becomes per account.** The blueprint, the content packs, the
   guides, the vocabulary, the generators' rules and the scoring rules need **no conversion**. Progress, the
   ability model, the notebook, drafts, submissions and settings are **the whole conversion**.

## 1. Target feature set

### 1.1 Carried — same function for the learner, now per account

| # | View / surface (`app.js` id) | What the learner does | What changes in SaaS |
|---|---|---|---|
| 1 | `home` (Übersicht) | countdown, today's plan, their own stats | reads the **account's** record, not one shared blob |
| 2 | `plan` (Lernplan) | dated plan to their exam | uses the **account's** exam date |
| 3 | `drill` (Adaptive Übungen) | trains their own weak tags | ability model per account |
| 4 | `vocab` (Wortschatz) | browses vocabulary | **shared content — unchanged** |
| 5 | `vocabdrill` (Wortschatz-Training) | vocabulary drills, results feed the ability model | shared items, **per-account results** |
| 6 | `notebook` (Fehlerheft) | reviews their own mistakes; nav badge counts them | per-account notebook |
| 7 | `paper` (Prüfungsteile) | practises exam parts and is marked | shared items, **per-account attempts** |
| 8 | `listening` (Hören) | the same for listening, with audio | shared audio, per-account attempts; `C-04` rights is a human gate |
| 9 | `writing` (Schreiben) | writes a letter, gets formative feedback | **transformed** — see 1.2 |
| 10 | `mock` (Mocktest) | timed blocks, honest result | one in-flight mock **per account**, server-owned |
| 11 | `reference` + `speakingguide`, `writingguide`, `casesguide`, `nounsguide`, `grammarguide`, `sentenceguide` | reads reference material | **shared content — unchanged** |
| 12 | *(new)* account identity | sign up, sign in, sign out, see who they are | **new, and the prerequisite for all of the above** |
| 13 | *(new)* account settings | exam date, daily goal, model, theme | **transformed** — see 1.2 |
| 14 | `speaking` (Sprechen) | speaking practice with browser speech | **out of pilot scope**, unchanged decision |

### 1.2 Transformed — the need survives, the mechanism does not

| Original mechanism | SaaS form | Why it changes |
|---|---|---|
| Settings in one unscoped progress blob + a bare `localStorage` theme key | **account-scoped server settings record** (`server/owned-postgres/settings.mjs`, `GET`/`PUT /api/v1/settings`) | settings must follow the *account* across devices, not the browser |
| Writing feedback sent from the **browser** to the provider, using the learner's own key | **server-side provider call, operator-owned key** | a shared server must not let a tenant choose where the key is sent. Needs Ron's decision on `POST /api/config` |
| Progress as one merged local file plus a browser cache, reconciled between devices | **one account-scoped server record** | the reconciliation problem disappears when there is one authoritative copy |
| Delete = remove the local file | **delete = a policy**: records, backups, exports, retention | a hosted service has more places data lives; this is what turns F-5/F-6 into a specification |
| Provider/health status read from a local `.env` | server configuration, exposed read-only without key characters | `keymask-check` 12/12 already enforces the "no key characters" half |

### 1.3 Dropped — deliberately not part of the SaaS product

| Original surface | Where it lived | Why it is dropped |
|---|---|---|
| **Sync between a device and the install** | `tools/sync-home.js`, `tools/sync-home-check.js`, `store.js` sync paths | Ron's call, and structurally right: with one authoritative server copy there is nothing to sync. Two copies reconciling was a *consequence* of the local design, not a learner feature |
| **Export / import of the progress file** | `store.js` import/export, `tools/recover-progress.js` | replaced by server persistence. If a data-portability *right* is later required by `P-03`, that is a deliberate product decision with its own specification — not this mechanism |
| **Portable / USB build, and copies of the key on removable media** | `tools/build-portable.ps1`, `tools/verify-portable.js`, `build-launcher.ps1` | no USB option in a traditional SaaS deployment; also the whole of privacy finding **F-5**'s removable-media half |
| **Local `.env` provider configuration by the learner** | `POST /api/config` writing `DEEPSEEK_BASE_URL` | an operator control, not a tenant one |
| **Pre-recovery / `.bak` copies beside the install** | `server.js` recovery path | no install directory once the app is served |

**Consequence for F-5:** with sync, export and the portable build dropped, the *only* deletion-scope question left
is the hosted one — server backups, exports and retention. The worker's in-flight F-5 slice (PR #59) was scoped
against the local app; **it must be re-scoped against this list before it is merged**, and its change to the merged
`reset-check` assertion should be re-examined in that light rather than merged as-is.

## 2. What "done" means per item — one test, applied per row

An item is **converted** when a checker demonstrates, with a **signed-in account**:

1. **behaviour parity within the carried function** — the same input gives the same output as the single user,
   measured against the existing baseline rather than a new opinion;
2. **isolation** — a second account cannot read, change or inherit it, and the refusal is indistinguishable from
   "does not exist";
3. **durability** — it survives sign-out and sign-in **on a new server process** (the pattern already proven for
   session and draft by `accounts-http-check`);
4. **authority** — the account-scoped server record is the source of truth, with no second copy to reconcile;
5. **no regression** — the existing checker for that behaviour still passes.

**An item that works only while one anonymous user is present is NOT converted**, and an item in 1.3 must be
*absent*, not merely unused.

## 3. Dependency order

| Step | Scope | Status |
|---|---|---|
| 1 | Mount the owned API in the running server | **done** — `server/accounts.mjs`, `B1PREP_ACCOUNTS=1`, `accounts-http-check` **5/5** |
| 2 | Account-scoped settings | **port and migration written; routes and wiring next** |
| 3 | Account identity UI (sign-up / sign-in / sign-out in the shell) | **not built** — the server side is proven |
| 4 | Point `home`, `plan`, `drill`, `vocabdrill`, `notebook` at the account's record | **not built** — F-4 merged and still unmounted |
| 5 | `paper`, `listening`, `mock` on per-account attempts | **not built** — the API already models it |
| 6 | Writing via the server | **blocked on key custody** |
| 7 | Deletion and retention to the hosted policy | **needs the policy decided**; re-scope F-5 first |
| 8 | Confirm the dropped list is actually absent | **not checked** |

Steps 1–4 make the stated user journey real: log in, configure, use, log out, come back and find the data and
performance. Steps 5–8 complete the conversion.

## 4. Decisions this document needs from Ron

1. **Deployment shape** — hosted multi-tenant, or one codebase that can also run locally for one account?
2. **Key custody** — does `POST /api/config` stop accepting a base URL, making the provider key operator-only?
3. **Retention and deletion policy** — what an account deletion must remove (records, backups, exports, logs).
4. **Language** — which languages, and does the `C-06` native review gate the feature's release? Today `language`
   is stored in the settings contract but is **not** a feature the app offers.
5. **Confirm the dropped list** in 1.3, so nobody rebuilds sync or the portable build by mistake.

**No gate is closed by this document**, and nothing in it is an exam-validity, security, privacy or legal approval.
