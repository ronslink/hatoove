# CONTENT-CORRECTIONS — the three German source defects and migration 0043

**Task:** `task-10` · **Branch:** `codex/content-corrections-sources` (worktree `.worktrees/content-corrections`,
base local `main` = `3be374a`) · **Authority:** `docs/contracts/MIRROR-B1PREP-01.md` §7 and §4.5, plus
`content/library-translations/README.md` ("Source-data defects found while translating").
**Status:** delivered, not independently reviewed, not merged.

## 1. What changed, and only this

| File | Change |
|---|---|
| `data/noun-lexicon.json` | **5 strings in 2 entries** (defects 1 and 2). Nothing else; still 240 entries. |
| `data/speaking-guide.json` | **SP1 replaced** with the official Teil 1 task (defect 3). SP2 and SP3 are byte-identical to the pre-slice version (pinned digests in the check). |
| `server/migrations/0043-content-corrections.sql` | **new** — 3 UPDATEs: 2 `noun_entry` rows, 1 `guide_section` row. Generated from the corrected data, so the migration and the source of truth cannot drift. |
| `server/migrations/MANIFEST.json` | **+1 line only** — `0043-content-corrections` = `25ea3a269b1b19e35dd3f4998b0df1b6ad158ad9d6ed11108c5620b115568029`. The `0042` line is untouched and still matches its file. |
| `tools/content-corrections-check.mjs` | **new** — 8 legs, mutation-proven, `--root=` for copies. |
| `work/implementation/CONTENT-CORRECTIONS.md` | this note. |

`0012`, `0013` and `0014` are **untouched**, pinned by digest in the check
(`0012 aeb3fac3…`, `0013 fe43ab3e…`, `0014 0cd012f1…`). The `MANIFEST.json` change is one appended line.

**Diff-level proof of "no other row changed":** the check parses 0043 and asserts it holds exactly three
statements — two `noun_entry` UPDATEs and one `guide_section` UPDATE — and no `INSERT`, `DELETE`, `DROP`,
`ALTER`, `TRUNCATE` or `CREATE`; the postgres leg then proves the database has 240 nouns, 123 sections and 7
guides with the corrected values. No row is added or removed by this slice.

## 2. The three defects, and the source for each

### Defect 1 — `das Familiemitglied` → `das Familienmitglied` (typo)

`data/noun-lexicon.json`, entry `telc-deutsch-b1.noun.das-familiemitglied` (index 16). Three strings:

| field | was | is |
|---|---|---|
| `de` | `das Familiemitglied` | `das Familienmitglied` |
| `plural` | `die Familiemitglieder` | `die Familienmitglieder` |
| `example` | `Jedes Familiemitglied bringt etwas zum Buffet mit.` | `Jedes Familienmitglied bringt etwas zum Buffet mit.` |

`en`, `exampleEn`, `rule`, `ruleEn`, `theme`, `gender`, `pos` unchanged. **The frozen `entry_id` keeps the
historical misspelling** (`…das-familiemitglied`): ids are built from the seed-time lemma and are never
rewritten, and F2's bundle uses the same id, so nothing downstream re-keys.

### Defect 2 — `die Möbel` glossed as a singular, with wrong German in the example

Same file, entry `telc-deutsch-b1.noun.die-moebel` (index 25). Two strings:

| field | was | is | why |
|---|---|---|---|
| `en` | `piece of furniture` | `furniture` | the lemma is the **plural** noun; the gloss was the singular |
| `example` | `Dieses Möbel passt überhaupt nicht in unser Wohnzimmer.` | `Dieses Möbelstück passt überhaupt nicht in unser Wohnzimmer.` | `dieses Möbel` treats a plural-only noun as singular; the singular is `das Möbelstück` |

Unchanged: `de` (`die Möbel`), `plural` (`die Möbel` — the only plural-only entry, and the file's convention
for one is to repeat the form; the 33 singular-only entries use `kein Plural`), `gender`, `rule`, `ruleEn`,
`theme`, **`exampleEn`** (`This piece of furniture does not fit in our living room at all.` — still exactly
what the corrected German sentence says, which is the "same meaning in every language" requirement).

