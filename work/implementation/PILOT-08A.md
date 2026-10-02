# PILOT-08A — the design foundation: the driver becomes tracked, pinned and licensed

| | |
|---|---|
| Slice | PILOT-08a (extracted from PILOT-08, because the design is the driver and it was untracked) |
| Base | `c8b8f1e`; checker-first commit `2d37c87`; implementation `97926b8` |
| Branch | `codex/pilot-01-local-bringup` |
| Status | **Delivered, check green (6/6). Not independently reviewed, and not merged.** |

---

## 1. What was wrong

The supplied Hatoove design is the product's visual driver. It was:

1. **intact** — all 22 files verified byte-for-byte against the pinned manifest at `D:\Hatoove\design`
   (22/22, 0 mismatches), with the relocation from `D:/B1_Prep/design` recorded in the manifest;
2. **untracked** — `/design/` is in `.gitignore`, so **zero** files were in git: invisible to CI,
   invisible to the Hetzner and Docker workers, and one disk failure from gone;
3. **implemented nowhere** — `public/app/` did not exist, so `/` served the previous product:
   `<title>Certa – Prüfungstraining telc Deutsch B1</title>`, `<b id="brand-name">Certa</b>`,
   `aria-label="Certa Navigation"`.

`DESIGN-WIRE-01.md:12` had promised the fix and then recorded that it had not happened: *"DESIGN-01
will curate/version the usable assets and licence notices in the repository so remote workers do not
depend on a drive letter. This planning change imports no assets."* DESIGN-01 never ran.

## 2. What was built

```
public/assets/design/          the SHIPPED design system
  hatoove.css                     tokens, dark theme, @font-face, base elements
  fonts/source-sans-3.woff2       body face
  fonts/bricolage-grotesque.woff2 display face
  hatoove-logo.svg  hatoove-logo-white.svg  hatoove-mark.svg
  licences/OFL-SourceSans3.txt    SIL OFL 1.1, © Google Inc.
  licences/OFL-BricolageGrotesque.txt  SIL OFL 1.1, © 2022 The Bricolage Grotesque Project Authors
  PROVENANCE.md
work/design-reference/         the 14 reference screens + index, for READING ONLY
  README.md                       records what in the mockups is NOT a requirement
tools/design-assets-check.mjs  the check
.gitattributes                 the load-bearing part — see §4
```

The licence pairing is not inferred from names: the design's font bytes are **identical** to the
copies already in `hatoove-site/dist/assets/` (`7a19a702…`, `a79fdb52…`), and those notices were
already in the repository.

## 3. Verbatim check output

```
=== PILOT-08a design foundation check ===

PASS D1-design-system-present       the curated design system is at public/assets/design/
     6 curated file(s): bricolage-grotesque.woff2, source-sans-3.woff2, hatoove-logo-white.svg, hatoove-logo.svg, hatoove-mark.svg, hatoove.css
PASS D2-bytes-match-manifest        every curated byte matches the pinned digest
     6/6 match DESIGN-REFERENCE-MANIFEST.json
PASS D3-font-licences               every bundled font ships with its licence notice
     2 font(s), each with an OFL notice naming its family
PASS D4-tokens-declared             the token stylesheet declares the required tokens
     12 tokens present; dark theme present; 2 @font-face rule(s)
PASS D5-reference-present           the reference screens are imported and pinned
     15 reference file(s) under work/design-reference/, every digest matching
PASS X1-tamper-detected             a tampered asset fails the digest leg
     assets/hatoove.css appended to -> detected

6 passed, 0 skipped, 0 failed
```

On the base (`2d37c87`) the same check reported `0 passed, 4 skipped, 2 failed` — D1 `NOT CURATED:
6 of 6 asset(s) absent`, D5 `15 of 15 not imported`, and four legs **skipped rather than passed**.

## 4. The defect this slice nearly shipped

The `.gitattributes` file is not decoration. The supplied design files are **LF**, this checkout has
**`core.autocrlf=true`**, and there was **no `.gitattributes`**. Git would therefore have checked the
assets out as **CRLF**, so every pinned digest would have differed from the reviewed artifact on any
Windows clone: **the check would have passed on this machine and failed everywhere else.**

Necessity was measured, not argued — a fresh clone, `git ls-files --eol`:

