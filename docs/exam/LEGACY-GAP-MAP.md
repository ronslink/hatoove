# Legacy gap map — existing app scoring versus the verified telc B1 blueprint

Created: 2026-09-30 · Execution `user04-20260930-a` · Issue [ronslink/hatoove#16](https://github.com/ronslink/hatoove/issues/16)
Status: **analysis only — unreviewed, not a defect list, not approval**

Scope: compares the **existing application source** against the rules verified in
[`TELC-B1-SOURCES.md`](TELC-B1-SOURCES.md) / [`telc-b1-written-draft.json`](telc-b1-written-draft.json).
Every entry below gives an exact source anchor. Nothing here is implemented or fixed by this task: the
coordinator owns `public/js/exam.js` and all scoring/contract decisions.

**Reading rule for this document.** A row marked *Unknown* is **not** a defect. It means the sources
consulted do not settle the question, so the existing behaviour cannot be called right or wrong. Only rows
marked *Mismatch* are demonstrated conflicts with a verified rule or an existing contract.

---

## 1. Anchors inspected

| Anchor | Role |
|---|---|
| `public/js/blueprint.js:15-24` | `TOTAL_POINTS = 300`, `WRITTEN = {total:225, pass:135}`, `ORAL = {total:75, pass:45}`, `GROUPS` with per-group `mode` (`written`/`oral`) |
| `public/js/blueprint.js:26-101` | `PARTS` — per-part `pts`, `items`, `minutes`, `kind`, and `plays` for listening |
| `public/js/blueprint.js:105` | `SUBTEST_ORDER` (12 entries incl. `SP1–SP3`) |
| `public/js/engine.js:219-224` | `pointsFor()` — equal weight within a part |
| `public/js/engine.js:238-268` | `scorecardToPoints()` — includes `passed` and per-part `ok` |
| `public/js/engine.js:270-276` | `gradeBand()` — percentage thresholds 90/80/70/60 |
| `public/js/engine.js:563-575` | Writing heuristic checklist (`analyseWriting`) |
| `public/js/exam.js:464-502` | `scoreSet()` per-`kind` marking |
| `public/js/exam.js:1493-1500` | Mock result cards (`Gesamt`, `Bestanden?`, `Quote`) |
| `public/js/exam.js:1405-1440` | Mock writing points, including the heuristic fallback |
| `public/js/exam.js:397`, `269` | Listening `plays` consumption |
| `data/seed.json` | Eight families `LV1…HV3`, three sets each |

---

## 2. Per-family map (LV1 / LV2 / LV3 / SB1 / SB2 / HV1 / HV2 / HV3)

| Family | Verified rule (source) | Existing implementation | Verdict |
|---|---|---|---|
| **LV1** | 3 parts / 20 LV items; Teil 1 = 5 matching items (1–5), headlines a–j, each usable once (S2 PDF p. 7 / printed p. 5; PDF p. 8 / printed p. 6) | `blueprint.js` `LV1: pts 25, items 5, kind 'matching_headlines'`; `brief` states „10 Überschriften (a–j), 5 kurze Texte (1–5). Jede Überschrift nur einmal, 5 sind Distraktoren." Marked by exact string match in `exam.js:468-469` | **Match** (pts/items/kind/reuse). *Unknown:* whether duplicate headline selection is rejected — see §4 |
| **LV2** | Teil 2 = 5 multiple-choice items (6–10) (S2 PDF p. 7 / printed p. 5) | `LV2: pts 25, items 5, kind 'mc3_text'` | **Match**. *Unknown:* number of options per item is not stated in the sources read |
| **LV3** | Teil 3 = 10 matching items (11–20), ads a–l each usable once, **no-match marked `x`** (S2 PDF p. 12 / printed p. 10) | `LV3: pts 25, items 10, kind 'matching_ads'`; `brief` states „12 Anzeigen (a–l). Jede Anzeige nur einmal. Für manche Situationen passt keine → 'x'." | **Match** |
| **SB1** | 2 parts / 20 SB items; Teil 1 = 10 multiple-choice grammar items (21–30) (S2 PDF p. 7 / printed p. 5) | `SB1: pts 15, items 10, kind 'gap_mc3'` | **Match** |
| **SB2** | Teil 2 = 10 gap items (31–40) from a 15-word bank (a–o), each word used only once (S2 PDF p. 15 / printed p. 13) | `SB2: pts 15, items 10, kind 'gap_bank'`; `brief` states „15 Wörter (a–o). Jedes Wort höchstens einmal, 5 bleiben übrig." | **Match** |
| **HV1** | Teil 1 = 5 true/false items (41–45), **one play only** (S2 PDF p. 16 / printed p. 14) | `HV1: pts 25, items 5, kind 'truefalse', plays: 1` | **Match** |
| **HV2** | Teil 2 = 10 true/false items (46–55), **two plays** (S2 PDF p. 17 / printed p. 15) | `HV2: pts 25, items 10, kind 'truefalse', plays: 2` | **Match** |
| **HV3** | Teil 3 = 5 true/false items (56–60), **two plays each** (S2 PDF p. 18 / printed p. 16) | `HV3: pts 25, items 5, kind 'truefalse', plays: 2` | **Match** |
| `SA1` (writing) | One task, 4 Leitpunkte, 45 points, three criteria (S2 PDF p. 40 / printed p. 38) | `SA1: pts 45, items 1, kind 'writing'` | **Match on shape**; criterion implementation is C-05 scope, not this map |

**Item-range continuity:** `LV1 1–5`, `LV2 6–10`, `LV3 11–20`, `SB1 21–30`, `SB2 31–40`, `HV1 41–45`,
`HV2 46–55`, `HV3 56–60` are consistent with the verified numbering 1–60.

---

## 3. Weighting, reuse, playback and assistance

| Area | Verified rule | Existing implementation | Verdict |
|---|---|---|---|
| **Subtest weighting** | LV 75 (25 %), SB 30 (10 %), HV 75 (25 %), SA 45 (15 %); written 225 (75 %) + oral 75 (25 %) = 300 | `GROUPS` pts 75/30/75/45/75; `TOTAL_POINTS 300`, `WRITTEN 225/135`, `ORAL 75/45` | **Match** |
| **Equal weight within a part** | Source gives one per-part maximum, so items inside a part are equally weighted | `engine.js:219-224` `pointsFor()` = `pts × correct / total` | **Match** |
| **Objective item total** | 60 objective items (1–60) | 5+5+10+10+10+5+10+5 = **60** | **Match** |
| **90-minute shared LV+SB block** | LV and SB share 90 minutes with no break (S1; S2 PDF p. 31 / printed p. 29) | `GROUPS.LV.minutes 65` + `GROUPS.SB.minutes 20` = 85, with a note that LV shares 90 minutes with SB. Per-part minutes sum LV 15+20+30=65, SB 10+10=20 | **Mismatch (informational)** — the group labels total 85, not 90. Harmless for a practice app that does not enforce a shared clock, but the two numbers disagree with the verified 90-minute block and with each other. Source anchor: `blueprint.js:20-21` |
| **Listening total time** | ca. 30 minutes | `GROUPS.HV.minutes 30`; parts 8+14+8 = 30 | **Match** |
| **Writing time** | 30 minutes | `SA1.minutes 30`; `GROUPS.SA.minutes 30` | **Match** |
| **Listening plays** | 1 / 2 / 2, non-uniform | `plays: 1 / 2 / 2` and consumed at `exam.js:397` (`maxPlays = PARTS[partId].plays \|\| 1`) | **Match** |
| **No-match (`x`)** | Stated for LV Teil 3 only | `LV3.brief` documents `x`; `scoreSet()` compares the given value to the expected key by exact string match only | **Partial / Unknown** — the UI hint exists, but whether `x` is enforced as *required* when the expected answer is a no-match, and whether it is *rejected* where no-match is not allowed, is not settled by the code alone |
| **Reuse limits** | Single-use in LV1, LV3, SB2 | Documented only in `brief` strings; `scoreSet()` performs no cross-item duplicate-selection check | **Unknown** — no verified rule requires the app to enforce single-use during practice; recorded as an open question, not a defect |
| **Assistance / playback policy** | S2 forbids interrupting playback in the real exam; the pilot additionally needs an explicit guided-vs-timed assistance policy | Play count is enforced per part; no guided/timed assistance mode is visible in the anchors inspected | **Unknown** — policy belongs to E-01/W-02, not to this map |
| **No matching option (SB1, LV2)** | Not addressed in any source read (U4) | No explicit handling | **Unknown** (carried from U4) |

---

## 4. Demonstrated conflicts with a verified rule or an existing contract

These are the only entries where existing behaviour conflicts with a source or with the pilot's own
contract. They are reported, **not** changed here.

| ID | Severity | Finding | Anchor | Why it conflicts |
|---|---|---|---|---|
| **G1** | High | The mock result card **„Bestanden?"** is driven by the **written** part alone: it shows „Ja" whenever `written >= 135`, regardless of the oral part. | `exam.js:1497-1498` uses `scored.written.ok` | The verified rule requires **60 % in the written *and* 60 % in the oral part separately** (S2 PDF p. 42 / printed p. 40). The engine already computes the correct conjunction at `engine.js:266` (`passed`), so the UI contradicts both the source and its own engine. With speaking excluded from the pilot, the honest display is a **partial written result**, never „Bestanden?" |
| **G2** | Medium | The grade band is derived from `written / 300` — a **three-part** denominator that treats the 225-point written aggregate as a fraction of the 300-point whole — and that label is displayed in the card whose value is `${written} / 225`. | `exam.js:1484` `gradeBand((scored.total / 300) * 100)`; rendered beside the `/ 225` total at `exam.js:1497` | Two separate problems in one label. (a) With the oral part unassessed, `written / 300` is not a whole-exam percentage, so the band reflects a quantity the pilot cannot compute. (b) Even taken at face value the computation and the displayed denominator disagree: the same card shows a `/ 225` total while the band is scaled to 300. Official bands apply to the 300-point total and only once both parts reach their minimum (S2 PDF p. 42 / printed p. 40). |
| **G3** | High | When the writing AI result is unavailable, the mock assigns `points = Math.round(heuristic * 45 * 0.82)` and then a binary `correct: points >= 27`. | `exam.js:1409`, `1437-1438` | `IMPLEMENTATION_PLAN.md` ("Durable writing and truthful feedback") and `docs/contracts/PILOT-V0.1.md:69` both require that **provider failure cannot yield a heuristic mark**; writing is provisional/formative. A synthesised 45-point writing score is an unvalidated fallback. |

- **G4 (not a writing defect).** Earlier drafts of this map listed the `/ 45` versus `/ 25` difference as a
  writing conflict. **That entry is withdrawn.** The `/ 25` card belongs to the **speaking** grader
  (`exam.js:1153`, `g.points / 25`), consistent with a 25-point speaking subtest, and speaking is outside the
  pilot. The writing views consistently use `/ 45`, which matches the verified maximum. No conflict is
  demonstrated here, so it is not a demonstrated defect.

**Observed defect versus hypothesis.** G1, G2 and G3 are **observed defects**: each is a code path whose
behaviour contradicts a verified rule or the pilot contract, and each is anchored to the exact expression
that produces it. Nothing else in this map is asserted as a defect. The *Unknown* rows in §2 and §3 are
explicitly **hypotheses** awaiting evidence, not findings — they record behaviour that the sources read do
not settle either way.

---

## 5. What this map does not establish

- It is **not** a content review of `data/seed.json`; whether the seed items match exam difficulty, or whether
  any seed text derives from copyrighted material, was not assessed.
- It is **not** a correctness claim about `scoreSet()` per item type beyond the anchors read.
- It does **not** resolve U3 (penalty for wrong answers) or U4 (no-match for SB1/LV2); those remain unresolved
  in the source register, so no existing behaviour is called wrong on those grounds.
- It does **not** authorise any change. `public/js/exam.js` and `public/js/engine.js` are owned by the
  coordinator, and the pilot's scoring/contract decisions belong to E-01/E-02.
