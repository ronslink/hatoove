# PRACTICE-01-PG — slice C's server half, executed and proved against PostgreSQL

**Task:** task-15 (PRACTICE-01, server). **Branch:** `codex/practice-01-pg`, cut from
`codex/practice-01-runner` @ `c839079`. **Base for review:** `f0a7657` (local main).

The previous lease left two server methods that **had never been executed against a database**:
`practiceSetForPart` and `checkPracticeAttempt`. `node tools/practice-selection-check.mjs --postgres`
aborted with a bare `not_found` before any leg reported. This lease executed them, and the execution
exposed five defects — four of them in the never-run path, one of them the reason the abort was invisible.

**Result: 38 PostgreSQL legs and 18 offline legs, 0 failed; 5 mutation proofs; both routes driven end to
end over HTTP against a disposable database.**

---

## 1. What failed, why, and the exact fix

### D1 — the wrapper hid the failure (diagnostics, not a defect)

`postgresLegs`'s catch printed only `String(error.message).split('\n')[0]`. Worse, `pg-pool` deliberately
**replaces the stack** (`Error.captureStackTrace(err)` in `pg-pool/index.js:45`) so the reported stack
pointed at the pool, not the statement. The abort therefore printed `not_found` and nothing else.

*Fix (`tools/practice-selection-check.mjs`):* the catch now prints the failing label **and the first 14
stack lines** before recording the one-line tally. That immediately named the statement:

```
postgres: legs could not run: not_found
error: not_found
    at D:\Hatoove\server\owned-postgres\node_modules\pg-pool\index.js:45:11
    at async craft (file:///D:/Hatoove/.worktrees/practice-server/tools/practice-selection-check.mjs:190:9)
    at async postgresLegs (...:209:5)
```

### D2 — the fixture wrote evidence as `admin`, unbound to any owner (fixture defect)

`craft()` inserted the crafted `item_evidence` rows through `db.admin`. `item_evidence` carries the
row guard `guard_review_use` (`0036-content-review-consumers.sql:104-110`):

```sql
who := nullif(current_setting('hatoove.owner_id',true),'');
IF who IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
```

The guard is `SECURITY DEFINER` and does **not** test `current_user`, so it fires on the admin connection
too, where `hatoove.owner_id` is unbound. The fix is *not* to weaken the guard: it is to write the rows
the way the shipped adapter writes a learner's answer — inside a transaction with the owner bound. New
`asOwner()` does exactly that, so the crafted rows now pass the **same RLS `WITH CHECK`** and the same
triggers (`require_active_preparation`, `protect_mock_evidence`, `a_s6_new_admission`) as a real answer.
The remaining admin reads and the P6 state mutation are deliberate: those legs test the table and its
trigger and must not be able to lean on the owner policy to pass.

### D3 — the check never pinned the content policy (fixture defect)

With `B1PREP_CONTENT_MODE` unset the policy default is `public` (`server/content-policy.mjs:23`), so
`servableReview()` returns `['approved']` — but the fixture publishes `unreviewed`/`generated` content.
Every candidate query correctly returned nothing, and the legs reported a *null service* rather than a
defect. This is the same in-process pin every other disposable-fixture check uses (`exam-s4-pg-check`,
`owned-api-pg-check`, `objective-key-access-check`). The check now sets
`B1PREP_CONTENT_MODE='internal-preview'`, deletes `B1PREP_SERVE_REVIEW`/`B1PREP_SERVE_RIGHTS`, and
**restores the caller's environment** in `finally` (including when `createFixture` itself throws).

### D4 — THE REAL DEFECT: `normalisePracticeSet` was wrong for seven of the eight parts

The authored corpus is `server/migrations/0010-objective-catalogue.sql`. Measured from a disposable
database (25 sets, every set internally consistent: payload rows == `item_count` == `objective_key.answers`
keys):

| family | member | item 0 | options | key type |
|---|---|---|---|---|
| LV1 | `texts` | `{id:"1",text}` | set-level `headlines` (a–j) | string |
| LV2 | `questions` | `{n:6,question,options:{a,b,c}}` | per item, an **object** | string |
| LV3 | `situations` | `{n:11,text}` | set-level `ads` (a–l) + sentinel `x` | string |
| SB1 | `gaps` | `{n:21,options:{a,b,c}}` | per item, an object | string |
| SB2 | `gaps` | `{n:31}` only | set-level `bank` (a–o, `word`) | string |
| HV1–HV3 | `items` | `{n:41,statement}` | none (richtig/falsch) | **boolean** |

