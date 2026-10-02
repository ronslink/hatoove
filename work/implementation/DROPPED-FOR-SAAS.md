# DROPPED-FOR-SAAS — the removal plan, and the trap inside it

| | |
|---|---|
| Asked/directed by | Ron, 2026-10-01: *"we have a traditional SaaS application structure"* and *"we do not need sync functionality any more."* |
| Companion | `SAAS-CONVERSION.md` §1.3 classifies **sync, progress export/import, the portable/USB build and learner-writable provider configuration** as **dropped**. This document turns that classification into an exact removal plan. |
| Source | every path and line below was read out of the code at `origin/codex/ownapi-03-persistent` @ `3e0a2a8` on 2026-10-01 |
| Why it is worth writing down | the removal is **easy and safe** — but there is one trap that would delete a *protective* behaviour if the removal were done by pattern-matching filenames |

## 1. The critical distinction — the trap

There are two different things in this codebase that both look like "syncing progress", and **only one is dropped**:

| | What it is | Verdict |
|---|---|---|
| **`tools/sync-home.js`** (+ `sync-home-check.js`) | a one-time, explicit **SSD → home-directory merge**: it reads a progress file from another root, checks the ports are stopped, and writes a **new** file at the destination. Its own header says *"Never writes SSD progress."* It is **operator tooling, not an app feature** | **DROP.** In a SaaS deployment there is no second copy of the progress file to reconcile |
| **`mergeProgress` in `public/js/progress-merge.js`, used by `server.js` on `POST /api/progress`** | the **merge-on-save guard**: a partial or older write must not erase a learner's record. This is *protective*, and it is what the SEC-02 race fix (`revision-check` 8/8) builds on | **KEEP.** Deleting this would be a **data-loss regression**, not a cleanup |

`tools/sync-home.js` **imports** `public/js/progress-merge.js`, and `tools/sync-home-check.js` exercises it. **Removing the tool must not remove or weaken the module.** A removal done by "delete everything with `sync` in the name" is safe; a removal done by "delete the progress-merge code the sync tool used" is not.

## 2. Exact removal plan

### 2.1 Sync — dropped

| Path | Lines | Action | Risk |
|---|---|---|---|
| `tools/sync-home.js` | 220 | delete | none: no module inside `public/**` or `server.js` imports it |
| `tools/sync-home-check.js` | 188 | delete | none, **once** `package.json`'s scripts no longer reference it (see 2.4) |

### 2.2 Portable / USB build — dropped

| Path | Lines | Action | Note |
|---|---|---|---|
| `tools/build-portable.ps1` | 80 | delete | this is the tool that copies a real `.env` (with a real key) onto removable media — **the entire removable-media half of privacy finding F-5** |
| `tools/verify-portable.js` | 124 | delete | it verifies that build |
| `tools/build-launcher.ps1` | 23 | delete | it builds the desktop shortcut for that install |
| `start.cmd`, `b1prep.ico` | — | **investigate before deleting** | `start.cmd` is the local launcher Ron's own install may use; a launcher is not a portable build. Delete only if the removal plan shows it is portable-only, and say so in the record |

`portable/**` — **the repository does track it. Confirmed with `git ls-files portable`: five files** —
`portable/Launcher.cs`, `portable/README.txt`, `portable/Sync-to-Home.cmd`, `portable/portable-launcher.cjs`,
`portable/start.cmd`. All five are part of the dropped portable/USB build, and `Sync-to-Home.cmd` is the portable
face of the sync feature as well. **Delete the directory.**

**Two different `start.cmd` files exist and must not be confused:**

| Path | What it is | Action |
|---|---|---|
| `portable/start.cmd` | part of the portable build | **delete with `portable/`** |
| `start.cmd` at the repository root | the local launcher for `server.js`; **the path Ron's own install may use** | **keep**, unless a separate decision retires the local-install shape entirely |

### 2.2b Documentation that must change in the same commit

The repository documents the portable build as a supported way to run the app, so the removal is not complete
without these:

