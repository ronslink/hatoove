# LIBRARY-I18N-01 (slice F2) — the uk/ar/tr library translations

**Task:** `task-2` · **Branch:** `codex/library-i18n-01-import` · **Base:** `072d29e`
**Contract:** `docs/contracts/MIRROR-B1PREP-01.md` §4.3, §4.4, §4.5, §5 F2
**Status:** delivered, not independently reviewed, not merged.

## 1. Scope

Storage, import and the additive read path for the offline uk/ar/tr reference-library bundle. The
bundle bytes are unchanged: `content/library-translations/hatoove-library-translations-uk-ar-tr.json`
still hashes to the digest pinned in its README
(`f916bc94853f87b723f7b29542554bd4a4194330406f2b1d385efcee2d23776d`, 546 584 bytes).

Delivered:

| File | What |
|---|---|
| `server/migrations/0042-library-translations.sql` | **new** — `guide_translation` + `noun_translation`, modelled on `0040` (status/reviewer/reviewed_at/source_content_version, constraints, indexes, least-privilege grants). Seeds no row. |
| `server/migrations/MANIFEST.json` | **+1 line only** — `0042-library-translations` sha256 `b2c2a054…ec1c`; no other line added, reordered or reformatted. |
| `server/library-translations.mjs` | **new** — bundle verification, source binding, importer, read path. No connection of its own. |
| `tools/import-library-translations.mjs` | **new** — operator CLI, one transaction, `<prefix>_migration` role, `--dry-run`. |
| `tools/library-i18n-check.mjs` | **new** — 7 offline + 11 PostgreSQL legs (18 total). |
| `server/owned-api.mjs` | **modified, +23/−1** — the guide route attaches `translations` only when `?locale=` is present. |
| `server/owned-postgres/adapter.mjs` | **modified, +18** — one read-only method `readGuideTranslations` on the learner pool. |
| `tools/lib/catalogue.mjs` | **modified, +5** — the two new tables join `CATALOGUE_TABLES`. |

Three of those are files outside the task's listed scope. They are named in the report to the Lead so
integration can be serialised:

- `server/owned-postgres/adapter.mjs` — the read path needs a pool, and the adapter is the only place a
  restriction-safe read can live; adding the method here (rather than in a new module) is what makes the
  running server serve translations without a second wiring path.
- `tools/lib/catalogue.mjs` — `tools/table-class-check.mjs` fails on an **unclassified** table, so the two
  new tables must join `CATALOGUE_TABLES`; they are the same owner-less shared library as
  `guide`/`guide_section`, written only by the schema owner and read by the learner role.
- `server/owned-api.mjs` — the route itself, explicitly allowed by the task if the read path requires it.

## 2. The read path, exactly as built

`GET /api/v1/guides/:id?locale=<l>`:

```json
{
  "locale": "uk",
  "guideVersion": "telc-deutsch-b1.cases-guide@v1",
  "status": "machine_unreviewed",
  "strings": { "<path>": "<text>" },
  "nouns": { "<entry_id>": { "meaning": "…", "example": "…", "rule": "…" } },
  "stringStatus": { "<path>": "machine_unreviewed" }
}
```

- **Additive only.** Without `locale` the response is the pre-slice object, byte for byte — proved by
  comparing the rich datastore against the same datastore with the method deleted (leg 14).
- `de`/`en` are accepted and answer `null` (interface languages with no bundle), so the client can send its
  selected language unconditionally. Any other value is `422 invalid_locale`.
- A rejected row is never served. A row whose `source_content_version` is not the version current at read
  time is never served. `translations` is `null` unless the guide has at least one current, non-rejected
  translated line.
- `status` is conservative: `machine_unreviewed` while **any** served row is machine-produced, so the
  "maschinell übersetzt · Prüfung ausstehend" marker cannot disappear one line ahead of the review.

### Two interpretation decisions the reviewer should check against the contract

1. **`stringStatus` is an addition.** §4.3 asks for per-string review status "so the client can mark
   `machine_unreviewed` lines", but the member list it freezes (`locale`, `guideVersion`, `status`,
   `strings`, `nouns`) has no per-string member. Both requirements are met by keeping the frozen five and
   adding one map inside the already-additive member. `status` covers nouns as well; only guide strings
   have a per-string map. If the Lead prefers the literal five, drop `stringStatus` — the client in slice E
   reads `strings` and `status` and is unaffected either way.
