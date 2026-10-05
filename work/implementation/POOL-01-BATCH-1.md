# POOL-01 batch 1 — six authored sets on HV1–HV3 and LV1 (task-37, released by task-43)

**Task:** task-37 (POOL-01 batch 1, contract A11(a), option B of `work/implementation/POOL-01-PROPOSAL.md`),
released by **task-43** (POOL-01-RELEASE). **Branch:** `codex/pool-01-release`, from local main `0ba79f4`
(which carries the media mount fix and FIX-F1). Nothing pushed, nothing merged, no other worktree touched.

> ## ✅ THE APPLY HOLD IS LIFTED (task-43), AND ONE KEY AWAITS RON
>
> Ron has read the three LV1 sets and the batch **may be applied**: `apply_hold` in
> `content/pool-01/batch-1.json` is `null`, the migration carries **no** hold marker, and the field stays in
> the source so `pool-01-check` proves source and artifact agree in **either** state — a regeneration can
> neither drop the hold silently nor keep it silently. `apply_hold_history` records the lift.
>
> **One content decision is still pending, and it is Ron's:** headline **e** must not answer `lv1.06` text 4.
> The authored key is therefore **unchanged**, the migration carries a `CONTENT DECISION PENDING` marker, and
> the check asserts both — so an agent cannot "fix" it silently, and the fix cannot be dropped silently. The
> proposal (with the text and the ten headlines side by side, every rejected candidate reasoned, and a second
> pass over the other four keys) is **§2** and was sent to the Lead. **Do not apply this migration before Ron
> confirms** — the marker in the artifact says so in the file itself.

---

## 2. THE `lv1.06` KEY CORRECTION — PROPOSAL FOR RON (task-43)

**Ron's words:** *"no I think that should not be a match."* He named no replacement, so this is a proposal, not
a swap. **Nothing has been changed.**

### 2.1 The disputed pair, side by side

| | German |
|---|---|
| **Text 4 (key disputed)** | „Wir ziehen Ende des Monats in eine andere Wohnung. Wer hat einen **Transporter** und kann uns am **Umzugstag für ein paar Stunden helfen**? Die Bezahlung sprechen wir vorher ab." |
| **Current key — headline e** | „**Umzugshilfe mit Transporter zu vermieten**" |