`rule`/`ruleEn` were **deliberately left alone**. Writing "nur im Plural; der Singular ist das Möbelstück"
there would be better pedagogy, but the F2 bundle carries `rule` translations for this entry in uk/ar/tr
("правила немає — вивчіть напам'ять" and equivalents): changing the German rule would silently make three
stored translations describe a rule that no longer exists, and this slice must not edit translation rows. The
correct singular is taught by the corrected example instead. Recorded here so the decision is visible.

### Defect 3 — the speaking guide taught Teil 1 as a three-minute presentation

`data/speaking-guide.json` part **SP1**. Source (**verified**, not assumed):
`exam-product-review.md:11-18`, table *"Resolve exam fidelity before launch"* —

| Area | Current implementation | Official reference |
|---|---|---|
| Speaking part 1 | Three-minute presentation on a topic | **Getting to know the other candidate** |
| Speaking points | 25 / 25 / 25 | **15 / 30 / 30** |

with line 18 citing telc's official B1 model examination (printed pages 5, 18, 34–39) and recording that
"oral assessment focuses on direct interaction between candidates".

What SP1 now says (decision: **option (a)**, minimal and fully source-backed, per the Lead):

- `title`: *Teil 1 – Sich kennenlernen* / `titleEn`: *Part 1 – Getting to know each other*
- `summary`: *In Teil 1 halten Sie keinen Vortrag: Die Kandidaten lernen sich kennen und beantworten einfache
  Fragen zur eigenen Person. Die Prüfer achten auf die direkte Interaktion zwischen den Kandidaten.*
- `approach`: 3 steps — answer the questions about yourself; ask the partner simple questions; react to the
  answers (so it is a conversation, not a monologue).
- `phrases`: 3 groups — *Über sich selbst sprechen* (4 items), *Fragen an den Partner* (4), *Reagieren und
  nachfragen* (3), each with German/English and an example sentence.
- `examples`: 1 short getting-to-know exchange. `watchOut`: 3 lines, the first stating that Teil 1 is not a
  presentation and does not work from keywords.
- **The presentation material is removed, not relabelled** (the Lead's instruction: relabelling keeps the
  wrong task in the reference guide). The removed Redemittel are recoverable from git — `git show 3be374a:data/speaking-guide.json`
  — if a verified Präsentation part is ever added as its own part.

Two judgement calls inside SP1, recorded because they are not verified facts:

1. **`minutes` and every `approach[].seconds` are `null`.** The old `3` minutes and the per-step seconds were
   the *presentation's* timing, and this repository verifies no duration for a getting-to-know task. I checked
   that nothing renders them: `guide-content.js` and `library.js` contain no `minutes` or `seconds` reference to
   a guide part (only `mock.js:340` uses run time groups). A number here would be an unverified exam fact
   displayed to a learner; `null` says "not stated". The native review can settle it.
2. **The new German prose uses the formal address** ("Sie"), which is what SP1's own existing `approach` text
   already used ("Nennen Sie das Thema klar und deutlich"). This does not sweep the informal strings elsewhere
   in the guide (see §6).

**Not touched, and not verified:** SP2 (*Teil 2 – Diskussion*, 6 min) and SP3 (*Teil 3 – Gemeinsam etwas
planen*, 5 min) are byte-identical to the pre-slice version. The repository verifies nothing about official
Teil 2 or Teil 3 — `exam-product-review.md` names only part 1 and the 15/30/30 weights — so no attempt was made
to make the structure look tidy by writing an unverified exam fact. Both parts are queued for the same native
review as the rest of the guide, together with the observation that the guide's "Teil 2 – Diskussion" matches
no official part that this repository can evidence.

## 3. Migration 0043