The old normaliser accepted member ∈ {`items`,`texts`,`questions`}, read `item_id = item.item_id ?? item.id`,
read `prompt = item.prompt`, and built options only from an **array** `item.options`. On real content that
is: `practice_set_invalid` for LV2/HV1/HV2/HV3, `practice_set_items_unknown` for LV3/SB1/SB2, and LV1
"served" with an empty prompt and no options. **Seven of eight families would have answered 500.**

*Fix (`server/practice-sets.mjs`):* the normaliser is rewritten against the corpus, and the item is
**rebuilt from named fields** (never spread), so a secret field cannot ride along even if an authored row
grows one:

- `item_id = String(item.id ?? item.n)` — exactly the `objective_key.answers` key;
- `prompt` from `question` / `statement` / `text`; SB gaps have no prompt (the letter carries it);
- `options` from the item's own object options, else the set-level bank, else HV's truth pair; LV3 gets the
  same `x` sentinel `objectiveItems` adds, because the key uses it;
- every option carries a **typed `value`**: the string id for a choice, a real **boolean** for HV. This is
  not cosmetic — `mark_objective_item` compares JSONB (`expected = p_answer`, `0036:299-301`), so an HV
  answer posted as the string `"true"` is silently marked wrong;
- `answer_kind` (`choice`|`judgement`) and a `material` member (`text`/`letter`/`headlines`/`ads`/`bank`)
  so a runner can render the passage or letter;
- a set whose member is absent, whose declared count disagrees with its authored rows, or whose items offer
  no answer **throws** (`practice_set_items_unknown` / `practice_set_invalid`) rather than serving a page
  the learner cannot answer.

The offline suite was complicit: old leg 11 fed `payload.items` rows shaped
`{item_id, prompt, options:[…]}` — a shape **no shipped set has** — so it certified a fiction. Legs 11–18
are now written from the real payloads (one per family plus the rebuild guard and the malformed cases), and
mutation M5 breaks the rebuild to prove the guard.

### D5 — THE REAL DEFECT: `practiceSetForPart` ran READ ONLY and then inserted

`settle(owner, work, snapshot = false)` opens `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` when its
third argument is true. `practiceSetForPart` passed **`true`** — and then INSERTs the `practice_attempt`
sitting. So the method could never have worked:

```
FAIL P1 … cannot execute INSERT in a read-only transaction      (SQLSTATE 25006)
```

It was invisible because D4 threw *first* (normalise runs before the insert). With D4 fixed it surfaced at
once. *Fix (`server/owned-postgres/adapter.mjs`):* `settle(..., false)`, with a comment stating that this
method serves **and opens**, so it cannot be a snapshot.

One further real typo in the same two methods, in the same never-run SQL:
`COALESCE(cr.basis, cr.rights_status)` — the fallback column lives on `content_version`, not
`content_rights`. It appears twice (in `practiceSetForPart` and `checkPracticeAttempt`); all ~30 other
occurrences in the adapter, including the neighbouring `nextPractice`, already read `c.basis, c.rights_status`.
Both were corrected. Error before the fix: `column cr.rights_status does not exist` (SQLSTATE 42703).

### D6 — the wrap leg's own setup could never satisfy its assertion (check defect)

P2 and P3 both served `telc-deutsch-b1.hv1.02` (most-wrong, then oldest), so the raw
`UPDATE practice_attempt SET state='checked'` could only ever produce **two** distinct checked sets while
the leg asserted three. Rewritten to build the A1 state the way a learner builds it: crafted evidence is
cleared, then **three rounds through the shipped `checkPracticeAttempt`**, then the fourth tap. P6 was also
made precise — it must try to reopen a **checked** sitting (the oldest attempt of the family is still open,
and reopening an open sitting is not what the trigger forbids).

### D7 — `/api/v1/vocab` served 50 of 300 (Lead's request; additive)

