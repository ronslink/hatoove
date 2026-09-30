# F4-SCOPE-01 — account-scope the legacy progress store

Task: `f4-scope-01-openclaw-20261001-a` · Worker: OpenClaw/Hetzner (slot 3) · Coordinator: `COORD-TAKEOVER-20260930`.
Finding: **F-4** in `work/implementation/P-03A-PRIVACY-AUDIT.md` (Low) — learner-derived text is stored as
plaintext in `localStorage` and `progress.json`, with **no account scope**.

Base used: `origin/main` = `5a63429949275f4cb27cd7f64565afe8cf029511` (PRs #51 and #52 merged). Re-checked with
`git fetch origin` before branching; the local branch tip equalled the remote tip.

## 0. Recon — what I found *before* changing anything

Verified against the base commit, line evidence in the shipped files:

- **`public/js/store.js`** — one module singleton (`state`, `loaded`, `saveTimer`, `serverTimer`, `sync`) and one
  storage key `const STORAGE_KEY = 'b1prep.state.v1'`. `freshState()` (settings, nodes, history, errors, srs, days,
  planDone, counters) has **no account/owner field**. `writeLocal()` writes that one key; `load()` reads it. Every
  account on the same browser profile therefore reads and inherits the previous learner's history, notebook and
  settings. This is the browser half of F-4.
- **`server.js`** — a single `PROGRESS_PATH` (default `<root>/progress.json`, overridable by
  `B1PREP_PROGRESS_FILE`) plus its `.rev` sidecar. `readProgress`/`writeProgress`/`writeProgressScoped`/
  `readRevision`/`writeRevision` and the `GET`/`POST`/`DELETE /api/progress` handlers all operate on that one path.
  `handleApi` dispatches purely on path/method; there is **no identity** in the request. So `progress.json` is one
  shared record with no owner dimension. That is the server half of F-4.
- **`public/js/progress-merge.js`** — `mergeProgress` merges *two generations of one record*; it has no account
  dimension and `withDefaults` drops any unknown top-level field. It does not need to change for this slice (see
  §2); its monotonic behaviour is load-bearing for the F-2 protection and is left untouched.
- **`public/js/settings.js`** — **does not exist** in this tree. "Settings" are the `settings` sub-object inside the
  `store.js` singleton plus the server's `.env` (`DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`,
  `EXAM_DATE`, `PORT`), read in `server.js` `settings()`. The brief named a file that is not present; nothing to
  read there.
- **Account layer** — `public/js/owned-client.js` and `public/js/draft-session.js` define the *future* account
  contract (`createOwnedClient().getAccount()` → `{ contractVersion, id, email }`, id a UUID; draft text is already
  fenced per account/generation). **Neither is imported by the running app** (`public/index.html` loads only
  `js/app.js`; a grep for `owned-client`/`draft-session` outside those two files returns nothing). So today there
  is no sign-in UI and no account identity in the learner flow.
- **Audit's own caveat** — `F-03-A-REPORT.md` §Summary: the app is "a single-tenant, single-learner local tool",
  and §recommendation 3 explicitly separates the *pilot database* (owned Postgres, RLS) from the legacy blob.
  The audit also records that the F-4 UI flow could not be exercised in a browser; I do not inherit that as
  verified — see §5 (browser evidence: **not obtained**).

**Consequence.** A browser-only fix is *not sufficient*. With two accounts on one browser, a fresh account B whose
namespaced cache is empty would `syncFromServer()` the *one* server record and adopt account A's progress by
`updatedAt`. F-4 has to be closed at **both** persistence boundaries, or the server leaks across accounts.

## 1. Scope — how each requirement is met

1. **Account scope at the persistence boundary.** The account scope is an **opaque account id** (the owned-auth
   account `id`, a UUID; the store accepts `^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`). It is applied as a namespace on
   **both** sides:
   - browser: `b1prep.state.v1::<id>` instead of the shared `b1prep.state.v1`;
   - server: `<PROGRESS_PATH>.<id>` (+ `.rev`) instead of the shared `progress.json`.
   A request with no account token keeps the **legacy unscoped path**, unchanged — that is what a current
   single-user install is, and it is what keeps every existing checker green.