2. **Stale and absent share one answer (`null`).** The frozen shape has no `stale` member, so the read
   path cannot label staleness without an amendment. It therefore refuses to serve a stale bundle at all
   (§4.3: "stale bundles are not served as current"), which means the client shows its Übersetzung-folgt
   note. An operator cannot distinguish "never imported" from "imported and now stale" through the API.

## 3. Import

`node tools/import-library-translations.mjs [--dry-run]`, as `<prefix>_migration`, one transaction,
`OWNAPI_PG_ALLOW=1` required, `postgres`/`template0`/`template1` refused.

- Proves the bundle's sha256 against the README pin **and** its byte count (546 584).
- Binds every one of the 737 guide paths to a real `guide_section`, a real field and the source's own
  English field (`en` must equal `…En` byte for byte), and refuses the bundle otherwise. This is what makes
  the import version-safe: a source that moved fails the import instead of attaching translations to the
  wrong version.
- Requires every German article+noun fragment quoted inside a translation to appear verbatim in the German
  source (case difference on a sentence-initial article accepted).
- Requires the 240 nouns' `de`, `example_de`, `en`, `example_en` to equal the seeded columns.
- Writes every row `machine_unreviewed` with `reviewer`/`reviewed_at` NULL; it never writes `approved`.
- **Idempotent by construction:** an existing row is compared and then left completely alone. A row that
  disagrees is a conflict that fails the whole transaction, so a re-import cannot overwrite a native review
  or silently re-point a row at a new version.
- **No delete path.** A string removed from a future bundle stays in the table (residual risk 3).

## 4. Evidence — exact commands and results

Disposable PostgreSQL only: `docker run -d --name hatoove-libi18n-pg -e POSTGRES_HOST_AUTH_METHOD=trust
-e POSTGRES_DB=libi18n_scratch -p 127.0.0.1:55441:5432 postgres:17-alpine`. No live app, no production
database, no learner data. The container was removed after the runs.

### 4.1 Migration

```
node server/migrate.mjs                      # empty database libi18n_fresh
  migrate: schema=hatoove applied=40 skipped=0 backfilled=0   → 0042-library-translations included
  ledger: SELECT count(*), max(id) → 40 | 0042-library-translations

node server/migrate.mjs                      # database already at 0041 (libi18n_scratch)
  migrate: schema=hatoove applied=1 skipped=39 backfilled=0
  applied: 0042-library-translations          → migrate: OK
  ledger: 0040-explanation-review|c56f5516…, 0041-objective-answer-reveal|73517882…,
          0042-library-translations|b2c2a054a074ae14ad055a05fea85f0c802ce39444d2b87dce163bbef517ec1c
```

`node tools/migrate-check.mjs` — **6 passed, 0 failed** (fresh apply, ledger checksums computed from the
files, tampered migration refused, runtime never migrates and reports `schema_behind` with 0042 pending,
runtime holds no privileged pool, control run clean). Log: `%TEMP%\libi18n-evidence\migrate-check.log`.

MANIFEST agreement, computed independently: 26 entries checked, **0 mismatches**; the `0042` line equals
the sha256 of the file bytes (`b2c2a054…ec1c`). `0042-library-translations.sql` is LF-only (92 LF, 0 CRLF),
5756 bytes.

### 4.2 Import and idempotence

```
node tools/import-library-translations.mjs --dry-run
  {"digest":"f916bc94…","dryRun":true,"guideStrings":{"inserted":2211,"unchanged":0,"total":2211,
   "boundEnglish":737},"nouns":{"inserted":720,"unchanged":0,"total":720},"schema":"hatoove"}

node tools/import-library-translations.mjs        # first real run
  guideStrings.inserted=2211, nouns.inserted=720
  fingerprint: guide_rows=2211 noun_rows=720
               guide_md5=8a23318d1f4ba27ce1fa51f672475bc1 noun_md5=f5665fd5575088c6d77b3ece3cb69229
               machine_unreviewed: 2211/2211 and 720/720

node tools/import-library-translations.mjs        # second run
  guideStrings.inserted=0 unchanged=2211, nouns.inserted=0 unchanged=720
  fingerprint: byte-identical (same two md5s, same counts)
```

737 strings × 3 locales = 2211 rows; 240 nouns × 3 locales = 720 rows.

### 4.3 The slice's check

```
node tools/library-i18n-check.mjs                 → 7 passed, 0 failed
node tools/library-i18n-check.mjs --postgres      → 18 passed, 0 failed
```