```
server/migrations/0043-content-corrections.sql   7577 bytes, LF-only, 40 lines
  3 UPDATE statements:
    noun_entry   × 2   (telc-deutsch-b1.noun.das-familiemitglied: de/plural/example
                        telc-deutsch-b1.noun.die-moebel:            en/example)
    guide_section × 1  (speaking-guide / telc-deutsch-b1.speaking-guide.sp1: title, title_en,
                        summary, summary_en, payload = {minutes, approach, phrases, examples,
                        watchOut, watchOutEn} — the builder's payload mapping)
  sha256 = 25ea3a269b1b19e35dd3f4998b0df1b6ad158ad9d6ed11108c5620b115568029
  MANIFEST line = the same value (asserted by check leg 8)
```

Why an UPDATE against the seeds rather than regenerated seeds: `0012`/`0013`/`0014` are applied in production
with frozen checksums, and the applied bytes are what make an old attempt's recorded content mean anything.
The migration was generated **from** the corrected data files (a `%TEMP%` generator, the same data→SQL
discipline as `tools/build-*.mjs`), and check leg 7 re-derives every value and the payload from the data, so
drift between the two is a gate failure rather than a silent divergence. The generator also asserts that the
frozen seeds *still contain* the defects — if a seed were ever regenerated with the corrections, this
migration would be correcting nothing and the check says so (leg 2).

`content_version.content_sha256` is **not** updated and cannot be: `0006-content-and-catalogue.sql:91-93` puts a
`BEFORE UPDATE OR DELETE` trigger on `content_version` whose function always raises. The drift is therefore a
fact of the schema, not an omission — see §5.

## 4. Checks and evidence

All commands from `.worktrees/content-corrections` (`node` 24.4.1).

```text
node tools/content-corrections-check.mjs                        8 passed, 0 failed
node tools/migrate-check.mjs                                    6 passed, 0 failed
node tools/table-class-check.mjs                                OK: every table is classified and every class rule holds
node tools/guide-render-check.mjs                               303 real examples preserved, 15 wrong examples labelled
node tools/repository-check.mjs                                 passed: 707 tracked files, 624 text blobs screened
node tools/design-check.mjs · retired-surface-check · seo-check · server-origin-check
  · keymask-check · owned-api-check (memory) · owned-client-check
  · i18n-register-check · migration-eol-check                   all exit 0 (10/10, 11/11, 8, 14, 34, 32, 0 findings, 5/5)
```

### 4.1 Migration application, on a disposable PostgreSQL

`docker run -d --name hatoove-cc-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_PASSWORD=scratch
-e POSTGRES_DB=cc_fresh -p 127.0.0.1:55443:5432 postgres:17-alpine` (never the live app, no learner data;
container removed afterwards).

| leg | command | result |
|---|---|---|
| empty database | `node server/migrate.mjs` | `applied=41 skipped=0`, ledger `count=41, max(id)=0043-content-corrections` |
| database already at 0042 | a scratch migrations dir with 0001–0042 (40 files): `applied=40`, ledger head `0042`; then the real directory: **`applied=1 skipped=40` → `applied: 0043-content-corrections`**, ledger head `0043` | ✅ |

A `%TEMP%` verifier then compared the database to the data files, on **both** databases — 7/7 PASS each:

- the corrected `Familienmitglied` and `die Möbel` rows equal `data/noun-lexicon.json`;
- the SP1 row (title, title_en, summary, summary_en, payload) equals `data/speaking-guide.json`, compared
  **canonically** because `jsonb` normalises key order (my first run failed on key order alone — the verifier was
  wrong, not the data);
- no defect string survives in `noun_entry` or in the SP1 section;
- row counts unchanged: 240 nouns, 123 sections, 7 guides;
- `content_version.content_sha256` still holds the seed-time digests (printed by the verifier).

### 4.2 Mutation proof of the check

Copies under `%TEMP%\cc-mut`, run as `node tools/content-corrections-check.mjs --root=%TEMP%\cc-mut`; pristine
control 8/8 before and after:

| mutation | result |
|---|---|
| M1 restore the misspelling in the lexicon copy | FAIL 3 (no entry "das Familienmitglied") and FAIL 7 |
| M2 retitle SP1 `Teil 1 – Präsentation` | FAIL 4 (title mismatch) and FAIL 7 |
| M3 change 0043's Möbel example back to `Dieses Möbel passt` | FAIL 7 (0043 drifts from the data) and FAIL 8 (MANIFEST digest) |
| M4 append a comment to the frozen `0013` | FAIL 1 (`0013-guide-library.sql changed; the applied seeds are frozen`) |

