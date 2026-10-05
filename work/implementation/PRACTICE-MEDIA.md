# PRACTICE-MEDIA (task-17) — the practice-bound listening playback path

**Task:** task-17 (PRACTICE-MEDIA). **Branch:** `codex/practice-media-17`, cut from
`codex/practice-01-pg` @ `15c8ded` (task-15, the verified practice sitting). **Server-only**, per the Lead's
scope correction (task revision 3).

**Result: 19 legs and 4 mutation proofs green on a disposable PostgreSQL; 0045 applies cleanly; the full
gate set is green; the client switch is documented below as one function.** (19/4 is after task-25; the first
delivery was 15/2 — see §0.)

---

## 0. Follow-up lease task-25 — REVIEW-PRACTICE-MEDIA's findings fixed

REVIEW-PRACTICE-MEDIA (teammate `reviewer`) verified this slice independently and returned **CLEAR WITH
NOTES**, confirming the central design claim — genuinely the mock path's own DTO, transition, validator,
framing and byte reader, not a second player. Four things are fixed here; **F2 is the Lead's** and **F7 is
integration order**.

### 0.1 F1 — the practice rule pre-empted the shared transition and masked its codes

`practicePlaybackTransition` ran its own `begin`-with-one-play check **before** `playbackTransition`, so once a
recording had one play and the sitting was open **every** `begin` answered `practice_check_required`: a stale
`expectedRevision` (`playback_conflict`), a spent allowance (`playback_exhausted`) and a play still running
(`playback_recovery_required`) were all swallowed — and this note's own comment claimed the opposite. A client
that decides "re-check or resync the revision" from the code was told the wrong thing. The SQL trigger already
had the right precedence (structural checks first, `practice_check_required` last), so the two layers
disagreed.

**Fixed:** the shared transition now runs **first** and the practice rule applies to its result, matching the
trigger exactly. **Proved** by a pure leg that pins all four outcomes, and by **mutation M3**, which puts the
old ordering back and makes that leg fail. The acceptance criterion is unchanged: the second listen is still
refused.

### 0.2 F3 — the missing-playback guard could not fire

`Number(null)` is `0` and `Number.isInteger(0)` is `true`, and `(part->'playback'->>'mock')::integer` is NULL
for a part with no playback rule — so the intended `practice_playback_unavailable` passed a NULL straight
through, `recordingsOf` reported `max_plays: 0`, and the learner got a code that had nothing to do with the
problem. **Fixed:** NULL and absent are detected explicitly and a non-positive allowance is refused the same
way.

**Proved with the partial-import fixture the reviewer could not build.** A listening *package* cannot express
this state (its validator refuses a `fixed_audio` part without `playback`), and `exam_blueprint` is immutable —
its own trigger says "create a new version instead" — so the state is built the way an import leaves it: a new
blueprint version without the HV2 rule, a new release pointing at it, and the head moved for the length of the
leg (`server/practice-media-check.mjs`, `F3 DB`). The leg asserts the new guard answers
`practice_playback_unavailable`, then mutates the guard back in a sandbox copy and **measures both halves of
the reviewer's reasoning**, which had been reasoned rather than observed: the old guard serves an item with
`max_plays: 0`, the transition then answers a misleading code, and a raw insert with `max_plays 0` is refused by
the trigger as `invalid_playback_identity`. The head is restored in a `finally`.

### 0.3 F8 — the drill's twelve sentences were served as empty prompts

Found by the **client** review and confirmed from the seeded migration: `PROMPT_FIELDS` omitted **`prompt`**,
which is where the `0022` grammar drill keeps all twelve sentences (measured in the migration: 12 `prompt`,
0 `question`/`statement`/`text`). So every served drill item had `prompt: ''` — twelve gap items with no
sentences (the client measured `tasks=12, emptyPrompts=12`). This is the **same class of defect as the original
normaliser bug**: an assumption about the authored shape never checked against the corpus. **Fixed:** `prompt`
is the first entry in `PROMPT_FIELDS`; **proved** by a pure leg on the drill's real item shape **and** by a leg
that reads the actual seeded drill row from the database and asserts twelve non-empty prompts, with
**mutation M4** taking `prompt` back out so the leg fails.

### 0.4 F4/F6 — note corrections

The `CURRENT_USER` policy is owner-fenced but is the **same predicate** as 0025's `finalise_mock_run` family,
not narrower (corrected in §1). And `repository-check` at this head is **733 files / 650 blobs** — measured, not
inherited; the earlier figure was `15c8ded`'s (corrected in §3).

### 0.5 F2 (the Lead's) and F7 (integration order) — recorded, not acted on

**F2:** the enforced allowance is the exam rule and the **tile** must be corrected to show it; the stale
`HV3 mock=1` comment in `server/exam-parts.mjs:31-33` is fixed at integration. I did not touch the tile or that
comment, and I do not object: the DTO's `max_plays` already carries the exam rule, so both surfaces can read
one number. The claim in §1 is corrected.

