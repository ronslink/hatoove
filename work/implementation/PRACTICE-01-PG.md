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

## 0. Follow-up lease task-20 — the independent review's findings (BLOCKED → fixed)

REVIEW-PRACTICE-01-SERVER (teammate `reviewer`, `handoff/ron-agent/practice-01-server-review-reviewer.md`)
verified this slice independently and returned **BLOCKED** on 15c8ded. Its four findings are fixed on this
branch; the counts above are the pre-review ones, and **§0.1–§0.5 supersede them**.

### 0.1 D1 — MUST FIX: `POST /api/v1/practice/check` answered 404 for every LISTENING set, after committing

The reviewer drove the shipped route: LV1/LV2/LV3/SB1/SB2 → 200, **HV1/HV2/HV3 → 404**, with the sitting
already `checked` and every answer marked. The route enriched the review with
`readObjectiveEvidenceExplanation` **after** `checkPracticeAttempt` returned, and that reader is a
CHOICE-family reader by design (`0037` requires `jsonb_typeof(answer) = 'string'` AND `NOT media_required`).
An HV answer is a JSON **boolean** on a `media_required` set, so the reader raised `not_found` twice over; the
fault decided the HTTP status, and the learner's review was thrown away. A retry answered 409
`attempt_already_checked`, so it was unrecoverable. **The suite missed it because its one HTTP leg (P13) drove
LV1 only** — a family whose explanations exist.

**Fix, at the level that cannot recur.** The review now carries the facts the route needs — `media_required`
for the set and `answer_kind` per item (`judgement` when the revealed key is a JSON boolean, derived from the
same fact `0037` refuses on) — and the route applies two guards: a judgement item, or any item of a
`media_required` set, **serves `explanation: null`** instead of being asked for; and **any** failure from the
reader is caught into `explanation: null`. An explanation is enrichment; it can never decide the response to a
committed check. A datastore that does not disclose `answer_kind` keeps the previous behaviour (ask the
reader), so no other backend changes.

**Proved both ways** (`tools/practice-selection-check.mjs`): **P14** drives HV2 over HTTP → 200 with the whole
review (`answer_kind: judgement`, boolean `expected`, `explanation: null`, `media_required: true`), the sitting
`checked`, the retry 409 — and LV1 still receives its explanations, so the fix skips rather than disables.
**P15** is the mutation: it copies the whole `server/` tree, puts the defect back in the route copy, and drives
the same call — **404, with the sitting `checked` and every answer marked**, exactly the reviewer's
reproduction. The guard is the only thing between the two.

### 0.2 D2 — MUST FIX: SB1 has FOUR released sets, and the drill's own disclosure was dropped

A1's "three sets per part" is true for every part except SB1. The fourth SB1 set is
`telc-deutsch-b1.sb1.grammar-wortstellung-v1`, the 12-item grammar drill from migration `0022`
(`content/drills/recovered-grammar.json#banks.wortstellung_nebensatz`), so **SB1's wrap fires on the fifth
tap**. It is released practice content, so it is **disclosed, not filtered out**: `material` now carries the
set's own `practice_kind` (`grammar-drill`) and `instruction` ("Ergänze die Sätze. Dies sind einzelne
Grammatikübungen, kein telc-Prüfungssatz."), which the DTO had been dropping entirely. **P16** drives SB1 to
the drill and asserts the disclosure, the four-set count and the fifth-tap wrap; **offline legs 19/20** pin the
disclosure and the four-set wrap, and **mutation M6** removes the disclosure fields so leg 19 fails. A1 itself
is the Lead's to amend; this note and the code comment no longer repeat the "0010 only" claim.

### 0.3 D3 — the `repository-check` figure was the base commit's

Corrected in §3 below: at this head it is **729 tracked files / 646 text blobs**, not the 728/645 the first
draft quoted (that was `c839079`).

### 0.4 D4 — `practiceRoundState().round` contradicted its own doc on a wrap

The FIELD was right and the DOC was wrong: a wrap begins no further round, so `round` stays at the part's last
round (`setCount`) and never exceeds it, which is what a client rendering "Runde {round} von {setCount}" needs.
The comment said "the round the next tap begins" unconditionally, which reads as 4 on a three-set wrap. The
doc now says exactly what the code does, and offline leg 8 additionally pins `round <= setCount`.

### 0.5 D5 — "an imported listening set would 500" was unproven

Replaced with a measurement (**P17**): a `content/exams/%` set with no package membership is **excluded** by
`importedSetGate()`, and the route answers `reason: 'nothing_available'` rather than erroring; the normaliser's
own refusal of that payload shape is asserted separately. See §5.1.

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

