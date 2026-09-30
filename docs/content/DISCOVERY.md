# C-01 discovery: existing source content inventory (counts only)

Status: discovery artefact, **not** a content or exam approval. Owner: Hermes/Docker (slot2 for this
correction), execution `c01d-20260930-a`, branch `codex/c01-discovery`, base
`a9a4cfd95992df95dc76bdbab3bbb690efe4841f`. Companion command: `tools/content-discovery.mjs`.
Formal C-01 migration/audit still depends on the E-01 blueprint review.

Command (read-only, dependency-free, offline):

```
node tools/content-discovery.mjs          # human-readable report
node tools/content-discovery.mjs --json   # same data, stable JSON
```

Inventory: exactly one read-only `git ls-files -z` call (`execFileSync`, no shell) — the single
deterministic tracked file list, used by every scan in the command. Untracked, ignored and private
files are never enumerated or read. The command writes nothing, opens no network/provider/`.env`,
runs no browser or server, and prints counts and identifiers, never complete question/answer text.

## Counting units (each counted once, from one named place)

1. Source file — one **tracked** JSON under `data/`. This is the shipped content corpus, not the whole repository.
2. Task family — one top-level key of `data/seed.json` (`LV1…HV3`), i.e. one exam task format.
3. Set — one array element of a task family, i.e. one playable pack. **Sets must not be assumed**: the plan warns
   that the presence of a pack does not mean the pack is reviewed, licensed or exam-faithful.
4. Answer slot — one graded position inside a set: a `text` (LV1), `question` (LV2), `situation` (LV3),
   `gap` (SB1/SB2) or `item` (HV1–HV3).
5. Complete set — a set where every answer slot carries a stored key, every slot carries an explanation
   (inline `why`, or membership in the set-level `why` map LV1 uses), and all fields the family schema requires exist.
6. Option **container** — one slot that itself offers selectable choices (an LV2 question, an SB1 gap).
7. Option **entry** — one selectable choice inside a container (a/b/c inside one LV2 question or SB1 gap).
8. Pool **entry** — one entry of a set-level pool array that is not attached to a single slot
   (LV1 `headlines`, LV3 `ads`, SB2 `bank`).
9. Writing prompt — one offline writing task defined in `public/js/ai.js` (`OFFLINE_WRITING_TASKS`). Live provider
   generation is a code path, not source content, and is counted separately.
10. Guide unit — one element of a named reference/teaching block in a guide file (section, topic, rule, table, …).
11. Lexicon entry — one vocabulary item (`vocab.json` words, `noun-lexicon.json` nouns).
12. Media/TTS match — one regex match in a tracked text file: a fixed audio file path (extension search over
    tracked **path names**, any directory) or a browser text-to-speech call site. **Every** match in a file is
    counted. Runtime scope (public client code + `server.js`) is reported separately from tests/docs/prose,
    because prose that mentions an audio extension or a speech API is not an application dependency.
    `tools/content-discovery.mjs` contains the two patterns as literals and is therefore excluded from the text
    scan; the exclusion is printed in the report.

Bytes and hashes: `bytesLinuxCheckout` and the printed hashes describe the bytes of **this Linux checkout** —
a Git checkout with CRLF line endings would produce different byte counts and a different byte hash. The
`contentSha12` field is therefore computed over line-ending-normalised content, and every count column is
checkout-independent. No portable byte hash is claimed.

## Verified counts (source facts, one run of the corrected command on this checkout)

Source files: **10** tracked `data/*.json` (of 160 tracked files in the base tree — see the status note at the
end), 562,773 bytes in this checkout, each with a printed normalised `contentSha12`.

| family | sets | answer slots | keyed | explained | complete sets | slot array | option containers | option entries | pool entries |
|---|---|---|---|---|---|---|---|---|---|
| LV1 | 3 | 15 | 15 | 15 | 3 | `texts` | 0 | 0 | `headlines` 30 |
| LV2 | 3 | 15 | 15 | 15 | 3 | `questions` | 15 | 45 | — |
| LV3 | 3 | 30 | 30 | 30 | 3 | `situations` | 0 | 0 | `ads` 36 |
| SB1 | 3 | 30 | 30 | 30 | 3 | `gaps` | 30 | 90 | — |
| SB2 | 3 | 30 | 30 | 30 | 3 | `gaps` | 0 | 0 | `bank` 45 |
| HV1 | 3 | 15 | 15 | 15 | 3 | `items` | 0 | 0 | — |
| HV2 | 3 | 30 | 30 | 30 | 3 | `items` | 0 | 0 | — |
| HV3 | 3 | 15 | 15 | 15 | 3 | `items` | 0 | 0 | — |
| **total** | **24** | **180** | **180** | **180** | **24/24** | | **45** | **135** | |

Options, with units explicit: **45 option containers** — 15 LV2 questions (one per question) and 30 SB1 gaps
(10 gaps per set × 3 sets) — holding **135 selectable option entries** (each container holds an `options` object
keyed `a`/`b`/`c`, i.e. 3 entries). SB1's per-set figure of 10 is therefore **10 containers**, not 10 selectable
options. SB2 gaps carry no per-slot options at all (0 containers): the set-level `bank` array carries every
choice, 15 entries per set (**45 pool entries**). LV1 offers 10 `headlines` per set (30 pool entries); LV3 offers
12 `ads` per set (36 pool entries). HV1–HV3 items are true/false and offer no option containers. The earlier
claim that LV2 "has no pool" was wrong and is corrected here.
Sets carrying any governance field (`source`/`rights`/`license`/`review`/`reviewStatus`/`version`): **0 of 24**.

