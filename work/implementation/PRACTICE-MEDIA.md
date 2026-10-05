# PRACTICE-MEDIA (task-17) — the practice-bound listening playback path

**Task:** task-17 (PRACTICE-MEDIA). **Branch:** `codex/practice-media-17`, cut from
`codex/practice-01-pg` @ `15c8ded` (task-15, the verified practice sitting). **Server-only**, per the Lead's
scope correction (task revision 3).

**Result: 15 legs and 2 mutation proofs green on a disposable PostgreSQL; 0045 applies cleanly; the full
gate set is green; the client switch is documented below as one function.**

---

## 1. What was built

The mock listening path is **form-bound**: `listening_playback` is keyed to a `mock_run` by a composite foreign
key, and its guard reads that run's form, deadline and `attemptMode`. A practice sitting is not a run — it is
untimed, it covers ONE released set of ONE part, and there is no form. So the practice path gets **the same
accounting model on its own key**, and shares every piece of behaviour that can be shared:

| Shared with the mock path (unchanged) | New here |
|---|---|
| `playbackDto`, `playbackTransition`, `recoveryPosition` (`playback.mjs`) | the binding: `practice_playback` keyed to a `practice_attempt` |
| `validatePlaybackEvent` (the event body, `media-route.mjs`) | the practice rule: every play after the first needs "Auswerten" |
| `mediaResponse` (range/HEAD/etag framing), `readMediaBytes` (integrity-first byte read) | the allowance source: the blueprint's per-family rule |
| acknowledged `begin`, event-id idempotency, one-way state machine | a `practice_attempt`-scoped guard and counter |

`server/owned-postgres/practice-playback.mjs` — `readPracticePlayback`, `mutatePracticePlayback`,
`readPracticeMedia`, and the pure `practicePlaybackTransition` (the practice rule applied **on top of** the
shared transition, so the two paths cannot drift).
`server/migrations/0045-practice-playback.sql` + its `MANIFEST.json` line — two tables (`practice_playback`,
`practice_playback_event`), RLS + FORCE, owner/deletion policies, column-level INSERT/UPDATE so the runtime
role can never widen its own allowance, the guard trigger, and one owner-scoped `CURRENT_USER` policy.
`server/owned-api.mjs` — the three routes. `server/owned-postgres/adapter.mjs` — the port wiring and the two
new account-deletion/read-back entries.

### The rule, exactly

- **Allowance = the blueprint's EXAM rule per family**: `part.playback->>'mock'` — telc B1 HV1 1, HV2 2,
  HV3 2. This is the number slice B already serves to the learner through `/api/v1/exam-parts`, so the enforced
  allowance and the displayed rule cannot disagree. (The blueprint also carries `playback.practice` = 1 for
  all three; `.mock` is used deliberately so the learner practises under the exam's own play rule. If the
  product ever wants practice to be strictly one play, that is a one-token change in 0045 and the DTO needs
  no change.)
- **On top of the allowance, exactly ONE play before "Auswerten".** Every play after the first requires the
  sitting to be `checked`. So a second listen before Auswerten is refused **even when the exam allowance would
  still permit a play** — with a 409 `practice_check_required`, produced by the pure transition *and*
  independently by the SQL trigger so no caller can skip it.
- **The sitting's own counters** (0044 reserved both): `practice_attempt.plays_used` counts every play, and
  `replay_used` records that a play beyond the first was spent on a checked sitting.
- **Bytes need a play in progress.** Unlike the mock media route (which serves bytes to the owner of an active
  run), this route refuses the audio unless an acknowledged play is currently `playing` or `paused` — 409
  `playback_required`. Otherwise "a second listen before Auswerten is refused" would be true only of the state
  machine while the file itself stayed re-fetchable, and the acceptance criterion is about the LISTEN. HEAD is
  under the same rule; the client never needs the file's metadata before `begin`, because the DTO carries
  `duration_ms`.
- **Integrity first.** `begin` reads and verifies the bytes *before* the row is created, so a missing or
  corrupt file refuses the play with 409 `media_unavailable` / `media_integrity` and debits nothing.

### A FORCE-RLS trap that 0044 could not have known about (and 0045 fixes)

The guard reads the sitting. `practice_attempt` is `FORCE ROW LEVEL SECURITY` (0044) with policies only for
the learner and deletion roles, and a migration-owned `SECURITY DEFINER` function is **still subject to FORCE
RLS** — so the read returned zero rows and *every* play was refused with `not_found`. This is exactly why
`mock_run` carries `finalise_mock_run ON mock_run TO CURRENT_USER` (0025:77) and `item_evidence` carries
`finalise_mock_evidence`; 0044, written before any playback path existed, carries no such policy. 0045 adds
**one owner-scoped `CURRENT_USER` policy on `practice_attempt`** in 0025's own idiom, rather than editing an
applied migration:

```sql
CREATE POLICY practice_playback_sitting ON practice_attempt TO CURRENT_USER
  USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
```

It is narrower than 0025's version — owner-fenced, so the definer sees only the acting learner's rows, never
the whole table. **Migration 0044 and its MANIFEST line are untouched**: this is additive DDL in a later
migration, which is how 0021 added a policy to the earlier `item_evidence`.

### One file outside the listed scope — announced

`server/practice-sets.mjs` (task-15's file, not in task-17's scope) gained support for the **packaged
`fixed_audio` shape**: a listening set keeps its questions inside `recordings[].questions`, not in a top-level
member. Without it the serving path answered 500 for exactly the set that carries audio, so this task's own
fixture could not be reached through `/api/v1/practice/next?family=`. The change is additive: `recordings[].questions`
are flattened into items (id = `n`, prompt = `question`, options from the item's own object — the same order
`finalise_mock_run` and `objectiveItems` already use), and `recordings` joins `material` so a runner can bind
each item to its audio. It is the follow-up I flagged as residual risk #1 in `PRACTICE-01-PG.md`, and the Lead
assigned it to this lease. No other file was touched, and `public/app/part-runner.js` does **not** exist in this
worktree (it never did — the base has no runner).

---

## 2. The client contract — the follow-up switch, precisely

The switch point is `audioMarkup()` in the real runner (`public/app/part-runner.js`, branch
`codex/practice-01-client` @ `779bdbf`). Today it renders the player with `data-playback-mock` /
`data-playback-practice`, a **disabled** `[data-runner-play]`, `[data-runner-replay]` only in the review
phase, and `[data-runner-playback-missing]` + `partRunnerAudioUnavailable`. Three calls replace the disabled
controls; the sitting id is the one `/api/v1/practice/next?family=` already returns as `attempt.attempt_id`.

### 2.1 Read the playback state

```text
GET /api/v1/practice/attempts/<attemptId>/playback
→ 200 {
    "items": [ { "media_id": "<string>", "media_version": "v1", "revision": 0,
                 "state": "ready|playing|paused|completed", "plays_used": 0, "max_plays": 2,
                 "position_ms": 0, "duration_ms": 30000, "playback_id": null,
                 "uncertain": false, "server_now": "<ISO>" } ],
    "sitting": { "attempt_id": "<uuid>", "state": "open|checked", "checked": false,
                 "plays_used": 0, "replay_used": false } }
```

`items` is one entry per recording of the SERVED set, in authored order — the same order as
`set.material.recordings`, so `items[i]` corresponds to `material.recordings[i]`. **An empty `items` means the
set carries no authored audio**: that is the honest state for the seeded telc HV sets in migration `0010`
(`items` + no recordings), and it is what `[data-runner-playback-missing]` / `partRunnerAudioUnavailable`
should key off — not an error. `max_plays` is the exam rule, so `data-playback-mock` can be driven from this
DTO and the `/api/v1/exam-parts` lookup dropped for the practice path.

### 2.2 Start, checkpoint, pause, complete, recover

```text
POST /api/v1/practice/attempts/<attemptId>/playback
body = the mock path's own event: { "eventId": "<uuid v4>", "mediaId": "<string>",
        "mediaVersion": "v1", "expectedRevision": <int>, "action": "begin|checkpoint|pause|complete|recover",
        "positionMs": <int, required for checkpoint/pause/complete>, "playbackId": "<uuid, required unless begin>" }
→ 200 { "playback": <the same item DTO as above> }
```

`expectedRevision` is the item's `revision`, and `playbackId` its `playback_id`; `eventId` makes the request
idempotent (the same event id returns the stored state and never consumes a second play). `begin` requires
`expectedRevision: 0` when nothing has been played. `complete` requires `positionMs === duration_ms`.

### 2.3 The audio bytes

```text
GET|HEAD /api/v1/practice/attempts/<attemptId>/media/<mediaId>/<mediaVersion>
→ 200 audio/wav, `etag: "sha256-<hash>"`, `cache-control: private, no-store`, `accept-ranges: bytes`
→ 206 for `Range: bytes=…`, 416 for an unsatisfiable range, empty body for HEAD
```