**F7:** this branch and task-20's both diverge from `15c8ded` and `MATERIAL_MEMBERS` is the same line on both
(`[…,'bank','recordings']` here, `[…,'bank','practice_kind','instruction']` there). The Lead merges task-20
first and resolves that line to carry **all four** additions. Nothing was merged here, and neither slice's
check exercises the merged tree — so **both** checks must be re-run on the merge commit.

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
  HV3 2. `playback.practice` is 1 for all three; `.mock` is used deliberately so the learner practises under
  the exam's own play rule. **CORRECTED by REVIEW-PRACTICE-MEDIA F2:** this note first claimed it was "the
  number slice B already serves … so the enforced allowance and the displayed rule cannot disagree". The
  *payload* carries both numbers, but the **tile** renders `playback.practice` (`part-index.js:191`,
  `data-plays` at `:200`), i.e. **1** for every HV part, while the runner reads `mock` — so on HV2/HV3 the tile
  said one play and the server allowed two. That is a product decision, and the **Lead has made it**: the exam
  rule is authoritative for practice listening (Ron's decision 3), the tile is to be corrected to show the
  exam rule, and `server/exam-parts.mjs:31-33`'s stale "HV3 mock=1" comment is fixed at integration. I did not
  touch either. Also measured by the reviewer, and recorded here: the **installed** blueprint carries no
  `playback` at all (HV1/HV2/HV3 `practice=NULL, mock=NULL`), so `/api/v1/exam-parts` serves no HV rule today —
  "what slice B serves now" and "what this path enforces after a listening import" are different states.
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

**CORRECTED by REVIEW-PRACTICE-MEDIA F4:** the predicate is the **same** expression as the existing policies
(`owned_practice_attempt`, `deletion_practice_attempt`) and the same as 0025's `finalise_mock_run` /
`finalise_mock_evidence` / `finalise_mock_preparation`. So this note's earlier "narrower than 0025's version"
was wrong: it is **owner-fenced** — the definer sees only the acting learner's rows, never the whole table
(measured by the reviewer with the defining role: owner bound → 1 row; unbound, someone else's owner, or never
set → 0 rows) — but it is the **same idiom applied to a table that lacked it**, not a stricter variant. Nothing
is opened by it: the policy grants no table access (grants still gate), only the learner and deletion roles
hold grants, and both already had owner-fenced policies. **Migration 0044 and its MANIFEST line are
untouched**: this is additive DDL in a later migration, which is how 0021 added a policy to the earlier
`item_evidence`.

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
node tools/practice-media-check.mjs         → 19 legs, 0 failed  + 4 mutation proofs (task-25)
node tools/practice-selection-check.mjs --postgres  → 38 legs, 0 failed (task-15 still green)
node tools/practice-selection-check.mjs     → 18 legs, 0 failed
node tools/migrate-check.mjs                → 6 passed, 0 failed
node tools/table-class-check.mjs            → OK: every table is classified and every class rule holds
node tools/migration-eol-check.mjs          → 5 passed, 0 failed
node tools/owned-api-check.mjs              → 35 passed, 0 failed (memory)
node tools/owned-api-check.mjs --backend=postgres → 35 passed, 0 failed
node tools/owned-api-pg-check.mjs           → 9 passed, 0 failed
node tools/part-index-check.mjs             → 11 passed, 0 failed
node tools/repository-check.mjs             → 733 tracked files; 650 text blobs screened (this head)
design-check / retired-surface-check / seo-check / server-origin-check / keymask-check /
owned-client-check (32) / i18n-register-check (0 findings)  → all green
```

The legs, and what each proves:

| Leg | Proves |
|---|---|
| M1 (pure) | a used recording needs a CHECKED sitting, so the second listen is refused by the transition |
| M2 (pure) | a packaged `fixed_audio` set keeps its questions in `recordings[]` and serves them as items |
| **F1 (pure)** | **the practice rule keeps the shared STRUCTURAL codes** — `playback_conflict`, `playback_exhausted`, `playback_recovery_required` — and applies `practice_check_required` last |
| **F8 (pure)** | **the grammar drill's twelve authored `prompt` sentences reach the DTO** |
| **F8 DB** | **the drill row the migrations SEED serves twelve non-empty prompts** (read from `objective_set`) |
| **F3 DB** | **a set with recordings whose part has no playback rule answers `practice_playback_unavailable`**, and the sandbox mutation measures what the old guard did instead (`max_plays: 0`, a misleading code, and `invalid_playback_identity` at the trigger) |
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
MUTATION M1 practice-playback: the AFTER-AUSWERTEN rule removed                    -> the guarded leg fails
MUTATION M2 practice-sets: the recordings[] shape removed                          -> the guarded leg fails
MUTATION M3 practice-playback: the practice rule moved back BEFORE the shared      -> the F1 leg fails
                              transition (F1)
MUTATION M4 practice-sets: `prompt` dropped from PROMPT_FIELDS (F8)                -> the F8 leg fails
```
Plus the F3 leg's own in-place mutation, which measures the old guard rather than asserting it.

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
| `tools/practice-media-check.mjs` (new) | the 19 legs and the 4 mutation proofs |
| `work/implementation/PRACTICE-MEDIA.md` | this note |

`server/owned-postgres/node_modules/pg` is a read-only junction to the canonical checkout (gitignored, not
committed) because a fresh worktree has no dependencies.