| Reference | Where | Why it matters |
|---|---|---|
| "The portable Windows copy can run from …" | `README.md:56` | the README would advertise a deleted feature |
| the whole *"Portable Windows copy"* section | `README.md:60` | as above |
| "Progress and settings are saved beside the portable app, in `progress.json` and …" | `README.md:68` | **also describes the storage model the SaaS target replaces** |
| "The portable launchers are maintained in `portable/`; `tools/build-portable.ps1` …" | `README.md:76` | as above |
| `tools/` and `portable/` described as source utilities | `docs/REPOSITORY_BASELINE.md:7` | becomes inaccurate |
| "Portable build/sync/recovery tools can copy or modify real credentials and learner records" | `docs/REPOSITORY_BASELINE.md:21` | a warning about deleted tools; keep the *isolated source-only clone and synthetic records* rule, which still applies for a different reason |


### 2.3 Progress export / import — dropped, and **not present as a learner feature**

The inventory found **no learner-facing export or import**: no download, no `FileReader`, no `Blob` usage in `public/js/**`. What exists is:

| Path | Lines | Action | Note |
|---|---|---|---|
| `tools/recover-progress.js` | 80 | keep or delete — **a decision, not an assumption** | it recovers a progress file from a backup when the live one is damaged. In SaaS the data lives in PostgreSQL and a damaged client file is not a thing; but **an operator recovery tool for the database is a legitimate future need.** Recommend: delete the file-based tool, and record that database recovery is a *backup/restore* concern owned by the retention policy (which is Ron's decision) |
| `package.json` script `recover` | 1 | change with the above | |
| `store.js` import/export paths | — | the audit noted import semantics union rather than replace; **already inert** for SaaS once the account-scoped store is the authority | do not touch in a removal-only change |

### 2.4 References that must change with the removals

| Reference | Where | Why |
|---|---|---|
| `npm run recover` | `package.json` | points at `tools/recover-progress.js` |
| any script pointing at `sync-home`, `build-portable`, `verify-portable`, `build-launcher` | `package.json`, `docs/**`, `README.md`, `start.cmd` | a dangling script is a broken promise in the docs |
| `docs/**` and `README.md` text describing the portable build, the USB key copy, or the SSD→home sync | `README.md`, `docs/**`, `AGENT_*` if any | **the documentation is part of the deliverable.** A dropped feature that still appears in the README is a defect of the same kind as a test that passes for the wrong reason |

### 2.5 What must NOT be touched by this removal

- `public/js/progress-merge.js` and its checkers (`progress-equal-check`, `reset-check`, `revision-check`).
- `server.js`'s merge-on-save behaviour on `POST /api/progress` and the `DELETE` revision fence.
- The `postgres-provision-check` / `owned-api-*` / `accounts-http-check` gates — gating stays.
- Anything under `spikes/` (historical evidence) and any record under `work/implementation/`.

## 3. What this does to F-5, precisely

With §2 done, F-5's **local** half disappears entirely:

| Original F-5 clause | After this removal |
|---|---|
| "backup copies of progress … fall outside any deletion path" (pre-recovery copies, `.bak` beside the install, portable copies) | **moot** — there is no install directory and no portable copy. The remaining `.bak` beside the legacy progress file is covered by the existing reset/revision work |
| "copies of the key on removable media" | **moot** — the portable build that made them is deleted |
| the underlying question: *does a delete actually delete?* | **still live, and now purely hosted**: records, backups, exports, logs, and retention. **This is the part Ron must decide**, and it is exactly what the `f5-rescope-hermes-20261001-a` re-scope is asked to specify rather than guess |

**Consequence for PR #59** (`codex/f5-deletion-01`): its brief was written against the local target. Parts of it implement deletion for objects this plan deletes. Its change to the merged `reset-check` assertion must be re-decided against this document — **it must not be merged as it stands**, which is already recorded in the work queue.

## 4. Ordering, and why

1. **This plan, then the removals, as one bounded slice** — deletions plus their documentation and script references, with `check.js` 101 / `writing-check.js` 9 / `feedback-check.js` 14 and every checker unchanged afterwards.
2. **Then** PR #59's re-scope can be decided on a repository that no longer contains the objects it was written about.
3. **Then** the hosted deletion policy, which is Ron's decision, becomes a specification instead of a guess.

A removal slice is unusual for this programme — every other slice has been additive — so it needs the same discipline: **actual counts before and after, an explicit list of deleted paths, no deletion of anything not named in this table, and the documentation updated in the same commit.**

**No gate is closed by this document.** `P-03`/`X-01` remain open, and the retention policy it refers to is still undecided.