The route passed no `limit`, so the datastore's default of 50 silently cut the deck and the response
carries no total to say so. Fixed exactly like the noun route at `3be374a`: serve the whole bounded corpus
by default (500), accept a bounded `limit` override (1..500), `invalid_limit` otherwise. Response shape
unchanged. Measured on the disposable database:

```
vocab default rows: 300          (was 50)
  pos=noun: 233   pos=verb: 41   pos=adj: 19   pos=adv: 7   pos=phrase: 0
limit=25 rows: 25
  limit=0/501/abc/-1/1.5 -> 422 invalid_limit
nouns default rows (the already-fixed sibling): 240
```

---

## 2. What is now proved (the brief's acceptance list, all green)

| Requirement | Legs |
|---|---|
| three selection tiers through the **shipped SQL** with crafted evidence rows | P1, P2, P3 |
| the A1 wrap state on the fourth tap of a three-set part | P4 (built through three real checks) |
| a sitting stored apart from mock runs (`mock_run_id IS NULL`) | P5 |
| the state trigger refusing a reopen | P6 |
| an unknown-sitting refusal | P7 |
| **one leg per family, all eight**: served item ids ARE the `objective_key` keys, every item offers the key typed as the key holds it | P8 ×8 (LV1, LV2, LV3, SB1, SB2, HV1, HV2, HV3) |
| `checkPracticeAttempt` marks **every** answer and refuses a second check of the same sitting | P9 |
| the HV boolean trap: string `"true"` is marked **wrong** | P10 |
| evidence recorded exactly **once** per item | P11 |
| the key is **withheld** until the learner's own evidence exists | P12 |
| the two routes **end to end** (`GET /api/v1/practice/next?family=`, `POST /api/v1/practice/check`) | P13 |

---

## 3. Commands and output

Disposable environment (removed afterwards; never the live app):

```text
docker run -d --name practice-server-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=practice_pg -p 127.0.0.1:55491:5432 postgres:17-alpine
OWNAPI_PG_ALLOW=1 OWNAPI_PG_HOST=127.0.0.1 OWNAPI_PG_PORT=55491 \
  OWNAPI_PG_DATABASE=practice_pg OWNAPI_PG_USER=postgres node server/migrate.mjs
→ migrate: schema=hatoove applied=42 skipped=0 backfilled=0 ; migrate: OK   (fresh database, 0001..0044)
```

```text
node tools/practice-selection-check.mjs --postgres
→ postgres: 9 released HV set row(s) published by the fixture
→ PASS P1 … PASS P13 (all 20 PostgreSQL legs)
→ 38 legs, 0 failed (server/practice-sets.mjs)
→ MUTATION M1 unseen no longer wins -> 1 leg(s) fail: 1 tier 1
→ MUTATION M2 most wrong becomes most correct -> 2 leg(s) fail: 3, 5
→ MUTATION M3 oldest becomes newest -> 2 leg(s) fail: 4, 5
→ MUTATION M4 the wrap never fires -> 1 leg(s) fail: 8
→ MUTATION M5 the served item stops being rebuilt and the raw authored row rides along -> 1 leg(s) fail: 17

node tools/practice-selection-check.mjs
→ 18 legs, 0 failed (server/practice-sets.mjs) + the same 5 mutation proofs
```

```text
node tools/owned-api-check.mjs                           → 35 passed, 0 failed (backend: memory)
node tools/owned-api-check.mjs --backend=postgres        → 35 passed, 0 failed (backend: postgres)
node tools/owned-api-pg-check.mjs                        → 9 passed, 0 failed
node tools/migrate-check.mjs                             → 6 passed, 0 failed
node tools/table-class-check.mjs                         → OK: every table is classified and every class rule holds.
node tools/migration-eol-check.mjs                       → 5 passed, 0 failed
node tools/repository-check.mjs                          → 728 tracked files; 645 text blobs screened
node tools/objective-key-access-check.mjs                → 9 passed, 0 failed   (documented fixture, port 62563)
node tools/part-index-check.mjs                          → 11 passed, 0 failed
node tools/design-check.mjs / retired-surface-check.mjs / seo-check.mjs (11/11)
node tools/server-origin-check.mjs (8) / keymask-check.mjs (14) / owned-client-check.mjs (32)
node tools/i18n-register-check.mjs                       → 0 findings
```