### 2.4 The one-call sequence a practice listening runner should use

```text
GET  .../playback                                   → render the player and the rule; items.length === 0 → honest "no audio"
POST .../playback {action:'begin', expectedRevision:0}                  → then fetch the bytes
GET  .../media/<media_id>/<media_version>           → play (range requests are fine while playing/paused)
POST .../playback {action:'complete', positionMs:duration_ms, playbackId, expectedRevision}
POST /api/v1/practice/check                         → "Auswerten" (the practice sitting becomes `checked`)
POST .../playback {action:'begin', expectedRevision:<current>}   → [data-runner-replay] in the review phase
```

### 2.5 Errors the switch must handle

| status | code | meaning |
|---|---|---|
| 409 | `practice_check_required` | a second listen before "Auswerten" — the server's own refusal |
| 409 | `playback_exhausted` | the exam allowance is spent (HV1 after its one play, HV3 after two) |
| 409 | `playback_required` | bytes requested without a play in progress |
| 409 | `media_unavailable` | the file is absent (or not imported) — **no play debited** |
| 409 | `media_integrity` | the bytes fail their checksum/length/duration — **no play debited** |
| 409 | `playback_conflict`, `playback_recovery_required` | revision/identity mismatch, or a paused play needs `recover` |
| 409 | `account_changed` | the account switched while the private file was being checked |
| 404 | `not_found` | not this sitting's recording, or not this learner's sitting |
| 401 | `unauthenticated` | no verified session |
| 503 | `practice_playback_unavailable` | the backend has no playback port (the memory backend) |

---

## 3. Evidence

Disposable database only (`postgres:17-alpine` under `practice-media-pg`, `127.0.0.1:55494`, removed
afterwards; never the live app). The fixture is the synthetic technical signal of `tools/exam-s5-fixture.mjs`
imported through the real `importPackage`, plus a temporary media root this check creates and deletes.

```text
node server/migrate.mjs                     → applied=43 skipped=0 (0001..0045), migrate: OK
node tools/practice-media-check.mjs         → 15 legs, 0 failed  + 2 mutation proofs
node tools/practice-selection-check.mjs --postgres  → 38 legs, 0 failed (task-15 still green)
node tools/practice-selection-check.mjs     → 18 legs, 0 failed
node tools/migrate-check.mjs                → 6 passed, 0 failed
node tools/table-class-check.mjs            → OK: every table is classified and every class rule holds
node tools/migration-eol-check.mjs          → 5 passed, 0 failed
node tools/owned-api-check.mjs              → 35 passed, 0 failed (memory)
node tools/owned-api-check.mjs --backend=postgres → 35 passed, 0 failed
node tools/owned-api-pg-check.mjs           → 9 passed, 0 failed
node tools/part-index-check.mjs             → 11 passed, 0 failed
node tools/repository-check.mjs             → 729 tracked files; 646 text blobs screened
design-check / retired-surface-check / seo-check / server-origin-check / keymask-check /
owned-client-check (32) / i18n-register-check (0 findings)  → all green
```

The legs, and what each proves:

| Leg | Proves |
|---|---|
| M1 (pure) | a used recording needs a CHECKED sitting, so the second listen is refused by the transition |
| M2 (pure) | a packaged `fixed_audio` set keeps its questions in `recordings[]` and serves them as items |
| M3 | the serving path hands over the imported set **with its audio** and the exam allowance |
| M4 | the allowance is the BLUEPRINT rule per family: HV3 → 2, HV1 → 1 |
| M5 | **over HTTP**, the first listen is acknowledged and the SECOND before Auswerten is 409 `practice_check_required`, with `plays_used` still 1 |
| M6 | bytes are served only while a play is in progress (409 `playback_required` before), with the imported etag and byte length; HEAD carries none |
| M7 | after Auswerten the replay is allowed (`plays_used` 2), and the third play is 409 `playback_exhausted`; `replay_used` is recorded on the sitting |
| M8 | **the accounting is separate from a mock run's** — two tables, two allowances, neither moves the other |
| M9 | a MISSING file refuses the play (409 `media_unavailable`), debits nothing, degrades honestly |
| M10 | CORRUPT bytes are 409 `media_integrity`, not a silent success |
| M11 | the **SQL trigger** refuses what the JS layer never sees: a widened `max_plays` → `invalid_playback_identity`; a raw replay before Auswerten → `practice_check_required` |
| M12 | the same event id is applied once and returns the stored state |
| M13 | a served set with no authored recordings offers an empty list and 404 for a play, not a broken player |
| M14 | another account gets 404 on the sitting, its playback and its bytes; no session gets 401; unknown media 404 |
| M15 | the wrap rule and the playback path agree about a three-set listening part |