The authored corpus is **24 sets from `server/migrations/0010-objective-catalogue.sql` plus one from
`server/migrations/0022-recovered-grammar-drills.sql`** — **25** in total, and this note said "0010" for all of
them until REVIEW-PRACTICE-01-SERVER D2 measured otherwise. The 25th is
`telc-deutsch-b1.sb1.grammar-wortstellung-v1`, the recovered grammar drill sourced from
`content/drills/recovered-grammar.json`, so **SB1 has four released sets, not three**, and its A1 wrap fires on
the fifth tap. Measured from a disposable database (every set internally consistent: payload rows ==
`item_count` == `objective_key.answers` keys):

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
| the two routes **end to end** (`GET /api/v1/practice/next?family=`, `POST /api/v1/practice/check`) | P13 (LV1) |
| **a LISTENING check returns its review over HTTP** — 200, boolean key, `explanation: null`, sitting `checked`, retry 409 — and a choice family keeps its explanations | P14 (HV2 + LV1) |
| **the mutation that makes P14 bite**: the defect put back in a copy of the route → 404 with the sitting committed | P15 |
| **SB1's four released sets**, the recovered drill's own disclosure reaches the DTO, and the wrap fires on the **fifth** tap at round 4/4 | P16 |
| **D5 proven**: an unimported `content/exams` set is `nothing_available`, not a 500 | P17 |

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
→ PASS P1 … PASS P17 (all 26 PostgreSQL legs, P14–P17 added by task-20)
→ 44 legs, 0 failed (server/practice-sets.mjs)
→ MUTATION M1 unseen no longer wins -> 1 leg(s) fail: 1 tier 1
→ MUTATION M2 most wrong becomes most correct -> 2 leg(s) fail: 3, 5
→ MUTATION M3 oldest becomes newest -> 2 leg(s) fail: 4, 5
→ MUTATION M4 the wrap never fires -> 2 leg(s) fail: 4, 8
→ MUTATION M5 the served item stops being rebuilt and the raw authored row rides along -> 1 leg(s) fail: 17
→ MUTATION M6 the set stops disclosing what kind of practice it is (D2) -> 1 leg(s) fail: 19
→ PASS P15 MUTATION: the same listening check answers 404 with the sitting committed, without the guard (D1)

node tools/practice-selection-check.mjs
→ 20 legs, 0 failed (server/practice-sets.mjs) + the same 6 mutation proofs
```

```text
node tools/owned-api-check.mjs                           → 35 passed, 0 failed (backend: memory)
node tools/owned-api-check.mjs --backend=postgres        → 35 passed, 0 failed (backend: postgres)
node tools/owned-api-pg-check.mjs                        → 9 passed, 0 failed
node tools/migrate-check.mjs                             → 6 passed, 0 failed
node tools/table-class-check.mjs                         → OK: every table is classified and every class rule holds.
node tools/migration-eol-check.mjs                       → 5 passed, 0 failed
node tools/repository-check.mjs                          → 729 tracked files; 646 text blobs screened
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
   `practice_set_items_unknown` for a `fixed_audio` payload whose items live under `recordings[].questions`.
   **Corrected by REVIEW-PRACTICE-01-SERVER D5 — the original claim here ("an imported listening set would
   500") was UNPROVEN and is now measured:** no shipped set uses that shape (no migration inserts a
   `recordings` objective_set payload; the corpus is the 24 `0010` sets plus the `0022` drill, and
   `content/exams/telc-deutsch-b1/manifest.json` imports **0 sets**), and a `content/exams/%` set with no
   package membership is **excluded** by `importedSetGate()` before the normaliser is ever reached — the route
   answers `nothing_available`, it does not 500. That is now a leg (P17): the exclusion is asserted over the
   route, and the normaliser's own refusal of the empty/recordings shape is asserted separately. The
   *unproven* part that remains is a set that is a genuine package member *and* carries `recordings` — only
   then does this become reachable, and the practice-playback lease (task-17, branch
   `codex/practice-media-17`) is where the recordings shape and its media binding are handled together.
2. **`material` is an interface addition** (`text`/`letter`/`headlines`/`ads`/`bank`, and now
   `practice_kind`/`instruction`). It is additive, and it exists because a runner cannot render LV2 without
   the passage, SB1 without the letter, or the recovered drill without its "not an exam set" instruction. The
   client lease must be told; its tolerance layer should pass it through.
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
