# REVIEW-OWNER-APPROVAL-01 — the owner blanket approval of everything currently unreviewed

| | |
|---|---|
| Task | REVIEW-OWNER-APPROVAL-01 |
| Branch | `codex/review-owner-approval` (cut at `d65de1a`) |
| Worktree | `D:\Hatoove\.worktrees\review-approval` |
| Deliverable | `server/migrations/0049-review-owner-approval.sql` + its `MANIFEST.json` line |
| Also changed | `tools/pool-01-check.mjs` (one stale assertion, §9), `tools/review-owner-approval-check.mjs` (new, read-only) |
| Applied anywhere? | **No.** This is prepared for the Lead to apply in the next deploy. No push, no merge, no `scp`, no `/opt/hatoove`. |
| Verification database | disposable `postgres:17-alpine`, container `hatoove-review-approval-db`, host port **55495**, removed at the end of the run |

## 1. What was instructed, and by whom

Ron (the product owner), 5 October 2026:

> "the catalogue rows should all be marked as reviewed if they haven't been yet"

and, asked for the scope, **everything currently unreviewed**, with the **reviewer of record being Ron, product owner**.

This record and the migration implement that instruction. They are an **OWNER BLANKET APPROVAL**. They are **not** an agent review, and nothing in them claims that a named native speaker or a subject-matter specialist read any string.

## 2. What "review state" means here, and why nothing was written by hand

`server/migrations/0035-content-review.sql` and `0036-content-review-consumers.sql` define an **append-only, named-review state machine**. `effective_content_review(id)` → `project_content_review('content', NULL, id, '')` decides a status:

1. a **named decision** wins — the head row in `content_review_decision` for the subject identity, `decision='approve'` → `review_status='approved'`, `review_basis='named_decision'`;
2. otherwise `content_review_baseline.legacy_review_status` (`review_basis='legacy_unattributed'`) — and that table is immutable and trigger-guarded, so it **cannot** be the vehicle for a new approval;
3. otherwise `'unreviewed'`; a subject that does not resolve projects `'unavailable'` with `blocked = true`.

`reviewed_content_version` is the view the runtime reads. `form_review_allowed(exam, form, version, p_approved)` is what `HATOVE_CONTENT_MODE=public` requires: it reads the form, the blueprint, every member set, **and every `exam_media` row behind a `fixed_audio` set's `recordings[]`**.

So the migration records the approval **the way the toolchain records it**: an authority grant plus approve decisions, through `append_review_authority()` / `append_content_review()` (the functions `server/owned-postgres/content-review.mjs` and `tools/review-content.mjs` also call). No trigger was disabled, dropped or bypassed.

## 3. Why the identities are derived in SQL rather than typed into a generator

`resolve_review_subject()` is the only authority on a subject's identity — exam, subject kind, subject id, version, **sha256**, category and language — and on whether the subject exists at all. A generated `VALUES` list would be a second, silently-drifting copy of facts the database already owns, and a content hash typed by hand is exactly the failure mode 0035 exists to prevent.

The migration therefore asks the database and feeds the answer straight back:

- **authority grants**: one per `(exam, category, language)` triple that at least one subject actually needs, enumerated from `resolve_review_subject()` over every `content_version`, `exam_blueprint` and `exam_form` row — never assumed;
- **decisions**: one `approve` per subject currently projecting `unreviewed` or `unavailable`, with the identity and the required scope taken from `resolve_review_subject()`, and the authority taken as the current head for that reviewer/scope.

A consequence stated plainly: re-running it on a database whose content has changed approves **that** content. It approves "everything unreviewed at the moment it is applied", which is what was instructed.

## 4. Event identity, idempotence, and what is deliberately not touched

Every `event_id` is `md5` of a fixed namespace plus the subject identity (or the scope for an authority), formatted as a UUID. A second apply therefore replays the *same* events; the 0035 insert triggers recognise a replayed event, compare it against the stored row and return without inserting. `expectedDecisionId`/`expectedAuthorityId` are read from the current heads so that the replay matches.

The migration also skips, on purpose:

- a subject already projecting `approved` — re-approving would append a pointless second revision;
- a subject projecting `rejected`/`withdrawn` — **this file never overwrites an existing negative decision**, and `form_review_allowed` keeps refusing it, which is the correct outcome;
- a subject that does not resolve at all — rather than leave a silent hole, it raises `review_subject_unavailable` and the whole migration fails, so an unresolvable row is a decision for a human.