Offline legs: pinned digest; tampered bundle / mutated pin / second pin / wrong bytes refused; header and
counts (737 + 240, per-guide 61/80/132/125/130/110/99); the frozen source parses to 240 nouns, 123
sections, 7 guides; all 737 paths bound with `en` equal to the source English field; the German noun rows
and the 534 German article+noun fragments quoted in translations are verbatim; and a mutation proof (one
changed `en`, one retyped German fragment, one changed German noun sentence, one nonexistent section are
each refused).

PostgreSQL legs (own disposable `ownapi_<hex>` schema, 18 total, `PASS …` lines in
`%TEMP%\libi18n-evidence\check-postgres.log`): unimported locale and `de`/`en` answer `null`; the import
writes 2211+720 rows all `machine_unreviewed` and leaves `guide`, `guide_section` and `noun_entry`
byte-identical; a second import inserts nothing and the row fingerprint is unchanged; a dry run writes
nothing; `uk` serves 61 cases-guide strings + 240 nouns at `telc-deutsch-b1.cases-guide@v1`; no-locale JSON
is byte-identical to the pre-slice datastore; an unimported/`xx`/empty locale is `422`; a rejected row is
omitted and a fully rejected guide answers `null`; an approved row is marked in `stringStatus` while the
bundle marker stays conservative and flips to `approved` only when every served row is; a stale
`source_content_version` answers `null`; the database's German noun sentences still equal the bundle's.

### 4.4 Baseline and adjacent gates

| Command | Result |
|---|---|
| `node tools/owned-api-check.mjs` | 34 passed, 0 failed (backend: memory) |
| `node tools/owned-api-check.mjs --backend=postgres` | 34 passed, 0 failed (backend: postgres) |
| `node tools/repository-check.mjs` | passed: **704 tracked files, 621 text blobs screened** at this head (`de70517`; the 699/616 figure in the first draft was the base commit's, corrected after REVIEW-LIBRARY-I18N-01 F2) |
| `node tools/migrate-check.mjs` | 6 passed, 0 failed |
| `node tools/table-class-check.mjs` | 85 tables, **0 failures**; both new tables `catalogue … OK` |
| `node tools/design-check.mjs` · `retired-surface-check` · `seo-check` · `server-origin-check` · `keymask-check` · `owned-client-check` · `i18n-register-check` · `migration-eol-check` | all exit 0 |

`repository-check`, `design-check`, `seo-check` and the two ownership checks are unaffected by this slice
(no client bytes changed). Running them is what proves that.

## 5. Not verified

1. **The client.** No rendered or browser evidence: slice E owns `public/app/library.js` and the
   "Übersetzung folgt" note. This slice proves the API answer, not what the learner sees.
2. **The review workflow.** Approving or rejecting a row is `UPDATE guide_translation` / `noun_translation`
   as the schema owner; there is no review UI, no `content_review_decision` integration and no reviewer
   authority check in this slice, and no human review has happened. Every imported row is
   `machine_unreviewed`.
3. **A second guide version.** No install has `…@v2`, so "stale" was proved by moving a row's
   `source_content_version` in a disposable database, not by a real version bump. The read path filters on
   the current version, which is the same code path either way.
4. **Any exam package other than `telc-deutsch-b1`.** Only that package exists; the read path is scoped by
   `guide_id`, not by exam.
5. **Deployment.** Nothing was deployed, pushed, or started against the live app; no Compose service, no
   `/api/ready` check, no `--backend=postgres-persistent` run of `owned-api-check`.
6. **Payload size on a real network.** See residual risk 1 — measured but not exercised end to end.
7. **`stringStatus` under a large mixed review.** Only one approved row and one fully-approved guide were
   exercised.

## 6. Residual risk

1. **The `nouns` member is not scoped and dominates the response.** Measured from the bundle, a `uk`
   locale-qualified guide read adds ~64 KB. REVIEW-LIBRARY-I18N-01 F2 asked for the basis, and it is
   **serialized** size, not raw text: 63 905 B total = 8 868 B of serialized strings (4 094 B of raw text)
   + 54 924 B of the serialized 240-noun lexicon (37 268 B of raw text). That is the contract's shape (§4.3
   puts the lexicon in the same member), so it is implemented as frozen, but it is the one place where this
   slice could make a guide page noticeably heavier. If that matters, the fix is a contract amendment
   (`nouns` on `/api/v1/nouns?locale=` instead), not a slice-local choice.
2. **Stale is indistinguishable from absent** through the API (decision 2 above). An operator who needs the
   difference needs an operational signal, not a response member.