### 4.3 The check's own legs

1. the three seed migrations match their pre-slice digests; 2. the frozen seeds still carry the defects;
3. the lexicon carries both corrections and no defect value survives on those entries; 4. SP1 states the
official task, with the presentation markers banned from the teaching material (they may appear only in a
negating clause, which is how the summary says "halten Sie keinen Vortrag"); 5. SP2/SP3 unchanged;
6. 0043 is exactly three UPDATEs and nothing else, LF-only; 7. every value 0043 writes equals the data file;
8. 0043 matches its MANIFEST line and `0042` still matches its own.

Two false positives in the first draft were fixed rather than accepted: leg 3 originally banned
"piece of furniture" file-wide (it is a correct gloss for other nouns) and leg 4 originally banned
"Vortrag"/"Stichwörter" anywhere (the corrected watch-out says there is *no* presentation). Both are now scoped
— to the corrected entries and to non-negated clauses — and the mutation legs confirm the scoped rules still bite.

## 5. Consequences recorded, not fixed (cross-slice, for the Lead)

### 5.1 F2's bundle loses its binding on exactly these paths

The F2 importer (`server/library-translations.mjs`) binds each bundle string to the source's own English field
and each noun's `de`/`example_de`/`en`/`example_en` to the seeded columns. Correcting the source therefore
means a re-import would now be refused for the corrected rows. The complete list, so the follow-up is a list
and not a search:

- **`guide_section` SP1 — 33 of the speaking guide's 99 bundle paths** lose their binding:
  `title` 1, `summary` 1, `payload.approach[].step` 6, `payload.approach[].detail` 6,
  `payload.phrases[].group` 6, `payload.phrases[].hint` 6, `payload.watchOut[]` 5,
  `payload.examples[].topic` 2. **15 of those 33 reference fields the correction removed entirely**
  (`approach[3..5]`, `phrases[3..5]`, `examples[1]`, `watchOut[3..5]`) — for those the source field no longer
  exists at all.
- **`noun_translation` — 2 rows**: `telc-deutsch-b1.noun.das-familiemitglied` (`de`, `example_de` changed;
  `en`/`example_en` unchanged) and `telc-deutsch-b1.noun.die-moebel` (`de` unchanged, but `en` and `example_de`
  changed).

**Not touched in this lease, per the Lead's call:** no bundle byte changed, no translation row changed, no
content version bumped, no row rejected. The exact meaning of the current state:

- the stored uk/ar/tr rows keep being served by the F2 read path (nothing filters them out), and they still
  render with the machine-translated marker — the whole bundle is `machine_unreviewed` and my read path
  exposes per-string status in `stringStatus`, so nothing presents them as final;
