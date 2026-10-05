# EOL-HASH-AUDIT-01 — every file a check hashes must be platform-stable

**Task:** task-55. **Branch:** `codex/eol-hash-audit-01`, worktree `.worktrees/eol-hash`, base
`58fc876` (local main when the branch was cut; the lease named `90fbabe`, and main had moved by two
commits). **Files:** `.gitattributes`, `tools/eol-hash-check.mjs` (new), `tools/run-gates.mjs`,
this note. No migration, no product code, no recorded digest was changed.

## 1. The table: what is hashed, and whether it is platform-dependent

`git ls-files --eol` on this tree: **774 tracked files; 560 with `i/lf w/crlf attr/` and a further 8
with `i/lf w/crlf attr/text`** — 568 files whose working-tree bytes depend on the platform. (The
lease quoted 573; the two pins added in `d76f7f6` and the two commits since account for the
difference. The class is the same and the count is the same order.)

Hashing sites found by scanning `tools/**/*.mjs` and `server/**/*.mjs` for `createHash(`: **46 sites
in 40 files — 3 hash file bytes, 20 hash a caller-supplied buffer or path, 23 hash a value, 0
unclassified.** Only the file-byte sites can be platform-dependent, and only those whose result is
*recorded* can break a gate. That intersection is the finding:

| recorded in | source path | byte forms | `--eol` before | verdict before |
|---|---|---|---|---|
| `0010` `-- Source:` header | `data/seed.json` | CRLF `ef26279d…` / LF `40a0a066…` | `i/lf w/crlf attr/[text eol=lf]` | pinned (earlier fix) |
| `0011` header **and** `content_sha256` | `data/vocab.json` | CRLF `5c9563f1…` / LF `e6ec6d20…` (0011 records the **CRLF** one) | `i/lf w/crlf attr/[]` | **UNPINNED — fragile** |
| `0012` header **and** `content_sha256` | `data/noun-lexicon.json` | CRLF `6709ecd8…` / LF `4702bcda…` (0012 records `df30f4a4…`, see §6) | `attr/[]` | **UNPINNED — fragile** |
| `0013` `content_sha256` × 5 | `data/grammar-guide.json`, `data/core-grammar.json`, `data/core-phrases.json`, `data/gender-rules.json`, `data/cases-guide.json` | 0013 records the **CRLF** digest of each | `attr/[]` | **UNPINNED — fragile** |
| `0014` `content_sha256` × 2 | `data/writing-guide.json` (CRLF digest), `data/speaking-guide.json` (`df…`-style stale, §6) | as above | `attr/[]` | **UNPINNED — fragile** |
| `0047` `-- Source:` header | `content/pool-01/batch-1.json` | CRLF `45e361a1…` / LF `f39498a1…` | `attr/[text eol=lf]` | pinned (earlier fix) |
| `DESIGN-REFERENCE-MANIFEST.json` → 22 files | `public/assets/design/**`, `work/design-reference/**` | byte-exact artifacts | `attr/[-text]` | pinned |
| `content/library-translations/README.md` | `hatoove-library-translations-uk-ar-tr.json` | byte-exact artifact | `attr/[-text]` | pinned |
| `FROZEN_SEEDS` in `content-corrections-check.mjs` | `0012`/`0013`/`0014` `.sql` | committed blobs | `attr/[text eol=lf]` | pinned |

**27 recorded paths in total; 8 of them were unpinned, and all 8 are `data/*.json` sources whose
byte digest a generator wrote into a migration.** Everything else that is hashed is benign, and the
reasons are worth recording because they are the reasons not to panic about the other 560:

| hashing site | input | why it is not the hazard |
|---|---|---|
| `server/explanation-language-registry.mjs:18` | `data/seed.json` | **already canonicalises CRLF→LF before hashing** (`:17`) and compares to the LF digest — the pattern the rest of the repo should copy |
| `server/owned-postgres/provision.mjs:130` | `server/migrations/*.sql` | pinned `text eol=lf`, and `migrationChecksumMatches` (`:139`) tolerates the uniform LF/CRLF variant on purpose |
| `tools/migrate-check.mjs:73` | the same migrations | hashed, and compared to the ledger **with no tolerance** — see §5, residual |
| `tools/review-pack-check.mjs:52`, `tools/account-erasure-perf-check.mjs:263` | `.mjs`/`.md`/`.sql` sources | hashed for a within-run fingerprint and for an evidence report; never compared to a value recorded on another platform |
| `tools/practice-runner-check.mjs:1196` | a temp copy of `public/app/part-runner.js` | before/after comparison inside one run |
| `tools/build-objective-migration.mjs`, `tools/build-vocab-migration.mjs` | `data/seed.json`, `data/vocab.json` | the generators; now pinned (§2) |
| `server/media-contract.mjs:109`, `tools/exam-s5-*.mjs` | WAV media bytes | untracked deployment artifacts, and `*.wav binary` |
| the other 23 value sites | `JSON.stringify`/`canonicalJson` of parsed data, DB rows, tokens | platform-independent by construction |