```
i/lf  w/crlf  attr/       MASTER-PLAN.md                      <- no attribute: converted
i/lf  w/lf    attr/-text  public/assets/design/hatoove.css    <- attributed: preserved
i/lf  w/crlf  attr/       tools/local-bringup.mjs             <- no attribute: converted
i/lf  w/lf    attr/-text  work/design-reference/index.html    <- attributed: preserved
```

and the worktree bytes agree: `hatoove.css` CRLF=0 / bareLF=285, `MASTER-PLAN.md` CRLF=298 / bareLF=0.
The check was then re-run **inside the clone**: `6 passed, 0 failed`.

## 5. Related defect found, NOT fixed here

Investigating the above exposed a second, larger instance of the same class. `applyMigrations`
(`server/owned-postgres/provision.mjs:274-283`) computes `checksumOf(bytes)` over the **raw bytes of
the working-tree file**, and refuses to continue when the ledger disagrees. Measured on
`server/migrations/0001-auth-schema.sql`:

| | |
|---|---|
| this Windows checkout (CRLF), raw sha256 | `464552a5b33b4dbb` — **what the ledger recorded** |
| a Linux checkout (LF), raw sha256 | `b529a5b95ba4fc60` — **what `MANIFEST.json` pins** |

So **the migration ledger is a function of the checkout's line endings**, and the trigger is a
**git clone with different EOL conversion** — not "Linux" as such. Verified two ways:

```
# 1. a container does NOT trigger it: Docker COPY preserves the host's bytes
migrate: schema=hatoove applied=0 skipped=6 backfilled=0     (exit 0)
0001 ledger=464552a5b33b4dbb   host raw (CRLF)=464552a5b33b4dbb   <- agree

# 2. a Linux checkout DOES: the same database, the same command, LF files
migrate: FAILED checksum mismatch for migration 0001-auth-schema:
  the ledger has 464552a5b33b4dbbdcb146c49f6695e8012a67c11a1f664ba8df9c90b6d0c7ef,
  the frozen file is b529a5b95ba4fc604f046d95514c93ae872cf084b39e40eedfc85be8978abce0;
  refusing to apply a migration that is not the one that was reviewed       (exit 1)
```

The second run used `OWNAPI_MIGRATIONS_DIR` pointed at an LF copy of the same six files. So a
database migrated from this Windows checkout **cannot be verified or advanced from CI or from a
Linux worker's clone**, and the error accuses the migration of tampering when it is byte-identical
modulo line endings. `backfillChecksums` (`:242`) only fills `NULL` checksums; it does not reconcile
a differing one. `MANIFEST.json` pins the platform-independent LF form and is read by **no code**.

This is recorded as **PILOT-14** in the master plan. It is not fixed here because it touches
migration integrity and applied history, and a fix has to accept the legacy raw digest for rows
already applied rather than rewrite them.

## 6. LIMITS

- **Nothing renders these assets yet.** This is a bytes-and-licences check; no view was built and no
  browser was opened. `/` still serves the old Certa SPA.
- **Font coverage is still insufficient for the agreed languages.** The two subsets map 231 and 226
  codepoints and cover **neither Cyrillic nor Arabic**; they miss `ĞğİŞş`. Ukrainian, Arabic and
  Turkish explanations **cannot be honestly claimed** until additional licensed, pinned coverage
  exists. "The font is present" is not "the glyph is covered".
- **The reference screens contradict recorded decisions** and are imported for reading only. The list
  is in `work/design-reference/README.md`, and it includes sign-in method, readiness and pass lines,
  the study plan, the SRS review queue, checkout, and play-once audio.
- **Rendered evidence at 320/390, 768/1024/1180 and 1440 px in both themes is still required**, in
  both themes, and emulation does not replace a real device. None of it exists.
- **`design/` remains untracked**, deliberately: these copies are the curated artifacts and the check
  is what ties them to the reviewed originals. `build.py` is not imported, and must not be run.
- Not independently reviewed; not merged.

## 7. Next

The driver is now versioned, but it is still not **driving**: nothing is built from it. The next step
is the Hatoove shell under `public/app/` from these tokens — which is PILOT-08 proper, and which the
plan currently places after the backend slices. That ordering is the thing to reconsider.