3. **No delete or supersede path.** A string dropped from a later bundle keeps its row. Nothing in this
   slice can remove it; that needs a deliberate migration or a `superseded` status, and it must not be
   added silently.
4. **No immutability trigger on the translated bytes.** The importer cannot rewrite a row (it fails on a
   conflict), but a future writer running as the schema owner could `UPDATE … text` without changing
   `source_content_version`. The review workflow that will legitimately `UPDATE review_status` is the slice
   that should also decide whether `text` becomes immutable after approval.
5. **The source binding is strict by design.** Every bundle path must have an English sibling in the source
   (`…En`, `title_en`, `summary_en`) or the import refuses the whole bundle. All 737 have one today; a
   future bundle that translates a German-only field would need the binding rule extended, deliberately.
6. **`source_content_version` is taken as the version current at import time.** The bundle's own header
   (`…@v1`) is not compared against it; the 737-way English equality and the 240-way German equality are the
   real proof that the source is the one the bundle came from. If the source ever matched by accident after
   a silent edit, that proof would weaken — the digest pin is the defence, and it covers the bundle, not the
   source.
7. **`node tools/library-i18n-check.mjs` is not yet in `package.json`.** The offline seven legs are fast and
   need no database, so they belong in the `check` script; `package.json` is outside this slice's write
   scope, so the Lead should add the line at integration (`node tools/library-i18n-check.mjs` — the
   `--postgres` variant belongs with `check:db`).

## 7. Review response — REVIEW-LIBRARY-I18N-01 (mock-intro), 5 October 2026

The independent review returned **CLEAR WITH NOTES**, with one defect to fix before integration. It
reproduced the migration, the grants, the import idempotence, the mutation refusals (against on-disk
bytes rather than in memory), and the read path with its own 20-leg script, and it re-ran every suite.
The fix below was made by the Lead on this branch, so the reviewer of record is not the author of the fix.

| Finding | Disposition |
|---|---|
| **F1 (real defect).** The two `*_reviewer_check` constraints proved only "at least one of reviewer/reviewed_at", so `approved` with a null reviewer, or a null `reviewed_at`, was accepted while the comment claimed both were required. | **Fixed in place** (0042 is unapplied everywhere): both constraints now use `CASE WHEN review_status = 'machine_unreviewed' THEN (both NULL) ELSE (both NOT NULL) END`, which is exactly the comment's guarantee. Proof on a fresh disposable database with all 40 migrations applied: P1 approved + reviewer NULL **rejected**, P2 approved + reviewed_at NULL **rejected**, P3 rejected + reviewer NULL **rejected**, P4 machine + reviewer set **rejected**, P4b machine + reviewed_at set **rejected**, P5 approved + both set **accepted**, P6 machine + both NULL **accepted**, P7 the same probe on `noun_translation` **rejected**. Then `library-i18n-check` 7/7 offline and 18/18 `--postgres`, `owned-api-check --backend=postgres` 34/34, all on the fixed migration. The MANIFEST line moved with the file: `9b08522e6fa951a40f2989dee1f85173adf07fc45f55978e2aa08bcf7592dab0` (6 324 B, 102 LF, 0 CRLF). |
| **F2.** This note quoted the base commit's `repository-check` numbers and an unexplained ~64 KB. | Both corrected above: 704/621 at this head, and the 64 KB now states its basis (serialized, and the split between strings and the noun lexicon). |
| **F3 (cosmetic).** The CLI prints its error code twice. | Left as is: it is a `prefix: code: code` cosmetic in a developer-only tool, and changing a message that a check greps for is riskier than the duplication. Recorded here instead. |
| **N1 (could not verify).** The production composition root that injects the datastore is not in this repository, so "the live server reads on the learner pool" is inferred from the adapter contract, the in-repo constructions and the grants — not observed on a running server. | Accepted and recorded. It is the same limit the review states; the grant and pool split are enforced by the migration, which is the part this slice owns. |
| **N3.** The storage locale CHECK forbids `de`/`en` rows, so a future de/en bundle needs a migration, not just an import. | Recorded as residual risk. |
| **N4.** A locale-qualified guide read is three queries, only one of which was described. | Recorded here; the note's residual 1 describes the payload, not the query count. |
| **N6.** `stringStatus` and stale ≡ absent were already settled by amendment A2 in the canonical contract. | Confirmed; nothing changed. The reviewed head predates A1–A3, which is a documentation gap between the worktree and canonical `main`, not a code divergence. |