2. **Migration that cannot lose data.** On the first scoped load where the account's own cache is absent, the
   legacy unscoped blob is **adopted once**: copied into the account namespace, the adopting account recorded in a
   one-time marker (`b1prep.state.v1.legacy-owner`), and the legacy key **left intact** as the learner's backup.
   The legacy key is never deleted, never adopted into a second account, and never re-adopted after a reset.
3. **Signed-out behaviour, fail closed.** A distinct `signed-out` mode. The browser then holds only a fresh
   in-memory record; it persists **no** learner-derived key and performs **no** progress server I/O, so the next
   account that signs in reads only its own namespace and can never inherit the previous account's text.
4. **Plaintext property — recorded honestly, not "fixed".** See §4.
5. **Deletion still deletes; F-2 race holds.** `reset-check.mjs` and `revision-check.mjs` remain green; the
   scoped reset deletes the *scoped* server record and never the legacy backup. The `DELETE`/revision fence is
   untouched.

## 2. Design decision (recorded, with reasoning)

**Decision: scope lives in the storage namespace (a key suffix in the browser, a path suffix on the server),
keyed by an opaque account id; it is *not* a field inside the record. The legacy unscoped path is retained as the
default.**

Why a namespace rather than a record field:

- A record field (`accountId`) keeps two accounts in **one** file/one blob and forces the merge layer to be
  account-aware: `mergeProgress` would have to refuse or scope across owners, and `progress.json` could then hold
  only one account's record at a time — account B could not keep its own data without clobbering A. Namespacing
  lets both accounts coexist, which is the actual product path (`A-01`, `A-04`).
- Namespacing leaves `progress-merge.js` **untouched**. The merge is the F-2/F-2-race protection; keeping it
  byte-identical removes the risk of weakening it, and satisfies the brief's "only if the merge semantics
  genuinely need it". They do not.
- The legacy single-file format is preserved verbatim for unscoped requests, so every existing checker and the
  current single-user install behave exactly as before.

Why the legacy path is retained as the default (not migrated eagerly on upgrade):

- The brief requires that a migration "cannot lose an existing learner's data". A pre-account install has one
  unscoped blob and no account to adopt into. Adopting is therefore triggered by the **first sign-in**
  (`setAccountScope`), which is the first moment an owner exists — and it is the brief's suggested safe behaviour
  ("adopt on first sign-in and leave the legacy key intact as a backup").

**Concurrency note for the future sign-in flow.** `setAccountScope`/`clearAccountScope` cancel the pending
save/server timers, so a debounced write queued under one account cannot land under the next.

**Explicit non-goal / honest limitation.** This is *isolation and attribution by construction*, not an
**authentication** boundary. The server still has no session or cookie; a caller that presents another account's
id would select that account's file. Authentication and server-verified ownership are `A-01`/`A-04` and the owned
API (Postgres + RLS); this slice does not close them and does not claim to. It also does not make the scoped file
the pilot database (`F-03-A-REPORT.md` §recommendation 3 warns against exactly that): this is the **legacy local
store**, scoped so two accounts on one machine cannot read or inherit each other's progress.

## 3. What changed, file by file

- `public/js/store.js` — added account-scope machinery: `setAccountScope(id)`, `clearAccountScope()`,
  `getAccountScope()`, `accountScopeStatus()`; the active storage key and the pending-reset key are derived from
  the scope; `load()` performs the one-time legacy adoption; `writeLocal()` persists nothing while signed out;
  `syncFromServer`/`sendProgress`/`deleteServerProgress` send `X-B1Prep-Account` when scoped and do no progress
  I/O while signed out. Default (`legacy`) behaviour is byte-for-byte the old behaviour.