Writing (`public/js/ai.js`): **6** offline prompts, **3** `du` + **3** `Sie`; **6** leitpunkt arrays with
**24** leitpunkte total (4 per prompt); live-generation path present; rubric **4** criteria
(`aufgabe` 15, `kommunikation` 10, `richtigkeit` 12, `ausdruck` 8), max sum **45**.

Guides (block element counts): `cases-guide` tables 8 / rows 39, triggers 4, examples 8, watchOut 6, watchOutEn 6;
`core-grammar` tiers 4 / items 125; `core-phrases` tiers 3 / items 130; `gender-rules` rules 6 / items 36,
exceptions 40, doubleGender 14, watchOut 6, watchOutEn 6; `grammar-guide` topics 14 / examples 84;
`speaking-guide` parts 3 / approach 18; `writing-guide` sections 6 / points 24, phrases 8, examples 4,
checklist 8, watchOut 6, checklistEn 8, watchOutEn 6. Lexicons: 300 words, 240 nouns.

Audio / TTS — scope: every tracked path, all directories (extension search over path names, then a text scan
over the tracked text extensions the command prints):

- Fixed audio files anywhere in the tracked tree: **0**.
- **Runtime scope** (`public/**/*.{js,mjs,html,css}` + `server.js`): fixed-audio extension matches **0** in 0 files;
  browser text-to-speech matches **9** in **1** file — `public/js/speech.js`.
- **Outside runtime scope** (tests, research, docs, work reports, prose — not an application dependency):
  fixed-audio extension matches **0** in 0 files; browser text-to-speech matches **10** in **1** file —
  `tools/tts-check.js` (a test), so the 19 matched occurrences reported earlier split 9 runtime + 10 test.

Limits of this audio finding (printed by the command as well):
- The file search is an extension search on tracked path names; audio served through an extensionless path, a
  query string, a remote URL or a file generated at runtime would not appear.
- Only tracked files were read, so "0 fixed audio files" means "0 in the tracked tree", not "0 anywhere"; audio
  in ignored, untracked or private trees was out of scope and was not read.
- Therefore **no universal "no runtime audio" claim is made**: the tracked tree contains no fixed audio file and
  no runtime code that references one by extension, but that is a scoped observation, not proof about assets
  outside the tracked set, and it is not a statement about what the learner UI may load at run time.
- This document writes none of the matched pattern literals itself, so `docs/content/DISCOVERY.md` contributes
  0 audio and 0 TTS matches and does not disturb the counts; the command's own file is excluded for the same
  reason and prints that exclusion.

## Gaps and unknowns (facts, then interpretation)

Facts:
- Nine of ten source files declare a `source` string and `level: "B1"`; `data/seed.json` declares neither.
- No source file and no seed set carries `version`, `rights`, `license`, `review`, `reviewStatus`,
  `reviewedBy`, `approvedBy` or a date field.
- No fixed audio file exists in the tracked tree and no tracked runtime file references one by extension.
  Listening practice in the tracked source runs on browser speech synthesis.

Interpretation (stated as such):
- Every set is structurally complete — 180 of 180 slots hold a stored key and a stored explanation — but
  structural completeness is not correctness, exam fidelity or licence. The explanation text itself was not read
  for this deliverable, so nothing is asserted about its quality.
- A declared `source` string is a self-description by the corpus, not proof of provenance; it is weaker evidence
  than a named rights holder or a human review record.
- TTS-only listening means output depends on the learner's browser and voices; that is unverified here and no
  fixed-audio fallback exists inside the tracked tree.

## Execution status of this correction (precise)

Coordinator completion, after the worker's bounded run ended: independently inspected both corrected files, staged only those paths, ran both modes twice with byte-identical output within each mode, and passed101+9+14 baseline, repository guard162 files/142 text blobs and whitespace checks. Packaged preserved work as7e24229, verified the bundle and its one-commit/two-file scope, then integrated through CI-green PR20. These results close the packaging steps below; the following paragraph preserves the worker's original checkpoint rather than claiming it finished steps it did not run. Formal content/exam/rights review remains open.

Counts above are the output of the corrected command on this checkout. When the execution budget ended, the
after-correction steps had **not** yet been completed: the two-mode/two-run determinism comparison, the
124-check offline baseline (`tools/check.js` + `tools/writing-check.js` + `tools/feedback-check.js`), staging,
`tools/repository-check.mjs`, `git diff --cached --check`, the commit and the branch bundle export. Because
`tools/content-discovery.mjs` and this file were still untracked at measurement time, the inventory reported
160 tracked files; committing both adds them, so a post-commit run reports 162 tracked files while every content
count above stays the same. The remaining steps and the exact state are recorded in
`/projects/hatoove-handoff/c01d-20260930-a-RESULT.md`.

**Rights and review status are UNKNOWN.** No explicit human evidence of review, licence or rights clearance
exists in the tracked sources, and no such evidence was consulted. Absence of governance fields is not evidence
of clearance, and the presence of a `source` string is not a licence. This document approves no content, asserts
no exam fidelity, and supersedes no human review. Qualified human review remains necessary.
