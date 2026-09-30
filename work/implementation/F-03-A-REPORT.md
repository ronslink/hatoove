# F-03-A: legacy account-boundary audit

- **Task:** F-03-A (issue [#8](https://github.com/ronslink/hatoove/issues/8))
- **Execution ID:** `f03a-20260930-a`
- **Owner/host:** OpenClaw on Hetzner, slot 2 (no children)
- **Base commit:** `48c3d210173a0291eb1d82ad2c8a74ad52da8416`
- **Branch:** `codex/f03-a-legacy-audit`
- **Worktree:** `/root/workspaces/hatoove-f03-a`
- **Issued:** 2026-09-30 17:35 UTC · **Checkpoint:** 17:50 UTC · **Expires:** 18:35 UTC
- **Independent reviewer:** coordinator

## Scope and method

Read-only source audit of `server.js` and `public/js/{store,ai,exam,app}.js` at the base
commit. No code, board, `server.js` or `.env` changes; no server started, no browser, no
live AI, no personal progress, no production and no other projects. The only written
artifact is this report (`work/implementation/F-03-A-REPORT.md`).

Line numbers below are from base `48c3d21` and were captured with `grep -n` on that
revision.

Question answered: which existing routes and shared (module- or process-level) state
**cannot** be reused unchanged as a multi-account boundary, and where should
account-scoped seams be inserted while preserving the current interfaces.

## Command evidence

| Command | Result |
|---|---|
| `node tools/check.js` | **101 passed, 0 failed** |
| `node tools/writing-check.js` | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | **14 passed, 0 failed** (`public/js/ai.js`) |
| `node tools/repository-check.mjs` (staged snapshot) | run before commit; see PR body |

These match the recorded baseline (101 + 9 + 14). They test legacy behaviour, not exam
validity.

## Summary

The current app is a **single-tenant, single-learner local tool**. The boundary is
network locality plus one server-side secret, not an identity:

- `server.js` binds to `127.0.0.1` (`server.js:488`) and keeps the DeepSeek key in
  `.env`/`process.env`. That is secret hygiene and locality, **not** an account boundary.
- There is **no cookie, session, token, owner id or user id anywhere** in `server.js`
  (a targeted `grep -i` for `cookie|authorization|bearer|token|session|login|owner|user`
  returns only DeepSeek `Authorization: Bearer` on the outbound call at `server.js:299`
  and `max_tokens` matches).
- Progress is one durable file; the browser is one singleton object under one
  `localStorage` key; exam views keep their in-progress state in page-global module
  variables.

Every one of those is a **single shared instance**. Two learners would overwrite, merge
into, or read each other's data. The sections below give exact route/state and line
evidence, then the recommended seams.

---

## 1. `server.js` — the HTTP boundary is process-global

### 1.1 One progress file, no owner dimension

- `PROGRESS_PATH` is a single resolved path, overridable only by env
  (`server.js:29-31`), defaulting to `<root>/progress.json`.
- `writeProgress` (`server.js:186-196`) atomically writes that one file, keeping one
  backup generation (`progress.json.bak`).
- `readProgress` (`server.js:199-210`) reads that one file, falling back to the backup.

There is no key, row or directory by account. Findings 1.2–1.4 are all consequences.

### 1.2 `GET /api/progress` (`server.js:354-358`)

Returns the single stored state (`{ok, found, source, state}`) to **any** caller. There
is no owner check, so account A would read account B's progress.

### 1.3 `POST /api/progress` (`server.js:360-385`)

- Reads up to 16 MB (`server.js:362`).
- **Merges** the posted `state` into the stored one via `mergeProgress`
  (`server.js:373-375`), deliberately monotonic so a stale tab cannot erase newer
  answers (comment at `server.js:365-369`).
- The merge is over history/attempts/errors with **no identity field**, so a second
  learner's save does not replace, it **folds into** the first learner's record. Once
  merged, the two are not separable. This is the sharpest reuse blocker: the current
  merge semantics actively destroy the partition.
- `itemRef` (`public/js/store.js` `recordAttempt`, and `public/js/exam.js:505-515`)
  identifies an item within one learner; it is not an account key.

### 1.4 `DELETE /api/progress` (`server.js:387-395`)

Deletes `progress.json` and `progress.json.bak` unconditionally. Any caller that can
reach the listener can destroy the entire durable record. No auth, no ownership, no
confirmation token.

### 1.5 `GET/POST /api/config` (`server.js:398-412`)

- `GET` (`server.js:398-401`) returns `publicConfig()` (`server.js:106-115`):
  `configured`, `keyMasked`, `model`, `baseUrl`, `examDate` — one global config for all
  callers.
- `POST` (`server.js:403-412`) writes chosen fields into `.env` through `saveEnv`
  (`server.js:117-141`) and then **mutates `process.env` for the whole process**
  (`server.js:135-138`). One learner changing model/exam date changes it for everyone,
  and the learner-driven write path to `.env` is itself a boundary leak.
- `.env` is also loaded into `process.env` at module scope on boot via
  `loadEnvIntoProcess()` → `loadEnvIntoProcess` (`server.js:78-83`), a single process-wide
  read.

### 1.6 `POST /api/ai` and `POST /api/ai/test` (`server.js:415-448`)

- `POST /api/ai` (`server.js:415-435`) proxies arbitrary `messages` to DeepSeek with the
  one server key via `callDeepSeek` (`server.js:272+`, key used at `server.js:299`).
- `POST /api/ai/test` (`server.js:437-448`) makes a live provider call.
- Neither carries an identity, quota or attribution. Any client on the host can spend the
  single account's credit. There is no per-account usage counter to key `store.noteAi`
  (`public/js/ai.js:105,108`) against.

`127.0.0.1` binding (`server.js:488`) keeps the listener off the network, which is a
sensible default, but it is **locality, not authentication**; it does not make the
endpoints account-scoped.

### 1.7 `GET /api/health` (`server.js:349-352`)

Publicly echoes `publicConfig()` (including the masked key and model) to any caller.

### 1.8 Static content is unauthenticated and un-entitled

`ALLOWED_STATIC_ROOTS = [PUBLIC_DIR, DATA_DIR]` (`server.js:214`) and `resolveStatic`
(`server.js:216-230`) serve both `public/` and `data/`. The `data/` packs
(`seed.json`, `vocab.json`, `core-grammar.json`, `grammar-guide.json`,
`writing-guide.json`, `speaking-guide.json`, `cases-guide.json`, `gender-rules.json`,
`noun-lexicon.json`) are therefore downloadable by anyone who can reach the server, and
they are the same for every account. There is no entitlement or per-account content seam,
and per `IMPLEMENTATION_PLAN.md` (content/keys section) the scoring authority must not be
shipped as unsubmitted keys — the seed bank is currently a public asset.

### 1.9 Router

`handleApi` (`server.js:346`) dispatches purely on `pathname`/`method`. There is no
middleware, no allowlist, and no `req`-derived identity from which to derive an owner.

---

## 2. `public/js/store.js` — one browser singleton, one storage key

### 2.1 One `localStorage` key

`const STORAGE_KEY = 'b1prep.state.v1'` (`store.js:18`). Any account signing in through
the same browser profile reads/writes the same blob (`writeLocal` → `setItem`,
`store.js:73`; `load` → `getItem`, `store.js:122-141`). Switching account would surface
the previous learner's history, errors and preferences.

### 2.2 One in-memory singleton, no owner field

Module-level `state` (`store.js:55`), `loaded` (`store.js:56`), `saveTimer` /
`serverTimer` (`store.js:57-58`) and `sync` (`store.js:59`). `freshState()`
(`store.js:28-54`) has `version, createdAt, updatedAt, settings, nodes, history, errors,
srs, days, planDone, counters` — **no account/user id**. Settings (exam date, model,
tts rate, daily goal) live inside this same blob (`store.js:35-42`).

### 2.3 Writes and conflict resolution assume one owner

- `flushToServer` (`store.js:159-185`) POSTs the whole singleton to `/api/progress`
  (`store.js:163`).
- `syncFromServer` (`store.js:201-246`) fetches the one server state (`store.js:207`) and
  resolves only by `updatedAt` (`store.js:222-231`). With two accounts there is no owner
  to compare, so the newer timestamp wins across accounts — cross-account adoption.

### 2.4 Export/import/reset operate on the singleton

`exportJSON` (`store.js:283`), `importJSON` (`store.js:287-296`), `resetAll`
(`store.js:276-281`) move or clear the whole blob with no account scoping.

---

## 3. `public/js/ai.js` — global config, global spend, global rotation

- Module-level `status` singleton (`ai.js:12`); `refreshStatus` (`ai.js:16-24`) hits
  `/api/config` (`ai.js:18`); `saveConfig` (`ai.js:120-127`) writes it (`ai.js:121`).
- `callAI` (`ai.js:58`) POSTs `/api/ai` (`ai.js:65`) with no identity, and attributes
  success/failure to the shared counters through `store.noteAi` (`ai.js:105,108`), so AI
  spend and failure counts are single-account facts.
- `nextWritingTask` (`ai.js:749`) mutates the shared `settings.writingTaskIndex`
  (`ai.js:751-754`) — a global task-rotation counter, not per account.
- Content caches are module-level (`seedCache`, `vocabCache`, `coreCache`, guide caches)
  — acceptable for read-only packs, but there is no per-account content/entitlement seam.

---

## 4. `public/js/exam.js` — page-global in-progress state

- Module-level mutable view state: `writingTask` (`exam.js:596`), `writingTimer`
  (`exam.js:597`), `writingRender` (`exam.js:600`), `speakingTask` (`exam.js:857`),
  `speakingRender` (`exam.js:861`), `mockState` (`exam.js:1185`).
- These persist across route changes and are shared by the whole page session. A second
  account in the same page/session would inherit the first's half-written task, running
  timer and **mock answers** (held in `mockState.answers` (`exam.js:1267`), populated in `startMock`
  (`exam.js:1231`), and in the DOM).
- Every result funnels into the shared singleton store: `recordSetAttempts`
  (`exam.js:505-515`) → `store.recordAttempt`; writing/speaking/mock also call
  `store.addError` (`exam.js:775`, `exam.js:1123`, `exam.js:1426`).
- `collectFromDom` (`exam.js:1448`) reads answers straight from the DOM. There is no
  per-submission identity or server-authoritative marking envelope to key an
  account-scoped, immutable submission on (contrast the plan's "server supplies
  authoritative marking" and "immutable submissions" boundaries).

---

## 5. `public/js/app.js` — no login gate

- `boot()` (`app.js:224`) runs once: `store.load()` (`app.js:225`) → `await
  store.syncFromServer()` (`app.js:255`) → `await ai.refreshStatus()` (`app.js:258`) →
  first render → `boot()` invoked at `app.js:298`. The startup path assumes one learner on
  one global store; there is no account check or route guard.
- `navigate()` is global with no route/ownership check.
- Theme preference uses a global key `'certa-theme'` (`app.js:157`, `app.js:166-179`) —
  a UI preference, low risk.

---

## 6. Recommended integration seams (preserve the existing interface)

The current client/server contract can stay intact; the account dimension is added
underneath it.

1. **Owner context at the HTTP layer.** Resolve an owner per request and pass an
   `ownerId` into a progress-store adapter. Keep the existing response shapes
   (`GET` → `{ok, found, source, state}`, `POST` → `{ok, bytes, savedAt, merged[, state]}`,
   `DELETE` → `{ok}`) so `store.js` needs no call-site changes. Where no owner is
   present, **fail closed** (`401`) instead of defaulting to the shared store.
2. **Per-owner progress persistence.** Key the durable record by `ownerId` (file per
   account or a row), keeping the `state` object shape identical so `mergeProgress`
   (`public/js/progress-merge.js:42`) and `migrateTags` keep working. Change `POST`
   merge so it only ever merges two states of the *same* owner.
3. **Protect `/api/ai` and `/api/ai/test`.** Keep request/response bodies; add
   authentication plus per-account usage counters/quotas, and attribute `store.noteAi`
   per account so provider spend is not a shared global fact.
4. **Separate server config from learner settings.** Keep `GET /api/config` returning the
   same fields, but stop letting a learner POST write `.env`/`process.env`
   (`server.js:403-412`, `saveEnv` at `server.js:117-141`); move `examDate`/`model` into
   the account-scoped record. Provide a separate, authenticated admin path if the
   operator needs server config (owner/coordinator scope, not learner scope).
5. **Account-scope the client singleton.** Keep every exported function in `store.js`;
   add an injected account id (e.g. `setAccount(id)` that reloads/reset the singleton and
   selects `` `b1prep.state.v1:${accountId}` `` as `STORAGE_KEY`), plus an account-scoped
   clear on logout. This mirrors the plan's "account-scoped cache clearing".
6. **Content entitlement.** If any `data/` pack is not meant to be public, gate it behind
   the owner/entitlement check; keep `resolveStatic`'s path allowlist (`server.js:216-230`)
   as defence-in-depth. Never let downloadable assets carry unsubmitted scoring keys.
7. **View-state ownership.** Move the page-global mutable view state in `exam.js`
   (`writingTask`, `speakingTask`, `mockState`, render tokens) into a per-view controller
   that is reset on account/route change, and give each submission a stable id so the
   server (not the DOM via `collectFromDom`) owns marking and the immutable record.

## 7. Limitations and non-claims

- This is **read-only source inspection at base `48c3d21`**. No server was started, no
  browser, no live AI, no `.env` read and no personal progress was touched.
- The findings describe how the existing **single-tenant interfaces cannot be reused as a
  multi-account boundary**. They are a design audit, not a penetration test, and they
  **do not establish or claim production security** (in either direction).
- `127.0.0.1` binding plus a server-side key is locality/secret hygiene only; it is not
  presented here as an authentication or ownership control.
- The baseline checks test legacy behaviour, not exam validity.
- `mergeProgress` monotonicity is intentional and correct for the single-learner case; the
  finding is only that it has no owner partition.
- Recommended seams are proposals for the F-03/A-01 owner; they are not implemented here
  and were not validated against a running multi-account stack.

## 8. Next action

Coordinator review of this report; if accepted, feed findings 1.1–1.9 and 2–5 into the
F-03 contract work (schemas, route controls and state contracts) before A-01
implementation.