The text asks for **two things**: a van, and a few hours of help on the day. Headline e names the right
subject (moving help + van) but offers the van **for hire** („zu vermieten") — a rental, where the text is a
household asking someone to help them move and offering to agree on payment. Ron has ruled that this is not
the match.

### 2.2 The ten headlines, and why nine of them cannot answer text 4

| # | Headline | Verdict for text 4 |
|---|---|---|
| a | Nachhilfe in Mathematik für die Klassen 7 bis 10 | ✗ School maths tutoring. The text has no pupil, no school, no subject. |
| b | Tagesmutter hat ab September wieder Plätze frei | ✗ Childminding places. No children in the text. |
| c | Seniorenbegleitung für Spaziergänge und Gespräche | ✗ Companionship for an elderly person. Nobody elderly, and no walks. |
| d | Hundebetreuung am Wochenende | ✗ Dog care. No animal, and the move is „Ende des Monats", not a weekend. |
| **e** | Umzugshilfe mit Transporter **zu vermieten** | ✗ **Ron's ruling.** Right subject, but it offers a van for hire; it does not answer a request for help. |
| f | Putzhilfe für Büros am Abend gesucht | ✗ Evening office cleaning. Wrong place (Büros) and wrong time (Abend). |
| g | Erfahrene Babysitterin für zwei Kleinkinder | ✗ Babysitting. No children. |
| h | Gitarrenunterricht für Anfänger | ✗ Guitar lessons. Unrelated. |
| i | Sprachkurs Deutsch für den Beruf | ✗ Language course. Unrelated. |
| **j** | **Möbelmontage und kleine Reparaturen** | **~ The only candidate left.** Furniture assembly and small repairs is what a household actually needs on and after a moving day, and „kleine Reparaturen" covers the odd jobs a move creates. It does **not** supply the van. |

### 2.3 Recommendation

**Nothing should be swapped on its own, because every candidate is imperfect.** The honest options, best
first:

1. **Key = j, and tighten text 4 by one line** so the need and the offer match exactly — e.g. „Wir ziehen Ende
   des Monats um. Wer kann uns am Umzugstag helfen, die Schränke aufzubauen und ein paar Möbel zu reparieren?
   Die Bezahlung sprechen wir vorher ab." Then j is exact, the van disappears from the text, and e becomes a
   distractor (a rental van for someone who has not asked for one).
2. **Keep text 4 and reword headline e into an offer of moving help** — e.g. „Umzugshilfe: zwei Helfer mit
   Transporter für einen Tag". Then text 4 ↔ e is a clean match, no letter moves, and the van the text asks
   for is exactly what the ad provides. This is the smallest change (one line, no key move).
3. **Key = j with text 4 unchanged** (the literal answer to "which of the ten fits"). It matches the *help*
   half and answers the "what can I do here" question, but the text explicitly asks „Wer hat einen
   Transporter?" and j does not mention one, so a learner reasoning from the van would be trapped. Acceptable
   only if Ron prefers it to options 1–2.

**What I did NOT do:** change anything. The authored key stays **e** until Ron confirms, and the check asserts
that it does (§4).

### 2.4 The shape trap, checked mechanically rather than by eye

LV1 is text → headline matching with distractors: **exactly one headline per text**, five of the ten used,
**no headline may answer two texts**. A swap that duplicates another text's answer would be worse than the
defect it fixes, so `tools/pool-01-check.mjs` simulates it:

* headline **e** is the key of **text 4 only**; headline **j** is used by **no** text (it is a distractor
  today) — so a swap to j displaces nothing and creates no duplicate;
* after the simulated swap the set still has **five distinct** answers for five texts;
* the proposal must be a headline **of this set**, must **differ** from the current key, and must **not**
  already answer another text — each asserted, and mutation **M5** (proposal pointed at a headline another
  text already answers) makes the leg fail.

### 2.5 Second pass over the other four keys (asked for, and it found something)

| Text | Key | Verdict |
|---|---|---|
| 1 — son in year 9, big trouble with maths, twice a week, class tests | a — Nachhilfe in Mathematik für die Klassen 7 bis 10 | **Solid.** Grade 9 ∈ 7–10, maths, tutoring, recurring. |
| 2 — mother, 82, walks, no longer dares go out alone, twice a week | c — Seniorenbegleitung für Spaziergänge und Gespräche | **Solid.** Age, walks and company all named. |
| 3 — weekend wedding, Labrador, walks and feeding | d — Hundebetreuung am Wochenende | **Solid.** Weekend, dog, care. |
| 5 — two children aged 2 and 4, someone with experience of small children, Mon & Thu 7–16 | g — Erfahrene Babysitterin für zwei Kleinkinder | **DOUBTFUL — a genuine near-tie with b.** |

**Text 5 needs a second decision.** Headline **b** („Tagesmutter hat ab September wieder **Plätze frei**") is
a real competitor: a Tagesmutter cares for small children in the daytime, which fits „montags und donnerstags
von sieben bis sechzehn Uhr", and a family looking for care is exactly who answers such an ad. **g** wins on
specificity — it names **two** small children (the text has two, aged 2 and 4) and **experience** (the text
demands „schon Erfahrung mit Kleinkindern") — while **b** loses on „ab September", a date the text never
mentions. That is a narrow margin, and narrow margins are how a wrong key ships. Recommended tightening, one
line only: either make **b** exclude the text's case („Tagesmutter sucht neue Kinder **ab drei Jahren**", which
the 2-year-old fails) or make the text's setting explicit (care in the family's home, which a Tagesmutter does
not provide). **I have changed neither**; this is recorded so the decision is Ron's, not mine.

---

## 1. THE ARITHMETIC, CONFIRMED BEFORE AUTHORING (lease rule 4)

Measured, not assumed: the pool before batch 1 is **25 released sets** — LV1 3, LV2 3, LV3 3, **SB1 4** (three
exam sets plus the disclosed `0022` grammar drill, amendment A9), SB2 3, HV1 3, HV2 3, HV3 3.

The proposal's option B names **six new sets across HV1–HV3 and LV1** for batch 1; "six per part" is option
C's FULL-batch target (24 new sets). **There is no disagreement between the two figures** — B1 is six sets, and
the four named parts end between 4 and 6. The proposal does not fix the distribution among the four parts;
the Lead approved this one on 5 October 2026:

| Part | Before | Batch 1 | After (released) | After (once the held three are released) |
|---|---|---|---|---|
| **LV1** | 3 | **+3** | **6** | 6 |
| HV1 | 3 | +1 (held) | 3 | 4 |
| HV2 | 3 | +1 (held) | 3 | 4 |
| HV3 | 3 | +1 (held) | 3 | 4 |
| other parts | 3 / SB1 4 | — | unchanged | unchanged |
| **Total** | **25** | **6 authored** | **28** | **31** |

**Why three of the six are not released yet, and why this split.** Ron's A11(b) and the lease's rule 2 fix the
listening media bind-mount **before any new audio**, and a listening set whose audio cannot play must not enter
the pool — the runner would assert "Die Aufnahmen sind vorhanden" over recordings that do not exist, and the
drill refuses media sets outright. Only LV1 is non-media, so the split that maximises what can be honestly
released today is the one approved: LV1 reaches the contract's six, and each listening part receives one
ready-to-record script so the follow-up release is a flag flip, not a re-authoring exercise.

**Delivered against the lease's own words:** the lease asks for "six new released sets". Six sets are authored,
three are released now, three are held and disclosed — the contract A11(a) wording is the Lead's to qualify
(they said they are doing it).

## 2. WHAT WAS AUTHORED, AND BY WHOM

**Authoring, not generation at runtime.** Every passage, script, item, key and explanation was written for
this batch in the exam's own register and shape. No published telc material was copied or paraphrased: the
SHAPE (item counts, task types, permitted plays, headline reuse rule, item numbering) follows
`docs/exam/TELC-B1-SOURCES.md` §3.1 and §3.3, which records the blueprint; the German is original. Provenance
is recorded in the batch source header and in each imported row's `source_path`
(`content/pool-01/batch-1.json#<family>[i]`). Every set is **`unreviewed`** — no agent marks content reviewed
or makes an exam-validity claim. (Ron amended D10 on 5 October 2026: offline AI-generated content assets are
permitted with recorded provenance and human review still required. This batch records its provenance either
way.)

| Set id | Family | Release | Shape | Title |
|---|---|---|---|---|
| `telc-deutsch-b1.lv1.04` | LV1 | released | 5 texts → 10 headlines a–j, each used once | Second-Hand, Tausch und Reparatur |
| `telc-deutsch-b1.lv1.05` | LV1 | released | idem | Vereine, Feste und Engagement |
| `telc-deutsch-b1.lv1.06` | LV1 | released | idem | Betreuung, Nachhilfe und Alltagshilfe |
| `telc-deutsch-b1.hv1.04` | HV1 | **held** | 5 richtig/falsch, played once, scripts for five short messages | Nachrichten von Kolleginnen und Kollegen |
| `telc-deutsch-b1.hv2.04` | HV2 | **held** | 10 richtig/falsch, played twice, one interview script | Interview mit der Fahrradbeauftragten der Stadt |
| `telc-deutsch-b1.hv3.04` | HV3 | **held** | 5 richtig/falsch, played twice each, five announcements | Durchsagen in Bibliothek, Schwimmbad und Kaufhaus |

The held sets are complete except for the recording: scripts are authored, items numbered per the blueprint
(HV1 41–45, HV2 46–55, HV3 56–60), keys are boolean and every `why` explains the statement. Flipping
`"release": "held"` to `"released"` and re-running the generator is the whole release step once task-36 lands.

## 3. HOW THE BATCH IS IMPORTED

The lease's path is `data/seed.json` → `tools/build-objective-migration.mjs` → a new forward migration.
`data/seed.json` **could not be used**: the builder regenerates the WHOLE of migration `0010` from it, and
`0010` is applied in every installation — appending there would rewrite an applied migration or leave it
silently stale. The Lead approved the additive alternative: the builder gained a **batch mode**

```
node tools/build-objective-migration.mjs --batch content/pool-01/batch-1.json \
     --out server/migrations/0047-pool-01-batch-1.sql          # write
node tools/build-objective-migration.mjs --batch content/pool-01/batch-1.json \
     --out server/migrations/0047-pool-01-batch-1.sql --check  # verify
```

which applies the SAME `splitSet` rules as the corpus (learner payload without `answer`/`why`/`script`; the
answers, explanations and transcript to `objective_key`; `media_required` for the listening families;
`unreviewed` content versions with a per-set sha256; the row's rights decision travelling with it). Default
behaviour and `--check` for `0010` are untouched: **`0010` is byte-identical before and after this branch**
(`--check` for `0010` green with 24 sets/24 keys; the sha256 recorded in its header still equals
`data/seed.json`).

`0047` is the **next free number** (confirmed against `server/migrations/` and the last MANIFEST line: `0046`
was the highest), it is **forward-only** (four `INSERT`s, three `ON CONFLICT DO NOTHING` idempotent upserts,
no DDL), and applying it to a database that already carries `0010` is the same operation as applying it to an
empty one.

### 3.1 THE DEFECT THE DATABASE LEGS FOUND: A CONTENT ROW NEEDS A RIGHTS DECISION

The first generated migration was **incomplete in a way no row count could see**: it inserted
`content_version` rows with `rights_status = 'unknown'` and no `content_rights` decision. The serving policy
allows only `generated`/`licensed`/`commissioned` and **unknown provenance can never be opted in** (0020;
"FAILS CLOSED"), so all three new sets existed in the catalogue and would **never have been served**. The
`P5`/`P6` legs caught it (`setCount: 3` where six candidates existed). `0020` records one decision per content
version and `tools/content-rights-check.mjs` leg 1 asserts that every content row carries one; the batch now
records the decision with the row:

```
INSERT INTO "__SCHEMA__".content_rights (content_version_id, basis, decided_by, note)
VALUES ('telc-deutsch-b1.lv1.04@v1', 'generated',
        'Ron (product owner); standing D1 basis applied by POOL-01 task-37',
        'Original content authored for Hatoove (no third-party item bank, no published material reproduced);
         POOL-01 batch 1, task-37, 5 October 2026. Source: content/pool-01/batch-1.json#LV1[0].')
```

The basis is the product owner's standing D1 decision for Hatoove's own content, and the note says which
content it covers and how it was applied — a provenance record, not a review or a validity claim. If the Lead
prefers different attribution, the note strings are two constants in the builder.

## 4. EVIDENCE

Disposable PostgreSQL only: `docker run -d --name pool-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e
POSTGRES_DB=pool_pg -p 127.0.0.1:55497:5432 postgres:17-alpine`. Removed afterwards; no live app or learner
data touched.

| Command | Result |
|---|---|
| `node tools/pool-01-check.mjs --postgres` | **14 legs, 0 failed** (7 offline + 7 database) plus the 4 mutations below |
| `node tools/pool-01-check.mjs` (mutation proof) | **4/4 mutations fail exactly their intended leg** (see below) |
| `node tools/build-objective-migration.mjs --check` | 0010 still matches `data/seed.json` — **24 sets, 24 keys** |
| `node tools/practice-runner-check.mjs --mutations` | **37 passed, 0 failed**, 4/4 mutations fired (corpus now 28 sets from 3 migrations) |
| `node tools/practice-selection-check.mjs --postgres` | **44 legs, 0 failed** (no change needed to that file — its counts come from the served pool) |
| `node tools/practice-media-check.mjs --postgres` | **19 legs, 0 failed** |
| `node tools/drill-check.mjs --postgres` | **43 legs, 0 failed** |
| `node tools/migrate-check.mjs` | **6 passed, 0 failed** |
| `node tools/table-class-check.mjs` | **90 table rows; 0 failures; 0 findings** |
| `node tools/part-index-check.mjs` | **11 passed, 0 failed** (tile item counts unchanged — the batch adds sets, not a blueprint) |
| `node tools/owned-api-check.mjs` / `--backend=postgres` | **35/0** and **35/0** |
| `node tools/run-gates.mjs mirror` | **9/9** |
| `node tools/run-gates.mjs baseline` | **9/9** |
| `node tools/run-gates.mjs mirror-db` | **5/5** (including `drill-check --postgres`) |

### 4.1 What the database legs prove (the lease's acceptance list)

* **P1** a clean database applies **`0047` LAST** and the ledger's checksum for it is the sha256 of the frozen
  file.
* **P2** the released pool is **28** sets: LV1 6, every other part exactly as before — and the three held
  listening sets are **absent** (`objective_set` has no `hv%.04` row at all).
* **P3** every imported set is `unreviewed`, carries its `content/pool-01/batch-1.json#LV1[i]` provenance and,
  through the same join, a recorded `generated` rights basis with an auditable note; each has five keyed
  answers. The leg also asserts the global invariant that **no content row lacks a basis**.
* **P4** the shipped serving path (`practiceSetForPart` → `/api/v1/practice/next?family=LV1`) serves a set
  whose DTO is well formed: **every served item id IS a key id**, every key is offered by its own item's
  options **with the key's own JSON type**, and the wire JSON carries no `answers`/`explanations`/
  `transcript`/`why`/`script`/`answer` field.
* **P5** the selection rule **reaches the new sets**: once every LV1 candidate is seen, the new
  `lv1.06` with three wrong answers is served (`reason: 'most-wrong'`, `evidence.wrong: 3`); with no evidence
  the total order still starts at `lv1.01`.
* **P6** the wrap fires at the **new** per-part count: five checked LV1 sets is not the wrap (round 6 begins),
  the sixth makes `round.wrapped: true` with `notice: 'practiceAllSets'` and `round: 6`, and `setCount` is the
  real 6 — never a hard-coded three.
* **P7** the held sets are not served and the HV parts keep exactly their seeded three sets.
* Offline **leg 2** normalises all six authored sets — released AND held — through the **real**
  `normalisePracticeSet`, which is how the three un-imported scripts prove their shape now.
* Offline **leg 3** asserts the exported artifact carries no secret material and no DDL, **leg 5** asserts
  the committed migration is byte-identical to what the builder regenerates, and the same leg now asserts the
  **hold state** (lifted: no marker; a future hold: marker and reason present) and the **disputed-key state**
  (pending: the authored key unchanged and the artifact marked; confirmed: the key IS Ron's value and the
  marker is gone).

### 4.2 Mutation proof (6 mutations, all biting)

| Mutation | Legs that fail |
|---|---|
| **M1** a held listening set is marked `released` | 2 (the arithmetic and the held-absence legs) |
| **M2** an LV1 answer is not one of the set's headlines (`z`) | 2 (the shape leg) |
| **M3** a released set is renamed so the source and the migration disagree | 1 (the import leg) |
| **M5** the proposed replacement is pointed at a headline ANOTHER text already answers | 1 (the shape trap) |
| **M6** the disputed key is changed while the decision is still pending | 1 (the pending pin) |
| **M4** the builder stops stripping the answer fields (`SECRET_FIELDS` emptied) | 2 (the corpus/builder leg) |

**M5 and M6 exist for the two ways this correction could go wrong:** a swap that duplicates another text's
answer (worse than the defect it fixes), and an agent quietly "fixing" a key the product owner has not yet
confirmed.

The pristine copies pass every leg first (part of the gate). Source mutations are applied to throwaway copies;
M4 is applied to a copy of the **builder**, which is the rule the split shares with the corpus.

## 5. POOL-FIGURE FILES: WHAT I CHANGED, AND WHAT I DID NOT

Changed (facts about the pool):

* `work/implementation/POOL-01-INVENTORY.md` — the pre-batch tables are marked historical and a
  "POOL-01 batch 1 — the current figures" section carries before/after per part, the held three and the
  release condition.
* `tools/practice-runner-check.mjs` — legs 12/12b/12c/12d no longer hard-code 25 sets or the migration list:
  the corpus is **discovered** from every migration that publishes `objective_set` (`0010`, `0022`, `0047`),
  the figures are declared once in `POOL_FIGURES` and asserted against, the three new LV1 sets are asserted to
  be released and the three held ones asserted absent, and the leg titles derive their counts. This closes the
  exact staleness the old list had: it was blind to the next content migration (the first sample is this one).
* `server/migrations/MANIFEST.json` — **one line**, `0047-pool-01-batch-1`, whose value is the sha256 of the
  migration's bytes.

NOT changed, deliberately:

* `tools/practice-selection-check.mjs` — its corpus and wrap legs read counts from the served pool, and it is
  **44/0** with the batch in place. No edit was needed.
* `tools/docker-stack-check.mjs:585` — a comment, not a gate (the Lead's instruction).
* `docs/contracts/MIRROR-B1PREP-01.md` — the contract is the Lead's; the pool figures in §3/A9/A11 are theirs
  to amend (they said they are qualifying A11(a) themselves).
* `data/seed.json`, `server/migrations/0010-objective-catalogue.sql` — untouched, proven byte-identical.

## 6. NOT DONE / OWED

1. **The three listening recordings** — depend on `task-36`'s bind-mount fix. Until then the sets stay held;
   the release is a marker flip plus a new forward migration from the same command.
2. **Qualified human review of the six sets** (German, key, task fidelity). Nothing here is marked reviewed;
   `pool-01-check` asserts that every imported row is `unreviewed`.
3. **A production recount** of `objective_set` (the inventory's own open item) — not possible from here.
4. **The contract's pool figures** — the Lead's edit.
5. `tools/pool-01-check.mjs` is **not registered** in `tools/run-gates.mjs`; the two lines owed are
   `gate('pool-01-check')` in `mirror` and `gate('pool-01-check', '--postgres')` in `mirror-db`.
   (`practice-server` has task-44 for the CI wiring, which is where this belongs now.)
6. **Ron's confirmation of the `lv1.06` key** (§2). The moment he confirms: set `confirmed_answer` in
   `key_fix_pending`, apply the confirmed key to the source's `texts[4].answer`, regenerate 0047, update the
   MANIFEST sha256 — and `pool-01-check` flips from "unchanged pending a human" to "the key IS the confirmed
   value", with the pending marker gone. **Until then the migration must not be applied**, and it says so in
   its own header.
7. **Ron's second decision on `lv1.06` text 5 (§2.5)** — the near-tie between `g` and `b`. Neither the text nor
   `b` has been touched; the tightening suggested there is one line either way.
8. **A release done by `UPDATE` is now visible to the corpus legs**: `practice-runner-check` discovers any
   migration that inserts **or updates** `objective_set`, and leg 12 fails unless a file that yields no parsed
   set is declared in `RELEASE_ONLY_MIGRATIONS` with its reason (it is empty today). So the follow-up release of
   the three held listening sets cannot slip past the coverage by flipping a flag instead of inserting rows —
   whoever writes it must either publish rows the parser sees or declare the change and say why.

## 7. RESIDUAL RISK

* **Five sets of the six are unreleased until the mount fix**, so the immediate pool effect is three LV1 sets.
  The held content is validated (shape, keys, DTO) but has never been heard/recorded; its release needs the
  audio, not another review of the text.
* **Authored content is `unreviewed`.** The keys are deterministic and the shape is checked, but no human has
  verified the German or the task fidelity: that review is owed before the sets are treated as exam material.
* **The rights attribution** in `0047` applies the product owner's standing D1 basis to this batch and says so
  in the note. If that attribution is wrong, it is two constants in the builder plus a regenerated migration.
* **`POOL_FIGURES` in the runner check is a deliberate hard figure** — the check now fails loudly when the pool
  changes, which is the point, but it and `POOL-01-INVENTORY.md` must move together with any future batch.