- **the honest gap**: on SP1 the learner now sees the corrected German title/summary beside translations of the
  *old* presentation text (for example a Ukrainian "Частина 1 – Презентація" heading under "Teil 1 – Sich
  kennenlernen"), and the same is true of the two noun rows' meanings/examples. That mismatch is visible until
  the bundle is re-pinned, and the marker is what makes it defensible rather than silent. If the Lead wants it
  closed rather than marked, the options are (a) the planned re-pin/re-translation, or (b) mark those specific
  translation rows `rejected` so the read path omits them — which *is* changing translation rows, so it needs
  your instruction; I did not do it.

### 5.2 The stored content digests now describe the pre-correction source (unfixable in place)

| content_version | stored `content_sha256` (= the seed-time source digest) | the file's digest now |
|---|---|---|
| `telc-deutsch-b1.nouns@v1` | `df30f4a45694971a3da871a4def3eae7d229e682d9f350c1a7f80e4db51534aa` | `6709ecd846b5eeefaa41e854058592f740a4f0db4ab7de9b7bf884ae6017bbae` |
| `telc-deutsch-b1.speaking-guide@v1` | `941ce2745c628277ed2ed216f12542d482c12ad70c72a4e910f81ca7b2c0d767` | `2d0d71dc012c7568ed73327544a4d84b778027bae69ead7ec236dbb960520c75` |

The column cannot be corrected: `content_version` carries a `BEFORE UPDATE OR DELETE` trigger (0006) that
always raises "content records are immutable … create a new version instead". Bumping the version was
explicitly ruled out (it would make every translation for those corpora stale at once). So the stored digest
is now a record of the artifact as seeded, not of the current file — recorded here and in the migration header.

### 5.3 The generator's own advice is now a hazard

`node tools/build-noun-migration.mjs --check` fails:

```
library-seed: FAILED the generated migration differs from its source
  the committed server\migrations\0012-noun-lexicon-catalogue.sql is not what the generator would produce now
  fix the source, or re-run the generator without --check to regenerate
```

That is expected after a source correction, but the tool's suggested remedy — re-running it without `--check`
— would **rewrite the frozen `0012`**, which is exactly what the applied-checksum rule forbids. Nothing in
`tools/` or `package.json` invokes these builders, so no gate is red; a human following the tool's own message
would corrupt an applied seed. Recommendation (not done here, it is the Lead's architecture call): give the
builders a guard that refuses to overwrite a seed whose corrections exist, or record the 0012/0014 builders as
superseded by `0043` and this check.

## 6. The informal-address observation (recorded, deliberately not changed)

Authored guide prose in `data/*.json` addresses the learner informally in places. It is content, not interface
copy, so `i18n-register-check` does not scan it and the formal-address rule for interface copy does not settle
it. Measured with the curated du-form list (upper bound: no verb-form analysis):

| file | strings containing du-forms | of those, also containing a formal Sie-form (register teaching/quotation) |
|---|---|---|
| `data/grammar-guide.json` | 36 | 2 |
| `data/speaking-guide.json` | 28 | 0 |
| `data/core-phrases.json` | 19 | 0 |
| `data/writing-guide.json` | 19 | 14 |
| `data/seed.json` | 17 | 3 |
| `data/cases-guide.json` | 17 | 0 |
| `data/core-grammar.json` | 6 | 2 |
| `data/vocab.json` | 4 | 0 |
| `data/gender-rules.json` | 3 | 0 |
| **total** | **149** | **21** |

The 21 "also formal" strings are plausibly deliberate du/Sie register teaching or quotations (the writing
guide's "Sie oder du?" material), so the number that actually reads as the guide addressing the reader
informally is somewhere between 128 and 149 and needs a human pass. **No such string was changed in this
slice**, per the task. The new SP1 prose I authored uses the formal address, so this slice adds none.

## 7. Not verified / residual risk

1. **Native review is owed** for the new SP1 German/English and for the corrected noun rows (contract §8).
   Nothing here is approved content; the guide is reference-only and not a live surface.
2. **Durations** (`minutes`, `approach[].seconds`) are `null` because the repository verifies none; if a
   verified source gives the official Teil 1 timing, they should be filled in.
3. **SP2/SP3 remain unverified** and structurally untouched (§2) — queued with the native review.
4. **The 15-second `seconds` schema field is now unused** for SP1; no renderer reads it, so `null` is inert
   today, but a future renderer that formats it must handle `null`.
5. **The F2 mismatch described in §5.1** is live until the re-pin; it is bounded to SP1 and two noun rows and
   carries the machine-translated marker.
6. **The `0043` UPDATEs are idempotent in effect** (setting the same values twice) but the migration runs once;
   the check does not prove re-application because the ledger prevents it.
7. I did not run `tools/build-noun-migration.mjs` without `--check` (it would rewrite `0012`), so §5.3's
   "would rewrite the frozen seed" is read from the tool's own message, not executed.
8. **`data/seed.json` is in the informal-address table** but is not one of the guide files this slice owns; it
   is listed only to make the observation complete.

## 8. Next action

Independent review of this branch (not the author), then integration by the Lead, together with a decision on
§5.3 (builder guard) and the F2 re-pin follow-up listed in §5.1.