- `server.js` — added `accountPaths(req)`: a validated `x-b1prep-account` token selects
  `<PROGRESS_PATH>.<id>` / `<PROGRESS_PATH>.<id>.rev`; no token selects the legacy paths. The read/write/revision
  helpers and the three `/api/progress` handlers take the selected paths. An invalid token is `400
  invalid_account`. Nothing else in the server changed.
- `tools/progress-scope-check.mjs` + `tools/progress-scope-check.test.mjs` — new offline checker and its test.
- `work/implementation/F4-SCOPE-01.md` — this record.

Untouched on purpose: `public/js/exam.js` (Ron's hold), `public/js/progress-merge.js`, `public/js/owned-client.js`,
`server/owned-api.mjs`, `server/owned-postgres/**`, `.github/**`, `package.json`, `IMPLEMENTATION_PLAN.md`,
`MASTER-PLAN.md`, `work/BOARD.md`.

## 4. Plaintext — recorded honestly

The data in `localStorage` and `progress.json` **remains plaintext**. That is deliberate and I do **not** claim
otherwise. On a locally-running app bound to `127.0.0.1`, "at-rest encryption" is theatre: any decryption key the
app can read is a key any process (or any user of that machine) can also read, and it would sit beside the data.
It would add a decrypt step to every load and buy no confidentiality against the only attacker it would pretend
to stop. The audit rated F-4 **Low** for exactly this reason ("a local single-user app on the learner's own
machine"). What F-4 actually asks for — and what this slice delivers — is **attribution/isolation**, so that a
second account on the same browser can neither read nor inherit the first account's learner text. Confidentiality
against a local attacker is a different (machine-security) problem and is not solved here; when accounts and
shared devices exist (`A-01`, `A-04`), the durable record moves to the owned Postgres store under server-verified
ownership and RLS, which is where at-rest protection belongs.

## 5. Evidence

### 5.1 New checker — `tools/progress-scope-check.mjs`

`node tools/progress-scope-check.mjs` → **7 check(s) passed, including discrimination against the pre-fix tree**:

- `browser-record-is-account-scoped` — PASS (A and B browser records and server records are isolated)
- `legacy-blob-adopted-once-and-recoverable` — PASS (adopted once into A; never duplicated into B; not re-adopted after a reset)
- `signed-out-browser-exposes-no-learner-text` — PASS (signed-out browser holds and reads no learner text; only A's namespaced key carries it)
- `server-record-is-account-scoped` — PASS (server records are account-scoped; an invalid scope is refused)
- `delete-still-empties-server-and-browser` — PASS (legacy reset empties server and browser)
- `delete-refuses-older-write-after-delete` — PASS (the DELETE revision fence refuses an older write; no resurrection)
- `probe-discriminates-on-prefix-tree` — PASS

`node --test tools/progress-scope-check.test.mjs` → **9 tests, 9 pass, 0 fail, 0 skipped**.

Runs on an ephemeral port with a throwaway `B1PREP_ENV_FILE`/`B1PREP_PROGRESS_FILE` and `B1PREP_FORCE_OFFLINE=1`;
synthetic learner text only (`SYNTHETIC-LEARNER-TEXT-SCOPE-PROBE`); the repository `.env` is never touched.

### 5.2 Pre-fix discrimination (byte-for-byte)

The pre-fix tree is materialised from git at base `5a63429949275f4cb27cd7f64565afe8cf029511` (`git show <base>:<file>`),
and its blobs are compared by **sha256**:

| file | sha256 (pre-fix) |
|---|---|
| `public/js/store.js` | `20bf37322f78005c20491feb95a56d5b4ea7372752431484f136038001391460` |
| `server.js` | `0a42c13caa9b9f3c607517d10e3fd860b09278653a0b75b25769d43dad05089b` |

Both match the recorded constants (`PREFIX_STORE_SHA256`, `PREFIX_SERVER_SHA256`). On the pre-fix tree the probe
reports **all four account-scope checks FAIL** and **both controls PASS**:

```
pre-fix scope checks failed: browser-record-is-account-scoped, legacy-blob-adopted-once-and-recoverable,
  signed-out-browser-exposes-no-learner-text, server-record-is-account-scoped
pre-fix controls passed: delete-still-empties-server-and-browser, delete-refuses-older-write-after-delete
```

Before the change the pre-fix `store.js` exports no `setAccountScope`/`clearAccountScope`, and a direct probe
confirmed the leak: a second load (a different account) read the first learner's record from the shared
`b1prep.state.v1` key (`attempts=1`, learner text present). The pre-fix `server.js` ignores the account header and
serves the single `progress.json` to any caller, so account B fetched account A's record.

### 5.3 Regression baselines — actual counts (all unchanged)

| suite | expected | actual |
|---|---|---|
| `node tools/check.js` | 101 | **101 passed, 0 failed** |
| `node tools/writing-check.js` | 9 | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | 14 | **14 passed, 0 failed** |
| `node tools/reset-check.mjs` | 9 | **9 check(s) passed** |
| `node tools/revision-check.mjs` | 8 | **8 check(s) passed, including discrimination** |
| `node tools/server-origin-check.mjs` | 16 | **16 check(s) passed** |
| `node tools/owned-client-check.mjs` | 31 | **31 passed, 0 failed** |
| `node tools/owned-api-check.mjs` | 24 | **24 passed, 0 failed (backend: memory)** |
| `node tools/keymask-check.mjs` | 12 | **12 check(s) passed** |
| `node tools/progress-equal-check.mjs` | 10 | **10 check(s) passed, including discrimination** |
| `node tools/progress-scope-check.mjs` (new) | — | **7 check(s) passed, including discrimination** |

The F-2 race protection is intact: `revision-check.mjs` (the real timing race) and `reset-check.mjs` both stay
green, and the scoped reset deletes only the scoped record, never the legacy backup.

### 5.4 Repository gates

- `git merge-base --is-ancestor origin/main HEAD` → the branch base was an ancestor before committing.
- `node tools/repository-check.mjs` → `Repository check passed: 289 tracked files; 218 text blobs screened.`
- `git diff --cached --check` → clean (no whitespace errors).
- Every source file and patch is LF, not CRLF (verified: zero `\r` bytes in all five changed files).
- Checkers were run from files, never via `node -e`.

### 5.5 What was NOT verified

- **No browser evidence was obtained.** The proof is at the HTTP + client-module layer. No real page lifecycle,
  onscreen keyboard, refresh/navigation or audio path was exercised; there is no desktop/phone screenshot. The
  audit's own caveat (the F-4 UI flow could not be tested in a browser) therefore **still stands** — it is not
  inherited as verified here either.
- **No sign-in UI is wired.** `public/index.html` loads only `js/app.js`, and `app.js` is outside this slice's
  allowed paths, so `setAccountScope`/`clearAccountScope` currently have no production caller. The persistence
  boundary is built and proven; `A-01` must call it. Until then, a running app stays in the legacy mode and the
  isolation is unexercised in the product (it is exercised by the checker).
- **Not an authentication boundary.** The account id is client-supplied; there is no session, cookie or
  server-verified ownership on `/api/progress`. Cross-machine or malicious callers are out of scope for this
  slice and belong to `A-01`/`A-04` and the owned Postgres path.
- **The plaintext property is unchanged.** See §4 — recorded, not fixed.
- **No server-side adoption path.** Adoption is triggered by the first scoped *browser* load; a brand-new browser
  that has never held the legacy blob is not seeded from a server-only legacy record. Documented as a limitation.
- **No seeded full-page integration test and no CI wiring.** `package.json` and `.github/**` are outside the
  allowed paths, so the new checker is run manually (`node tools/progress-scope-check.mjs`).
- `P-03` remains a human gate and is **not** closed by this work.
