# PROGRESS-MERGE — is `mergeProgress` still needed on a server?

Ron asked: *"we also would not need a progress merge because all activity happens on the server not an external
device — is that what progress merge is?"*

**Short answer: partly yes, and the answer matters enough to be precise.**

## What `mergeProgress` actually is

Read from `public/js/progress-merge.js` and its callers, not from memory:

> *"Why this exists: saves are debounced and can come from more than one tab. With a plain last-write-wins
> overwrite, a tab holding a slightly older in-memory snapshot can flush **after** a tab that has already saved
> newer answers, silently discarding them. That happened for real: a later save carried **68 fewer attempts** than
> the one before it. So every write merges instead of replacing, and the merge is monotonic — the result never
> contains less evidence than either input."*

It is **not** a device-synchronisation feature. It is a **conflict-resolution strategy for two writers holding
snapshots of the same record**:

| Caller | Why |
|---|---|
| `server.js:599` on `POST /api/progress` | the incoming snapshot may be **older** than what the server holds |
| `public/js/store.js:468` on the response | the browser may hold a **newer** in-memory state than the server just returned |

The second caller is the one that answers your question: **the browser is itself a second writer with an
independent snapshot.** Even on a server, a debounced save carries a snapshot that is seconds old. So the need does
not come only from "an external device" — it comes from *any* writer that holds state instead of asking the server
to change it.

## So: is it still needed?

**If the server becomes the only holder of truth and clients send *operations* or *revisions* rather than whole
snapshots, then merging is not needed — and it is actively wrong**, because a monotonic union cannot express "the
learner deleted this" or "this answer was replaced", which is exactly the class of bug the SaaS work has already
been fighting (the F-2 reset race, and the deletion-tombstone semantics).

**The good news: the replacement is already built and proven.** `server/owned-postgres/adapter.mjs` implements
`save(owner, id, expectedRevision, text)` and **refuses a stale write with `409 draft_conflict` instead of merging
it**, and `revision-check.mjs` (8/8) proves a `DELETE` invalidates older in-flight writes. That is optimistic
concurrency — one authoritative row, a revision, and a re-read on conflict.

So the programme is carrying **two contradictory conflict policies at once**:

| Path | Policy | Fit for a server |
|---|---|---|
| legacy `POST /api/progress` + `mergeProgress` | **merge**: never lose evidence, never conflict | a workaround for snapshot writers; cannot express deletion |
| `owned-api` attempts/drafts | **revision**: refuse stale, re-read, resolve explicitly | the right shape for one authoritative store |

## The decision this needs (mine, recorded so it can be reversed)

**Recommendation: keep the merge only while the legacy progress snapshot path exists, and retire it together with
that path when the stateful views move to owned attempts.** Reasons:

1. **It is load-bearing today.** `mergeProgress` and `progressEqual` are what `reset-check` (9), `revision-check`
   (8), `progress-equal-check` (10) and F-4's `progress-scope-check` (7) test. Deleting the module now deletes the
   evidence for four merged fixes — including the SEC-02 race fix — and would leave those behaviours unproven.
2. **Its replacement is already proven**, so the retirement is a *migration*, not a rewrite: point the stateful
   views at per-account attempts with revisions, and the merge path has no callers left.
3. **Retiring it is part of "the stateful views move to the account record", not a separate cleanup.** Doing it
   early would remove the guard before the thing that needs no guard exists.

**What must NOT happen:** deleting `mergeProgress` because it "looks like sync". It is not sync — `tools/sync-home.js`
was sync, and it is already removed. This is a conflict policy, and it is the *only* thing standing between two
writers and silently lost answers on the legacy path today.

## Ron's second point: *"we will have no portability so no need to sync any data"*

**Correct, and it changes nothing about `mergeProgress` — because `mergeProgress` was never what synced data.**
Two different things have been sharing the word:

| | What it is | Status |
|---|---|---|
| **Portability / sync** | moving a progress file between an install, a portable copy or another machine | **removed, and no longer needed.** `tools/sync-home.js`, the portable build and `portable/**` are deleted; there is no second copy to reconcile because the server is the only copy |
| **`mergeProgress`** | a rule for *two writers of the same row*, needed when a writer sends a **whole snapshot** instead of an operation | **a consequence of file persistence** — see the third point below, which supersedes the softer reading in this section |

The second is not device-to-device. Its own header names the case that produced it: **debounced saves and two tabs
on the same machine** — a tab holding a slightly older in-memory snapshot can flush *after* a tab that already saved
newer answers, and a real save once carried **68 fewer attempts** than the one before it. The browser is a writer
that holds state, so "no portability" alone does not remove the second writer. **Changing the persistence model
does** — which is the point Ron makes next.



**Correct, and it makes my earlier "keep it until the legacy path goes" too cautious.** The right way to say it is:

> **`mergeProgress` is not a persistence strategy that we are choosing to keep. It is a *consequence* of the wrong
> persistence strategy** — a single mutable record, rewritten whole, written by snapshot-carrying clients. On a
> server, persistence is the database, and the record is a row (or rows) owned by an account and updated through
> **revisions**.