**Mutation proof** (each applied to a copy of the shipped module in a temporary tree, then the SAME assertion
re-run against the broken guard):

```text
MUTATION M1 practice-playback: the AFTER-AUSWERTEN rule removed -> the guarded leg fails
MUTATION M2 practice-sets: the recordings[] shape removed        -> the guarded leg fails
```

---

## 4. What is NOT delivered, and residual risk

1. **The client switch is a follow-up, by instruction.** This lease is server-only: `public/app/part-runner.js`
   is on `codex/practice-01-client` @ `779bdbf` and does not exist on this base. I did not create it, and I did
   not touch `public/app/listening.js` either. §2 is the contract that makes the switch one function.
2. **No rendered evidence.** Rendered 1366/390 evidence and the real player are the follow-up's, not this
   lease's; nothing here is evidence about a page. The 320 px overflow check likewise.
3. **The nine WAV files are NOT in git.** They live in the deployed image, and the media bind-mount fix is
   still owed. The path can therefore play **only where those files exist**: on a host whose media root
   actually carries `content/exams/telc-deutsch-b1/audio/*.wav`. Where a file is absent the route answers
   **409 `media_unavailable`** (and 409 `media_integrity` when the bytes are present but wrong) and debits no
   play — an honest refusal, never a silent success and never a broken player. My legs prove both by renaming
   and by corrupting a real fixture file.
4. **Production telc listening practice still has no audio until the listening package is imported.** The
   shipped corpus (migration `0010`) stores HV sets as `items` with `{n, statement}` and no recordings;
   `content/exams/telc-deutsch-b1/manifest.json` carries **0 sets**, and the recordings live in
   `listening-package.json`, which nothing imports. So today `/api/v1/practice/next?family=HV1` serves a
   seeded set whose playback list is **empty** (leg M13), and the runner keeps its honest "no audio for this
   set" state. The path built here becomes live the moment the listening package is imported *and* the WAVs
   are mounted. That is a content/ops step, not a code gap.
5. **`practice_attempt` now carries one more policy** (owner-scoped, for the definer role). `table-class-check`
   passes, but a reviewer should confirm it reads as intended: the definer sees only the acting learner's rows.
6. **Per-recording, not per-set, accounting.** Each recording of a served set has its own one-play-before-
   Auswerten and its own allowance. For the exam-shaped sets (one recording per part in the mock form; five in
   the s5 fixture's HV1/HV3) this is the correct reading of "one play per recording in practice"; a
   set-wide budget would be a different product decision.
7. **`replay_used` is a boolean.** It caps post-Auswerten plays at one per recording on top of the first,
   which is exact for the telc allowance (1+1 = 2). A blueprint allowance above 2 would need it to become a
   counter.
8. **The bytes route's in-progress rule is deliberately stricter than the mock route's.** The mock media
   route serves bytes to the owner of an active run and is unchanged; the two now differ on this one point,
   with the reason stated in the code.

---

## 5. Files

| File | Change |
|---|---|
| `server/migrations/0045-practice-playback.sql` (new) | `practice_playback` + `practice_playback_event`, RLS/FORCE, column-level grants, the guard trigger, and the owner-scoped `CURRENT_USER` policy on `practice_attempt` |
| `server/migrations/MANIFEST.json` | one appended line, sha256 of 0045; 0044's line byte-identical |
| `server/owned-postgres/practice-playback.mjs` (new) | the port: read/mutate/media + the pure practice transition |
| `server/owned-postgres/adapter.mjs` | import + spread the port; `practice_playback`/`practice_playback_event` in `ACCOUNT_DELETION_STEPS` and `ACCOUNT_TABLES` |
| `server/owned-api.mjs` | `GET`/`POST /api/v1/practice/attempts/<id>/playback`, `GET`/`HEAD …/media/<mediaId>/<version>`, method-gated so the memory backend is unchanged |
| `server/practice-sets.mjs` | **outside the listed scope, announced:** `recordings[].questions` flatten into items; `recordings` joins `material` |
| `tools/practice-media-check.mjs` (new) | the 15 legs and the 2 mutation proofs |
| `work/implementation/PRACTICE-MEDIA.md` | this note |

`server/owned-postgres/node_modules/pg` is a read-only junction to the canonical checkout (gitignored, not
committed) because a fresh worktree has no dependencies.