## 2. The fix — the intersection only

One rule in `.gitattributes`, in the "files a check hashes" block:

```text
data/seed.json          text eol=lf
data/*.json             text eol=lf
content/pool-01/*.json  text eol=lf
```

`data/seed.json` keeps its own line (it was pinned first); `data/*.json` covers it and the other
eight. Nothing else was pinnned — not the 560.

**Ordering, proved rather than asserted.** The last matching pattern wins, so a general rule appended
after a deliberate pin would silently override it. These patterns are disjoint from the `-text` and
`binary` pins, and `git check-attr text eol -- <path>` is the evidence:

```text
data/seed.json                    text: set    eol: lf          <- the rule covers it
data/vocab.json                   text: set    eol: lf          <- was unspecified
data/noun-lexicon.json            text: set    eol: lf          <- was unspecified
data/speaking-guide.json          text: set    eol: lf          <- was unspecified
content/pool-01/batch-1.json      text: set    eol: lf
content/library-translations/hatoove-library-translations-uk-ar-tr.json   text: unset   <- pin INTACT
public/assets/design/hatoove.css  text: unset               <- pin INTACT
work/design-reference/index.html  text: unset               <- pin INTACT
```

The comment in `.gitattributes` now says, where it matters: a future repo-wide `*.json` rule MUST go
**before** the `content/library-translations/*.json -text` pin or it will silently unpin the
translation bundle, whose sha256 is recorded in its README and re-checked by the importer and by
`library-i18n-check`.

## 3. Renormalisation — no index bytes moved at all

`git add --renormalize data/` produced **no change**: every `data/*.json` blob is already LF in the
index (`i/lf`), so the pin changes what a *future checkout* materialises, not the stored bytes.

```text
git status --short   ->   M .gitattributes        (and nothing else)
```

So there is no renormalisation churn to review, no line-ending-only diff to confirm, and none of the
collateral the Lead's blanket `--renormalize` caused (the two licence `.txt` files were never in my
path list). A Windows working tree keeps its existing CRLF copies until re-checked out; that is
reported by the new check as a NOTE and is not a failure, because it is a local checkout state and
not committed bytes.

## 4. The check that stops the class returning

`tools/eol-hash-check.mjs`, registered in the **`mirror`** group — it is offline, and it is exactly
the class CI must catch on both operating systems.

- **Leg 1, inventory.** Every `createHash(` site is classified (file bytes / caller-supplied / value).
  An **unclassified** site FAILS by name, so a new direct file hash cannot be added without someone
  deciding what it implies. A `file` classification is self-checked: it must name a real tracked path,
  or it degrades to `parameter` rather than claiming a path it cannot substantiate.
- **Leg 2, recorded paths are pinned.** The path set is **derived, never listed**: `-- Source:` headers
  and `source_path`+`content_sha256` pairs in `server/migrations/*.sql`, path→64-hex pin maps written
  in `tools/`+`server/`, the design manifest's `{path, sha256}` entries, and the translation bundle's
  README pin. Each path must resolve through `git check-attr` to a stable form (`-text`/`binary`, or
  `text` with an explicit `eol`). Failures name the path **and the migration that records its digest**.
- **Leg 3, mutation.** The matcher carried for evaluating a modified rules text is cross-validated
  against `git check-attr` for every recorded path on every run (a disagreement fails), and the run
  prints a `MUTATION` line proving that removing one pin makes that path unstable.

Results on this tree: **27 recorded paths pinned, 46 hashing sites, 0 unclassified, 0 failed.** The
mutation proof, run end to end with the `data/*.json` rule deleted from a copy of the rules file:

```text
$ node tools/eol-hash-check.mjs --attributes <copy-without-the-data-pin>
FAIL 2 recorded path: data/vocab.json (recorded by 0011-vocab-catalogue.sql header,
      0011-vocab-catalogue.sql content_sha256) is not pinned: text=unspecified eol=unspecified …
FAIL 2 recorded path: data/noun-lexicon.json (recorded by 0012-noun-lexicon-catalogue.sql header,
      0012-noun-lexicon-catalogue.sql content_sha256) is not pinned: …
FAIL 2 recorded path: data/speaking-guide.json (recorded by 0014-writing-speaking-guides.sql
      content_sha256) is not pinned: …
9 failed        exit 1
```

and the unmutated run is `0 failed`, `exit 0`.

## 5. Gates