Once that is said, the three things that looked like separate decisions are **one**:

| Looks like | Actually is |
|---|---|
| "we do not need a progress merge" | true **once** the writer stops sending snapshots |
| "we do not need `progress.json`" | the same change: the row replaces the file |
| "the stateful views must move to the account record" | the work that performs both |

So: **the target is DB persistence with revision-checked writes, and the file-plus-merge model is retired as one
act, not two.** The revision path is already built (`owned-postgres/adapter.mjs`) and already refuses a stale write
with `409`; `revision-check` (8/8) proves a `DELETE` invalidates an older in-flight write. Nothing new has to be
invented — the file model just has to stop existing.

## Ron's third point: *"if the idea is persistence there are other ways to achieve that in a server vs local environment"* — and this reframes the whole note

**Correct, and it makes my earlier "keep it until the legacy path goes" too cautious.** The right way to say it is:

> **`mergeProgress` is not a persistence strategy we are choosing to keep. It is a *consequence* of the wrong
> persistence strategy** — a single mutable record, rewritten whole, written by snapshot-carrying clients. On a
> server, persistence is the database, and the record is a row (or rows) owned by an account and updated through
> **revisions**.

Once that is said, the three things that looked like separate decisions are **one**:

| Looks like | Actually is |
|---|---|
| "we do not need a progress merge" | true **once** the writer stops sending snapshots |
| "we do not need `progress.json`" | the same change: the row replaces the file |
| "the stateful views must move to the account record" | the work that performs both |

So: **the target is DB persistence with revision-checked writes, and the file-plus-merge model is retired as one
act, not two.** The revision path is already built (`owned-postgres/adapter.mjs`) and already refuses a stale write
with `409`; `revision-check` (8/8) proves a `DELETE` invalidates an older in-flight write. Nothing new has to be
invented — the file model just has to stop existing.

### Persistence options for a server, and which to use where

| Option | Use it for | Why not for the learner record |
|---|---|---|
| **PostgreSQL, `owner_id` + `FORCE ROW LEVEL SECURITY`, revision-checked updates** | **the learner record, attempts, drafts, submissions, settings** | — this **is** the choice, and its isolation evidence is already in hand |
| Redis | job queues, rate-limit counters, short-lived session or cache data — **ephemeral, high-churn, safe to lose** | isolation would live in application code rather than in the database, and a mis-keyed record is readable by anyone holding the connection |
| Object storage (S3-compatible) | fixed audio, exports, large immutable artifacts | not a transactional record; no ownership enforcement, no revisions |
| **A JSON file on disk** | **nothing, in a hosted service.** Acceptable only as the legacy local artefact being retired | one writer, one process, one filesystem; rewritten whole on every save; invisible to a second instance and gone with an ephemeral container |

**Therefore the ordering changes.** The stateful-views migration is not "step 3 after D1" with the merge retired
later; it is **the persistence change**, and it retires the file and the merge in the same movement. Until it lands,
the file path stays alive and the merge must stay with it — but it is now recorded as **scheduled for removal**,
not as a guard the programme intends to keep.



**Correct, and it changes nothing about `mergeProgress` — because `mergeProgress` was never what synced data.**
Two different things have been sharing the word:

| | What it is | Status |
|---|---|---|
| **Portability / sync** | moving a progress file between an install, a portable copy or another machine | **removed, and no longer needed.** `tools/sync-home.js`, the portable build and `portable/**` are already deleted; there is no second copy to reconcile because the server is the only copy |
| **`mergeProgress`** | a rule for *two writers of the same row*, needed when a writer sends a **whole snapshot** instead of an operation | **still needed today, and unrelated to portability** |

The second is not device-to-device. Its own header names the case that produced it: **debounced saves and two tabs
on the same machine** — a tab holding a slightly older in-memory snapshot can flush *after* a tab that already saved
newer answers, and a real save once carried **68 fewer attempts** than the one before it. The browser is a writer
that holds state, so "no portability" does not remove the second writer.

**But the direction Ron is pointing at is right, and stronger than "no sync":** when the stateful views read and
write owned attempts with a **revision**, a stale snapshot is **refused with 409 and re-read**, not merged. That
policy is already built (`owned-postgres/adapter.mjs`, `revision-check` 8/8) and it is the one that can express a
**deletion** — which a monotonic union never can, and which caused the F-2 reset race.

**So:** portability and sync are gone and stay gone; the merge is retired **with** the legacy snapshot path, not
before it, and **must not be extended or "fixed" further in the meantime**. Recorded so that a future reader does
not re-open this as if sync had been left behind.

The removals already executed (`start.cmd`, `tools/sync-home*.js`, the portable build and `portable/**`,
`tools/recover-progress.js`, and the `recover` npm script) are **correct and unrelated to this**: none of them was
a conflict policy, and `progress-merge.js` was **not** touched.

**Nothing in this note has been implemented.** It is a decision record, and the answer to the question asked.