**Fixture hygiene re-measured explicitly** (fresh database, counted before/after each suite):
`practice-selection-check --postgres`, `owned-api-check --backend=postgres`, `owned-api-pg-check`,
`table-class-check`, `migrate-check`, `part-index-check` — **0 schemas / 0 roles left behind** after each.
The two `ownapi_*` schemas I saw in a first container came from my own probe scripts being truncated by
PowerShell `Select-Object -First N`, which kills `node` before its `finally` can clean up — a harness
artifact, not a check defect. Both containers were removed.

---

## 4. Migration 0044 and its MANIFEST line — NOT changed

**0044 is sound; no amendment was needed.** It was read line by line and exercised: `migrate` applies it
on a fresh database (42/0), `table-class-check` classifies `practice_attempt`, and P5/P6/P9–P12 drive the
table's real behaviour — RLS + FORCE, the owner and deletion policies, column-level INSERT/UPDATE (the
identity and set cannot be rewritten from the runtime role), the `open → checked` one-way state, and
`correct_count <= answered_count`. The MANIFEST line is byte-identical and untouched.

---

## 5. What remains unverified, and residual risk

1. **The `recordings` (listening-package) shape is NOT handled.** `normalisePracticeSet` throws
   `practice_set_items_unknown` for a `fixed_audio` payload whose items live under
   `recordings[].questions`. No shipped set uses that shape — no migration inserts a `recordings`
   objective_set payload, and `content/exams/telc-deutsch-b1/manifest.json` carries **0 sets** (the fixture
   imports no sets; the corpus comes from migration `0010`). So the shipped corpus is **100% covered**, but
   if the listening package is ever imported, telc/DTZ HV **practice** would 500 until the practice-playback
   lease adds the media binding. It should be handled there, together with the play rule — not here, and
   not by bending the DTO. It fails loudly (a named error), never as a blank page.
2. **`material` is an interface addition** (`text`/`letter`/`headlines`/`ads`/`bank`). It is additive, and
   it exists because a runner cannot render LV2 without the passage or SB1 without the letter. The client
   lease must be told; its tolerance layer should pass it through.
3. **Listening playback is still absent by design** (the handover's decision (b)). `media_required: true`
   sets are served with `playback: null`; the runner must degrade with the message that names the missing
   *practice playback path*.
4. **The client half is not proved here.** `public/app/part-runner.js` and the rendered evidence belong to
   the other lease; nothing in this note is evidence about a page.
5. **The `value`/`answer_kind` typing is proved server-side only.** P9/P10 prove the boolean is what
   `mark_objective_item` accepts; they do not prove a client posts `option.value`.
6. **`asOwner` writes crafted evidence the way a learner would, but with `item_id = 'crafted-N'`**, i.e.
   not a real item of the set. That is intentional for tier legs (they test ranking), and P8/P9/P11 use real
   item ids from the served DTO. The tier legs therefore do not prove `mark_objective_item` for crafted ids
   — P9–P12 do that with real ids.
7. **Mutation proof covers M5 for the new normaliser**; the per-family correctness rests on identity legs
   against `objective_key.answers` rather than on a mutation.

---

## 6. Files

| File | Change |
|---|---|
| `server/practice-sets.mjs` | `normalisePracticeSet` rewritten against the corpus; corpus tables; typed option values; `material`; rebuild-not-spread |
| `server/owned-postgres/adapter.mjs` | `practiceSetForPart`: `settle(..., false)`; `cr.rights_status` → `c.rights_status` in both new methods |
| `server/owned-api.mjs` | `/api/v1/vocab`: serve the whole bounded corpus by default, bounded `limit`, `invalid_limit` |
| `tools/practice-selection-check.mjs` | stack/label diagnostics; owner-bound crafted evidence; content-policy pin + restore; legs P1–P13 and offline 11–18; M5 retargeted |
| `tools/owned-api-check.mjs` | **scope note:** added the vocabulary leg and a call-capture hook to `cataloguePort()` — the Lead's explicit request, outside the original listed scope |
| `work/implementation/PRACTICE-01-PG.md` | this note |

`server/owned-postgres/node_modules/pg` is a **read-only junction** to the canonical checkout (gitignored,
not committed) because a fresh worktree has no dependencies. `git status` shows exactly the five modified
files above and no new files.