```text
node tools/run-gates.mjs mirror     -> mirror: 14/14 passed   (eol-hash-check 2.6s, new)
node tools/run-gates.mjs baseline   -> baseline: 9/9 passed
node tools/run-gates.mjs mirror-db  -> mirror-db: 7/7 passed  (disposable postgres:17-alpine)
```

## 6. The policy question: normalise the repo-wide ~568, or leave them alone?

**Recommendation: leave them alone, and let the new gate carry the safety.** The trade-off:

- **A blanket rule buys nothing for committed bytes.** All 568 are already `i/lf` — the index and every
  blob are LF today. `* text eol=lf` would change only what Windows developers materialise locally, at
  once, across ~568 files, including files whose *hash nothing records*. That is a large, immediate
  local blast radius for a hazard that only exists where a digest is recorded.
- **The hazard is specific, so the protection should be specific.** "A digest is recorded over a text
  file's bytes" is the whole failure mode — it has now produced two CI failures and eight latent
  records. Leg 2 makes that case impossible to add silently, because it derives the path set from the
  artifacts that record digests.
- **A blanket rule is the one change that can break the deliberate pins.** `content/library-translations/*.json -text`,
  `public/assets/design/** -text`, `work/design-reference/** -text` and `*.wav binary` all exist because
  a recorded sha256 must match the artifact byte-for-byte. A repo-wide `*.json`/`* text` rule placed
  after them silently unpins the first three; placed before them it is only safe if the ordering is
  then re-verified file by file, and `text=auto` additionally asks git's heuristic to decide about
  fonts, images and licence text — which is exactly where a one-time renormalise turns into changed
  artifact digests (`design-assets-check`) or the collateral churn the Lead already hit.
- **What a blanket rule would genuinely buy**: a new hashed file whose digest gets recorded *outside*
  the repository (a ledger row, a deployment manifest) would be safe by default. That is a real gap in
  leg 2's derivation, and it is the honest reason to consider the policy — not the CRLF count.

So: if Ron wants one rule, the only safe shape is `* text=auto` **at the top**, before every pin, with
the full `git add --renormalize` reviewed file-by-file and the three byte-pinned families re-verified.
My recommendation is not to do that now; the targeted pin plus the gate closes the observed class with
no repo-wide blast radius. **I did not apply any blanket policy.**

## 7. Residual risk

1. **`migrate-check.mjs:202` is stricter than the engine it verifies.** It asserts `recorded ===
   sha256File(bytes)` with no tolerance, while `provision.mjs:139 migrationChecksumMatches` deliberately
   accepts the uniform LF/CRLF variant of an applied migration. On a working tree where the legacy
   migrations are CRLF (this one: `0001`–`0006` are `attr/[text eol=lf]` but `w/crlf`, i.e. stale
   checkouts), the two disagree. `migrate-check` is in no gate group and no CI step, so it is latent;
   it is outside this lease's files, so I report rather than change it. Aligning it with
   `migrationChecksumMatches` is the one-line follow-up.
2. **Nine `.sql` files are CRLF in this working tree** (`0001`–`0006` and three under
   `spikes/auth-runtime/`, the latter unpinned). Stale checkouts, not committed bytes: a fresh clone
   and CI get LF. The check reports them as notes.
3. **Leg 2 derives from artifacts that record digests.** A digest recorded outside the repository (a
   ledger checksum, a deployment manifest) is not derived, so its source could still be unpinned —
   §6's honest counter-argument. Leg 1's inventory limits the blast radius by failing on any
   unclassifiable direct file hash.
4. **Caller-supplied hashes are classified, not resolved** (20 sites): the path arrives as a parameter,
   so the analyser prints the site for a human instead of tracing it. None of them is recorded today.
5. **Stale recorded digests are deliberate and this gate does not judge them.** `0012`'s digest for
   `data/noun-lexicon.json` (`df30f4a4…`) and `0014`'s for `data/speaking-guide.json` match *neither*
   byte form, because `0043` corrected those sources in place and patched the database forward. The
   applied migration is frozen; the correction is forward. Pinning fixes the EOL problem and does not
   make those two regenerable — regenerating them fails for a content reason, on any platform.
6. **The guide digests are committed literals, so the database is consistent across platforms; the
   hazard is a regeneration.** `resolve_review_subject` (`0035:85`) carries `content_version.content_sha256`
   into `content_review_decision.subject_sha256`, and `0035:141` refuses a mismatch
   (`review_subject_mismatch`). Because the value is a literal in the applied migration, every
   installation shares it. A regeneration on a Linux machine would rewrite that literal to the LF
   digest and desynchronise any decision already recorded — which is the second reason the pin plus the
   `--check`-style guards matter beyond CI going red.
7. **The bundle, design and WAV pins were not touched**, and `git check-attr` proves it (§2).