Not touched: `content_review_baseline` (immutable and trigger-guarded), `content_version` (immutable — `0006` refuses the `UPDATE`), `content_rights`, and every applied migration `0001`–`0048`. The only `UPDATE`s are the two review columns `0042` created for exactly this purpose.

## 5. The SQL evidence — disposable PostgreSQL 17, port 55495

Every number below is from a fresh `postgres:17-alpine` container with **all** migrations applied and the library-translation bundle imported (`2112` guide rows + `720` noun rows, matching production's counts).

### 5.1 Before

```text
 review_status | review_basis        | review_blocked | count
---------------+---------------------+----------------+-------
 unreviewed    | legacy_unattributed | f              |    48
 unreviewed    | none                | f              |     9
(2 rows)

 blocked | unreviewed | unavailable | total
---------+------------+-------------+-------
       0 |         57 |           0 |    57

     k     | review_status | review_basis | blocked
-----------+---------------+--------------+---------
 blueprint | unreviewed    | none         | f
 form      | unreviewed    | none         | f

          form_id           | approved_required | any_allowed
----------------------------+-------------------+-------------
 telc-deutsch-b1.reading.01 | f                 | t

 guide_translation | machine_unreviewed | 2112
 noun_translation  | machine_unreviewed |  720
 content_review_authority: 0     content_review_decision: 0     content_review_baseline: 48
```

Two details worth keeping:

- **`content_version.review_status` stays `unreviewed` after the migration, and that is correct.** That column is the immutable raw flag whose bytes `0006` freezes; the review that matters is the projection in `reviewed_content_version`. The two are deliberately different things and the migration does not pretend otherwise.
- **`content_review_baseline` carries no `blueprint` or `form` row** in a fresh database, so both format subjects project `unreviewed`/`basis=none` rather than the `approved`/`legacy_unattributed` status 0035's `INSERT` would have given them. That is because `exam_blueprint`/`exam_form` are populated by the bundled package import *after* the migrations run, so 0035's `UNION ALL` branches matched nothing. This is why the format subjects are in scope: `form_review_allowed(..., true)` reads them and refused the whole form (`approved_required = f`) before this migration.

### 5.2 After

```text
 review_status |  review_basis  | review_blocked | count
---------------+----------------+----------------+-------
 approved      | named_decision | f              |    57

 blocked | unreviewed | unavailable | total
---------+------------+-------------+-------
       0 |          0 |           0 |    57

     k     | review_status |  review_basis  | blocked
-----------+---------------+----------------+---------
 blueprint | approved      | named_decision | f
 form      | approved      | named_decision | f

          form_id           | approved_required
----------------------------+-------------------
 telc-deutsch-b1.reading.01 | t

 guide_translation | approved | 2112  (reviewer 2112, reviewed_at 2112)
 noun_translation  | approved |  720  (reviewer  720, reviewed_at  720)

 authorities: 3   decisions: 59 (59 approve, 0 reject/withdraw)   baseline: 48 (untouched)

  category   | language | revision | action |    reviewer_id    |   reviewer_name
-------------+----------+----------+--------+-------------------+--------------------
 audio       | de       |        1 | grant  | ron-product-owner | Ron (product owner)
 educational |          |        1 | grant  | ron-product-owner | Ron (product owner)
 exam_format |          |        1 | grant  | ron-product-owner | Ron (product owner)

 subject_kind | count          --  blueprint 1, content 57, form 1
```

The recorded evidence artifact is the instruction itself, pinned by the sha256 of its own text:

```text
evidence_ref    | instruction://ron-product-owner/2026-10-05/catalogue-rows-marked-reviewed
evidence_sha256 | 213a75411baf7dca6e49d38e462276f3a7dda849d77c57ab09c251f4d469de7e
rationale       | Owner blanket approval under Ron's instruction of 5 October 2026 ("the catalogue rows
                | should all be marked as reviewed if they haven't been yet"). No per-string native-speaker
                | review and no agent review of these strings is claimed or implied.
recorded_by     | hatoove_migration
```

`213a7541…` is the sha256 of the `v_instruction` literal in the migration — recomputed independently with Node's `crypto` and compared, and identical.

### 5.3 The audio behind a `fixed_audio` set is covered

`form_review_allowed` also reads every `exam_media` row behind a `fixed_audio` `recordings[]`, so a separate disposable database (`hatoove_media`) was built at the `0048` head with a synthetic listening form and a **new** unreviewed `media` content version bound to it. The check tool caught it exactly:

```text
# before 0049
FAIL every exam_media row behind a resolved fixed_audio recording is approved too
     [synthetic.0049.audio@v1=unreviewed/none]

# after 0049
PASS every exam_media row behind a resolved fixed_audio recording is approved too
     [1 resolved recording(s): synthetic.0049.audio]
```

### 5.4 Idempotence — re-applying the shipping bytes changes nothing

```text
2nd-apply BEFORE: 3/59/2112/720/57/2026-10-05 21:59:59+00/2026-10-05 21:28:44.801212+00
psql: NOTICE:  review owner approval: 0 decision(s) recorded, 3 authority scope(s) held, evidence sha256 213a7541…
2nd-apply AFTER:  3/59/2112/720/57/2026-10-05 21:59:59+00/2026-10-05 21:28:44.801212+00
identical: True
```

(`authorities/decisions/guide-approved/noun-approved/approved-projections/max reviewed_at/max decision recorded_at`.) The `0 decision(s) recorded` notice is the state machine recognising its own replayed events. The ledger also makes the ordinary path a no-op: `migrate` skips an already-applied id.

### 5.5 Negative control — the migration is what changed the state

On a fresh database with migrations `0001`–`0048` only (the same frozen files, hard-copied into a scratch directory so the `0049` file was genuinely absent), the state is the **before** state of §5.1: `57 unreviewed` (48 `legacy_unattributed` + 9 `none`), `0` authorities, `0` decisions, `blueprint`/`form` `unreviewed`, `form_review_allowed(..., true) = f`, and `2112`/`720` translation rows still `machine_unreviewed`. Applying `0049` to that same database produced exactly the **after** state of §5.2. The projection moved because of this file and nothing else.

**A subject deliberately omitted stays unreviewed, and the migration refuses to hide it.** With a pre-existing `reject` recorded on `telc-deutsch-b1.cases-guide@v1` before `0049` ran:

```text
psql: ERROR:  review_owner_approval_incomplete: content_version projection
psql: CONTEXT: PL/pgSQL function inline_code_block line 149 at RAISE

 decision | count        --  approve 1 (the pre-existing one), reject 1
 authorities: 1          -- the pre-existing grant; 0049's own inserts rolled back with it
```

The rejected subject is still `rejected`/`blocked`, the pre-existing approval is still revision 1 under its original reviewer, and the whole block rolled back rather than committing a half-approved catalogue with a silent hole. Two further controls: a subject that **cannot resolve** (`kind='guide'` with no `guide` row) raises `review_subject_unavailable: content synthetic.0049.orphan@v1` instead of being skipped; and with a **pre-existing approval** by a different reviewer already on a subject, `0049` records **58** decisions instead of 59 — it does not supersede it — leaving `59` total decisions over `59` distinct subjects, i.e. exactly one head per subject.

### 5.6 Apply order matters, and the production order is the one that works

This is a real constraint of an "approve everything that is currently unreviewed" migration, so it is stated rather than glossed:

- **On an EMPTY database with the whole directory at once, `0049` runs before the content exists.** `server/migrate.mjs` applies the migrations and the bundled package import (`importDefaultPackage`) runs *after* them; the library-translation bundle is a separate operator step. So in that one flow `0049` sees a database with no `exam_blueprint`/`exam_form` rows and no translation rows, and the check tool reports:

  ```text
  PASS every content subject projects approved with basis named_decision  [57/57 named_decision]
  FAIL every blueprint and every form projects approved with basis named_decision  [blueprint telc-deutsch-b1@v1=unreviewed/…, form …=unreviewed/…]
  FAIL form_review_allowed(..., true) is true for every form on the head release  […]
  FAIL guide_translation rows are approved and each carries a reviewer and a review time  [2112 … are not approved]
  FAIL noun_translation rows are approved and each carries a reviewer and a review time  [720 … are not approved]
  6 passed, 4 failed
  ```

  Nothing is broken by this: on a database that already holds its content — every production and upgrade path — those subjects exist when `0049` runs.

- **In the production order, the whole slice is green.** Run with the committed file, on a fresh database:

  ```text
  STEP 1  0001-0048 only (the 0049 file absent from the migration directory)   applied=46 skipped=0
  STEP 2  node tools/import-library-translations.mjs                           2112 guide, 720 noun
  STEP 3  apply 0049 alone                                                     applied=1 skipped=0
  STEP 4  node tools/review-owner-approval-check.mjs                           10 passed, 0 failed
  ```

  All ten legs pass, including `blueprint`/`form` `approved`/`named_decision`, `form_review_allowed(..., true) = t`, and `2112`/`720` translation rows approved with a reviewer and a review time.

**Consequence for the deploy:** `0049` must be applied **after** the content it is meant to approve is in the database. Where the production database already holds the rows (it does — production reports 69 `content_version` rows, 9 media and 49 tasks against this checkout's 57), that condition is already met. Where the library-translation bundle has not been imported yet, `0049` will approve the rows that exist and the later import will insert fresh `machine_unreviewed` rows that nothing re-approves — so if a bundle import for a deployment is pending, import it first.

### 5.7 A second, independent verifier

`tools/review-owner-approval-check.mjs` is new and **read-only** (every leg is a `SELECT`). It asserts the outcome at the level the decision was made: every content subject `approved`/`named_decision` (not `legacy_unattributed`), every blueprint and form likewise, `form_review_allowed(..., true)` true for every head-release form, every resolved `fixed_audio` recording approved, every approval owner-attributable **and** carrying the "no per-string native review" wording, no second decision per subject, both translation tables approved with a reviewer and a review time, and `content_review_baseline` untouched.

```text
10 passed, 0 failed
```

It was run against `hatoove_review` (10/10) and against the audio fixture `hatoove_media` (10/10, including the `fixed_audio` leg). On the `0048`-only database it reports `2 passed, 8 failed`, so it discriminates rather than rubber-stamping.

## 6. Gates

| Group | Result |
|---|---|
| `node tools/run-gates.mjs mirror` | **14/14 passed** |
| `node tools/run-gates.mjs baseline` | **9/9 passed** |
| `node tools/run-gates.mjs mirror-db` (`OWNAPI_PG_ALLOW=1 OWNAPI_PG_HOST=127.0.0.1 OWNAPI_PG_PORT=55495 OWNAPI_PG_DATABASE=hatoove_neg2 OWNAPI_PG_USER=postgres`) | **7/7 passed** |

All green. One leg needed repair first — see §9; that is stated rather than hidden because it was red on the first run.

## 7. Honest limits

1. **No per-string review is claimed.** These decisions say "the owner decided this is good enough to mark reviewed". They do not say anybody read the German, the English, or the uk/ar/tr rows. The `rationale` on every one of the 59 decisions says so in words.
2. **The machine-translated uk/ar/tr rows are now `approved` on the owner's instruction**, not because they were checked: `2112` guide strings and `720` nouns move `machine_unreviewed` → `approved` with reviewer `Ron (product owner)`. **This removes the client's "Prüfung ausstehend" / "maschinell übersetzt" marker** — a learner will no longer be told the text is unverified. That is the intended product effect of the instruction and it is a real consequence, not a cosmetic one.
3. **Row counts differ between a fresh database and production, and the migration is designed for the production shape.** A fresh database built from this repository's migrations holds **57** `content_version` rows (7 guide, 2 lexicon, 3 media, 2 rubric, 36 task… plus the writing tasks; production reports 9 media and 49 task). The difference is content that production imported and this checkout does not carry. It does not change the outcome: the migration derives its subjects from the live database, so on production it approves production's rows — every one of them that projects `unreviewed` or `unavailable` at apply time. **The migration's coverage of production's 69 rows is therefore argued from its mechanism, not measured** — see §8.
4. **The projection checks in §4 of the migration are all-or-nothing.** If production carries a content row that resolves to `unavailable`, the migration **fails** rather than approving 68 of 69 rows. That is deliberate (a silent hole is worse than a failed migration) but it means the Lead should expect either a clean apply or a specific `review_subject_unavailable`/`review_owner_approval_incomplete` error naming the row.
5. **"Reviewed" here is a product decision, not a quality claim.** Nothing has been re-generated, re-translated or corrected by this migration. Where the catalogue was wrong before, it is still wrong; it is simply no longer labelled unverified.
6. **This is not a substitute for the native review still owed.** `docs/contracts/PILOT-C06-EXPLANATION-REVIEW.md`-style per-string review, and the explanation-review workflow in `0040`, are untouched by this file. Explanations (`explanation_review_target`) are a **different** subject kind and are **not** covered — the task scope was "catalogue rows", and the migration proves it never wrote an `explanation` decision.
7. **It approves only what is in the database when it runs.** That is what was instructed, and it is also a checkable property: a `content_version` imported *after* `0049` is applied is **not** approved by it and stays `unreviewed`. §5.6 shows the order that works and why it matters for a deployment that still owes a library-translation import.

## 8. What could not be proved here

- **Applying this to the production database.** Explicitly out of scope: no push, no deploy, no `/opt/hatoove`. Every number above is from a disposable container.
- **Its behaviour against production's exact 69 rows, 9 media rows and 49 task rows.** Those rows are not in this checkout, so the run above cannot include them. What *is* proved is that the mechanism derives subjects from whatever the database holds: with three synthetic unreviewed subjects added (a new form, a new task, a new media version), the same file approved **62** decisions and left `0` unreviewed — including the synthetic audio behind a `fixed_audio` set.
- **That a real audio file's bytes verify.** The audio fixture earned its approval through SQL only; `readMediaBytes()` (the file-integrity read `tools/review-content.mjs` performs for a *fresh* audio approval) was not exercised, because `0049` does not read media bytes at all. Production's own files are unchanged by this migration.
- **That the approved uk/ar/tr text is correct.** See §7.2.

## 9. The one gate that was red, and why it was repaired

`tools/pool-01-check.mjs` leg **P1** asserted that `0048-pool-01-listening-release` was the **last** row in `hatoove_migrations` after provisioning a **clean** database and applying the **whole** migration directory. That is only true while `0048` is the newest migration in the repository, so **any** forward migration makes the leg fail on a correct, fully migrated database — the failure the first `mirror-db` run reported:

```text
FAIL P1 SQL: a clean database applies 0048 LAST, with the ledger checksums matching the file bytes: the release migration is applied last
```

The leg was repaired the way this repository already repairs that exact class of staleness: `tools/exam-s3-pg-check.mjs` derives its expected forward-migration remainder from `server/migrations/MANIFEST.json` and documents that hard-coded arrays "turned red the moment `0042`-`0047` landed". Here the expected head is derived from the migration directory the migrator itself enumerates, and the leg now asserts that the ledger ends at the code's head with that file's own digest, **plus** that `0048` is still in the ledger with the checksum of *its* bytes (the property that matters for this slice: an applied migration never moves). The frozen `0047` assertion is unchanged. `mirror` and `mirror-db` are green afterwards.

## 10. Tooling, exactly

```powershell
# disposable database
docker run -d --name hatoove-review-approval-db -e POSTGRES_HOST_AUTH_METHOD=trust `
  -e POSTGRES_DB=hatoove_review -p 127.0.0.1:55495:5432 postgres:17-alpine

$env:OWNAPI_PG_ALLOW='1'; $env:OWNAPI_PG_HOST='127.0.0.1'; $env:OWNAPI_PG_PORT='55495'
$env:OWNAPI_PG_DATABASE='hatoove_review'; $env:OWNAPI_PG_USER='postgres'
$env:OWNAPI_PG_SCHEMA='hatoove'; $env:OWNAPI_PG_ROLE_PREFIX='hatoove'

node server/migrate.mjs                                    # 0001-0048, then 0049
node tools/import-library-translations.mjs                 # 2112 guide + 720 noun rows
node tools/review-owner-approval-check.mjs                 # 10/10, read-only
node tools/run-gates.mjs mirror
node tools/run-gates.mjs baseline
node tools/run-gates.mjs mirror-db
```

The reviewer-authority and decision inputs were never hand-written as `INSERT`s. The migration calls `append_review_authority()` and `append_content_review()` inside one transaction as the schema-owner role; the 0035 triggers computed `revision`, `request_payload`, `request_sha256`, `recorded_at` and `recorded_by` themselves, and every identity came from `resolve_review_subject()`. For the two controls that needed a *pre-existing* decision, the same two functions were used with synthetic reviewer ids (`synthetic.…`/`pre-existing.fixture`) on throwaway databases only.

## 11. Files

| File | Change |
|---|---|
| `server/migrations/0049-review-owner-approval.sql` | **new** — the migration. sha256 `88d890e0ff010c2e7a2df7cfe776d9a81e9aed079625524cc26ea7c9568369a9`, LF-only |
| `server/migrations/MANIFEST.json` | **+1 line only** — the `0049` entry above. No other line added, reordered or reformatted; `0048`'s digest is byte-identical |
| `tools/review-owner-approval-check.mjs` | **new** — read-only verifier of the outcome (§5.7) |
| `tools/pool-01-check.mjs` | one stale assertion repaired (§9) |
| `work/implementation/REVIEW-OWNER-APPROVAL-01.md` | **new** — this record |

Not changed: `0001`–`0048`, `content/exams/**`, `content/pool-01/**`, `public/**`, `server/owned-postgres/adapter.mjs`, `data/seed.json`.
