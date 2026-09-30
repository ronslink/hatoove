# telc Deutsch B1 (Zertifikat Deutsch) — written-exam source register

Execution: `user03-20260930-a` · Issue: [ronslink/hatoove#16](https://github.com/ronslink/hatoove/issues/16)
Retrieved: **2026-09-30** · Status: **DRAFT source extraction, unreviewed** — no educational, exam-fidelity or reuse approval.

This register records what the cited official sources actually state about the **written** examination
(`Schriftliche Prüfung`) of **Zertifikat Deutsch / telc Deutsch B1**. It is evidence for later E-01
implementation and human review. It is **not** an approved exam specification, not a task to change
scoring, and not permission to reproduce telc material.

Companion machine-readable artifact: [`telc-b1-written-draft.json`](telc-b1-written-draft.json)
(`version 0.1.0-draft`, `review.status = "unreviewed"`).

---

## 1. Applicable exam and variants

| Field | Value | Source |
|---|---|---|
| Exam | Zertifikat Deutsch / **telc Deutsch B1** | S1, S2 |
| Level | GER/CEFR B1, general-purpose German (`allgemeinsprachliches Deutsch`) | S1 |
| Developers | telc gGmbH, Österreichisches Sprachdiplom (ösd), Schweizerische Konferenz der Kantonalen Erziehungsdirektoren (EDK) via Institut für deutsche Sprache der Universität Freiburg (CH), Goethe-Institut e.V. | S2 p. 2 |
| Publisher | telc gGmbH, Frankfurt am Main | S2 p. 2 |

**Different exam — do not merge rules from these:** `Deutsch-Test für den Beruf` (DTB), `telc Deutsch B1·B2 Beruf`,
`telc Deutsch B1 Schule`, `Deutsch-Test für Zuwanderer` (DTZ). The assignment names DTZ and B1 Schule explicitly.
The sources cited here describe only the general Zertifikat Deutsch / telc Deutsch B1 variant above. **No
source consulted in this execution was found to state the differences from those variants**, so no comparison
is asserted — see U9.

---

## 2. Sources and evidence chain

| ID | Source | Retrieved | Locator | Verification |
|---|---|---|---|---|
| **S1** | Official exam page: *Zertifikat Deutsch / telc Deutsch B1* — `https://www.telc.net/sprachpruefungen/deutsch/zertifikat-deutsch-telc-deutsch-b1/` | 2026-09-30 | Section „Aufbau und Ablauf der Prüfung" (structure table) | HTTP 200, page fetched and read |
| **S2** | Official practice test (*Übungstest 1*): *Zertifikat Deutsch, telc Deutsch B1 — Übungstest 1, Prüfungsvorbereitung* | 2026-09-30 | PDF, 48 pages, SHA-256 `6FD22FFCC25CA75E5718CC9D55BF2369ED716D4071A1058A1FDD301F58FA2B2F` | Downloaded and text-extracted locally; page-by-page inspected |
| **S2-a** | Same PDF via the publisher shop link named in the assignment: `https://shop.telc.net/media/catalog/product/file/telc_deutsch_b1_zd_uebungstest_1.pdf` | 2026-09-30 | identical file | **SHA-256 identical to S2** — confirmed byte-for-byte |
| **S2-b** | Official download bundle named on S1 (`telc_deutsch_b1.zip`, contains S2 plus the listening audio `telc_deutsch_b1_zd_uebungstest_4.mp3`) | 2026-09-30 | `https://www.telc.net/fileadmin/user_upload/mock_exams/Deutsch/telc_deutsch_b1.zip` | Downloaded; contained PDF hashed identical to S2 |
| **S3** | *telc Prüfungsregularien* — the binding regulations for all telc examinations, linked from the site's „AGB und Prüfungsregularien" page | 2026-09-30 | `https://www.telc.net/fileadmin/user_upload/pdfs/AGB_Pruefungsordnung/9994-P00-150010.pdf` — **„gültig ab 15.04.2025"**, document no. `P01-9994-P00-150010`, 40 PDF pages | Downloaded and text-extracted; effective date, document number and change-log section located |
| **S4** | *Zertifikat Deutsch / telc Deutsch B1* Übungstest — **product sheet** for the scaled exam `telc Deutsch A2·B1` (5060-B00-010101), „Stand: 10.03.2023" | 2026-09-30 | `https://www.telc.net/fileadmin/user_upload/pdfs/Produktblatt_1060_Deutsch_A2_B1.pdf` | Downloaded and text-extracted; **records a different, newer scaled examination** (see §1.1) |

**Edition / date (S2):** „13. Auflage 2020 · © 2020 by telc gGmbH, Frankfurt am Main · Printed in Germany" (S2, PDF p. 4 = printed p. 2).
Bibliographic identifiers recorded on that page: Testheft ISBN 978-3-933908-02-5, order no. 5061-B00-010301;
Audio-CD ISBN 978-3-933908-93-3, order no. 5061-CD0-010101.

**Precedence.** S3 states that the *Prüfungsregularien* are valid for all telc examinations, that
exam-specific organisational guidelines **and the respective model tests in the current version**
(„die jeweiligen Modelltests in der aktuellen Fassung") must additionally be observed, and that every rule
laid down in the regulations is binding (S3 PDF p. 4 / printed p. 4, §1 *Geltungsbereich*). The classic
*Zertifikat Deutsch / telc Deutsch B1* has no separately published test specification in these documents, so
S2 remains the primary rule source for the written format while S3 governs the surrounding examination
conduct.

**Page-index convention (corrected).** The PDF page and the printed page run in parallel, and both are
**one-based numbers**. Hence `PDF page = printed page + 2`, equivalently `printed page = PDF page - 2`;
in zero-based array indices the offset is `printedIndex = pdfIndex - 2`. The earlier wording in this file
described the offset as a subtraction on one-based numbers, which was wrong even though its worked examples
were right. Check: the test-format table is PDF page 7, printed page 5 → 7 = 5 + 2 ✅; the answer sheet
S30 is PDF page 24, printed page 22 ✅.

**Reuse rights (separate gate).** S2 carries an explicit copyright notice reserving all rights and requiring
the publisher's prior written consent for any use beyond the statutory exceptions (S2, PDF p. 4 / printed
p. 2). Those downloads are **publicly available, which is not permission to copy** exercise texts, answer
keys or audio into the product. This register therefore paraphrases rules and does not reproduce passages,
keys or audio.

### 2.1 Related but distinct examination — `telc Deutsch A2·B1`

S4 documents a **different, newer scaled examination** introduced in 2023, which must not be confused with the
classic *Zertifikat Deutsch / telc Deutsch B1* analysed in this register:

| Field | `telc Deutsch A2·B1` (S4) | Classic `Zertifikat Deutsch / telc Deutsch B1` (S1, S2) |
|---|---|---|
| Nature | scaled format, certifies A2 **and** B1 from one test | single-level B1 certificate |
| Product code | 5060-B00-010101 | 5061-B00-010301 (Testheft) |
| Announced timeline | model test published 28.02.2023; first digital exam date 29.03.2023; first paper date 05.06.2023 | Übungstest 1, 13. Auflage 2020 |
| Written subtests (from the same series' test book) | Lesen, Sprachbausteine, **Lesen und Schreiben**, Hören, **Hören und Schreiben**, Schreiben — incl. *Mediation* | Leseverstehen, Sprachbausteine, Hörverstehen, Schriftlicher Ausdruck |
| Writing criteria | **four** criteria, bands **A–F** | **three** criteria, bands **A–D** at 5/3/1/0 |

Both examinations appear on the same site. **Which one a given learner is preparing for is a product
decision that this register does not make**, and the rules recorded below apply only to the classic B1 form
supported by S1 and S2.

---

## 3. Written examination — structure

**S1** gives the section length table. **S2 PDF p. 7 / printed p. 5** gives the full test-format table
(`Testformat`) with task types and item counts; **S2 PDF p. 31 / printed p. 29** gives the written-run procedure.

| # | Subtest | Parts | Items | Time | Source |
|---|---|---|---|---|---|
| 1 | Leseverstehen (reading) | 3 | 20 | 90 min shared with Sprachbausteine, no break | S1; S2 PDF p. 7 / printed p. 5 |
| 2 | Sprachbausteine (language elements) | 2 | 20 | (same 90 min block) | S1; S2 PDF p. 7 / printed p. 5 |
| 3 | Hörverstehen (listening) | 3 | 20 | ca. 30 min | S1; S2 PDF p. 7 / printed p. 5 |
| 4 | Schriftlicher Ausdruck (writing) | 1 | 1 task, 4 Leitpunkte | 30 min | S1; S2 PDF p. 7 / printed p. 5 |

**Written total: 150 minutes** — „Die Schriftliche Prüfung dauert 150 Minuten und besteht aus den Subtests
Leseverstehen, Sprachbausteine, Hörverstehen und Schriftlicher Ausdruck." (S2 PDF p. 31 / printed p. 29).
90 + 30 + 30 = 150. ✅

**Receptive/productive split (S1):** the receptive part is Lesen, Hören and Sprachbausteine; the productive
part is Schreiben and Sprechen. Task types include multiple choice and matching (S1).

### 3.1 Leseverstehen — 3 parts, 20 items (items 1–20)

| Part | Items | Skill | Task type | Source |
|---|---|---|---|---|
| Teil 1 | 1–5 (5) | Globalverstehen | 5 Zuordnungsaufgaben (matching headlines to texts) | S2 PDF p. 7 / printed p. 5; S2 PDF p. 8 / printed p. 6 |
| Teil 2 | 6–10 (5) | Detailverstehen | 5 Multiple-Choice-Aufgaben | S2 PDF p. 7 / printed p. 5 |
| Teil 3 | 11–20 (10) | Selektives Verstehen | 10 Zuordnungsaufgaben (situations to advertisements) | S2 PDF p. 7 / printed p. 5; S2 PDF p. 12 / printed p. 10 |

**Reuse / no-match rules (both are stated in the model test):**
- Teil 1 — „Sie können jede Überschrift nur einmal benutzen." (S2 PDF p. 8 / printed p. 6). Headlines **a–j** = 10 options for 5 items, each usable once.
- Teil 3 — „Sie können jede Anzeige nur einmal benutzen." and „Wenn Sie zu einer Situation keine Anzeige finden, markieren Sie ein **x**." (S2 PDF p. 12 / printed p. 10). Advertisements **a–l** = 12 options for 10 items, each usable once, **with an explicit no-match (x) option**.

### 3.2 Sprachbausteine — 2 parts, 20 items (items 21–40)

| Part | Items | Focus | Task type | Source |
|---|---|---|---|---|
| Teil 1 | 21–30 (10) | Grammatik | 10 Multiple-Choice-Aufgaben | S2 PDF p. 7 / printed p. 5 |
| Teil 2 | 31–40 (10) | Lexik | 10 Zuordnungsaufgaben (words a–o into gaps) | S2 PDF p. 7 / printed p. 5; S2 PDF p. 15 / printed p. 13 |

**Reuse rule:** Teil 2 — „Benutzen Sie die Wörter a–o. **Jedes Wort passt nur einmal.**" (S2 PDF p. 15 / printed p. 13).
Words **a–o** = 15 options for 10 gaps, each usable once. **No explicit no-match/distractor statement was found
for Sprachbausteine Teil 1** — see U4.

### 3.3 Hörverstehen — 3 parts, 20 items (items 41–60), permitted plays differ per part

All three parts use Richtig/Falsch decisions marked on the answer sheet as **PLUS (+) = richtig**,
**MINUS (−) = falsch**. The number of permitted plays is **not uniform**:

| Part | Items | Skill | Task type | Permitted plays | Source |
|---|---|---|---|---|---|
| Teil 1 | 41–45 (5) | Globalverstehen | 5 Richtig-Falsch | **once only** — „Sie hören diese Texte nur einmal." | S2 PDF p. 16 / printed p. 14 |
| Teil 2 | 46–55 (10) | Detailverstehen | 10 Richtig-Falsch | **twice** — „Sie hören das Gespräch zweimal." | S2 PDF p. 17 / printed p. 15 |
| Teil 3 | 56–60 (5) | Selektives Verstehen | 5 Richtig-Falsch | **twice each** — „Sie hören jeden Text zweimal." | S2 PDF p. 18 / printed p. 16 |

Reading time is announced in the audio itself: 30 seconds for items 41–45 (Teil 1) and one minute for
items 46–55 (Teil 2) (S2 PDF pp. 16–17 / printed pp. 14–15).

**Playback may not be interrupted:** „Das Abspielen der Tonaufnahmen darf während dieses Subtests nicht
unterbrochen werden." (S2 PDF p. 31 / printed p. 29). The permitted play counts above are the model test's
rule for the real examination; the pilot's own practice policy is a separate product decision (see §7).

---

## 4. Written examination — points, weighting and thresholds

From **S2 PDF p. 41 / printed p. 39** (`Punkte und Gewichtung`):

| Subtest | Items / task | Raw points | Max | Weighting |
|---|---|---|---|---|
| 1 Leseverstehen | Teil 1 items 1–5 · Teil 2 items 6–10 · Teil 3 items 11–20 | 25 · 25 · 25 | **75** | 25 % |
| 2 Sprachbausteine | Teil 1 items 21–30 · Teil 2 items 31–40 | 15 · 15 | **30** | 10 % |
| 3 Hörverstehen | Teil 1 items 41–45 · Teil 2 items 46–55 · Teil 3 items 56–60 | 25 · 25 · 25 | **75** | 25 % |
| 4 Schriftlicher Ausdruck | E-Mail | — | **45** | 15 % |
| **Teilergebnis I — Schriftliche Prüfung** | | | **225** | **75 %** |
| 5 Mündlicher Ausdruck | Teil 1 · Teil 2 · Teil 3 | 15 · 30 · 30 | 75 | 25 % |
| **Teilergebnis II — Mündliche Prüfung** | | | **75** | **25 %** |
| **Gesamtpunktzahl** | | | **300** | **100 %** |

Objective subtest arithmetic: reading 3 × 25 = 75 ✅; language elements 15 + 15 = 30 ✅;
listening 3 × 25 = 75 ✅; written aggregate 75 + 30 + 75 + 45 = **225** ✅; total 225 + 75 = **300** ✅.

### 4.1 Aggregate threshold and grades (S2 PDF p. 42 / printed p. 40)

„Um die Prüfung zu bestehen, müssen die Teilnehmerinnen und Teilnehmer **sowohl in der Schriftlichen als
auch in der Mündlichen Prüfung jeweils 60 % der möglichen Höchstpunktzahl** erreichen. Dies entspricht
**135 Punkten in der Schriftlichen und 45 Punkten in der Mündlichen Prüfung**."

- Written pass mark: **135 / 225** (60 %). ✅ 0.60 × 225 = 135
- Oral pass mark: **45 / 75** (60 %). ✅ 0.60 × 75 = 45
- **Both parts must independently reach 60 %.** The threshold is **not** applied per subtest.

Grade bands (only once both parts have reached their minimum):

| Points (total of 300) | Grade |
|---|---|
| 270 – 300 | sehr gut |
| 240 – 269.5 | gut |
| 210 – 239.5 | befriedigend |
| 180 – 209.5 | ausreichend |
| 0 – 179.5 | nicht bestanden |

**How fractional totals could arise, and what is *not* established.** Every point-bearing element recorded
above is integral: LV 3 × 25, SB 15 + 15, HV 3 × 25, and writing `(I + II + III) × 3` where each criterion is
5/3/1/0, so the whole-number written aggregate (and the oral subtotal) can only take integer values. The
`.5` endpoints therefore behave as strict upper limits for the band below rather than as reachable scores,
which is a **derived arithmetic observation, not a sourced rule**. S2 does not print a rounding rule, and S3
contains no rounding or half-point provision for this examination. The question is carried as **U7**.

**Limitation for this pilot — no overall pass can be inferred.** The written partial result
(`Teilergebnis I`, 225 points) is only half of a two-part condition. Because the pilot excludes speaking
and STT (IMPLEMENTATION_PLAN.md decision 3), the oral part is **unassessed**, so:
no overall pass/fail and no overall grade band may be computed or displayed. The only defensible written
statement is the written partial result against **135/225**, clearly labelled as a partial result.

---

## 5. Schriftlicher Ausdruck — task, four Leitpunkte, three criteria, band-to-total

**Task (S2 PDF p. 7 / printed p. 5; contents S2 PDF p. 6 / printed p. 4):** one writing task —
„Schreiben einer informellen oder halbformellen E-Mail", a writing task with **4 Leitpunkten**
(four content points), 30 minutes. Written output is assessed by **two licensed raters**; the second
rating may confirm or modify the first, and where they differ **the second overrides the first**;
telc headquarters performs spot checks and its rating is final (S2 PDF p. 40 / printed p. 38).

### 5.1 The three criteria and band scores (S2 PDF p. 40 / printed p. 38)

| # | Kriterium | A | B | C | D |
|---|---|---|---|---|---|
| I | **Aufgabenbewältigung** (task fulfilment) | 5 | 3 | 1 | 0 |
| II | **Kommunikative Gestaltung** (communicative design) | 5 | 3 | 1 | 0 |
| III | **Formale Richtigkeit** (formal accuracy) | 5 | 3 | 1 | 0 |

- Raw criterion maximum: 5 + 5 + 5 = **15**.
- **„In der telc Zentrale wird diese Punktzahl mit drei multipliziert"** → subtest maximum **45 points**
  = **15 % of 300**. ✅ 15 × 3 = 45; 225 × 0.20 = 45; 45/300 = 15 %.
- **Band-to-total calculation:** `written expression points = (I + II + III) × 3`, max 45.

### 5.2 Band descriptors

**Kriterium I — Aufgabenbewältigung** (S2 PDF p. 38 / printed p. 36):
A = all four Leitpunkte dealt with appropriately; B = three; C = two; D = only one or none.
A Leitpunkt counts as fulfilled when it is sensibly handled, still comprehensible and related to the task
(e.g. accepting, declining or counter-proposing); a single short sentence can suffice; two Leitpunkte may
be covered in one sentence; where a task component is plural or has two components, one answer is enough
(S2 PDF p. 39 / printed p. 37).

**Topic/situation failure rules (S2 PDF pp. 38–39 / printed pp. 36–37) — important for the app's marking logic:**
- If the text has **no or hardly any connection to the writing task** → `Thema verfehlt`: **D in all three
  criteria**, and the `Thema verfehlt` field is marked `ja` on answer sheet S30.
- If the theme is addressed but the **Situierung (situational framing) is wrong**, or only one/no Leitpunkt
  is handled appropriately → **only Kriterium I is set to D**; Kriterien II and III are still assessed.
- Kriterium III may be D while I and II are A, B or C (S2 PDF p. 39 / printed p. 37).

**Kriterium II — Kommunikative Gestaltung:** coverage of expression range, structuring and text logic
(cohesion and coherence, connectives, register, vocabulary range). **A is not awarded** if the text-type
features of a personal/semi-formal e-mail are missing; if the wrong register is chosen or fluctuates; if the
Leitpunkte stand unconnected; or if sentences predominantly begin with *Ich*/*Wir*. **C or D** is awarded for
serious violations of addressee-reference and register that make the text unclear/contradictory at central
points, and/or for wholly missing or nonsensical connectives. Text-type features of a letter (sender,
recipient, date, subject line) are **not required** (S2 PDF p. 39 / printed p. 37).

**Kriterium III — Formale Richtigkeit:** the primacy of comprehensibility applies; ending and gender errors
weigh less than agreement errors, and A or B is possible where errors do not impede rapid comprehension
(S2 PDF p. 39 / printed p. 37).

---

## 6. Answer sheet and administrative facts (context, low app relevance)

- Answer sheet **S30**; task booklet **S10**; oral rating sheet **M10**; oral criteria sheet
  (S2 PDF pp. 24–29 / printed pp. 22–27; contents PDF p. 6 / printed p. 4).
- Aids such as dictionaries, mobile phones and other electronic devices are **not permitted**; any attempt
  at deception leads to immediate exclusion (S2 PDF p. 31 / printed p. 29).
- After the 90-minute block, page 2 of S30 is collected; after Hörverstehen, page 3; after the 30-minute
  writing time, pages 5 and 6 plus all booklets and notes (S2 PDF p. 31 / printed p. 29).
- A failed or unattempted part may be repeated in the same or the following calendar year; a repeat result
  replaces the earlier one irrevocably (S2 PDF p. 42 / printed p. 40).
- **Government by S3.** Re-marking can also make a result *worse*, and the revised result then applies
  irrevocably (S3 PDF p. 36 / printed p. 36, *Überprüfung des Prüfungsergebnisses*). S3's **Anhang 1**
  governs when a previously achieved partial result may be credited to a later attempt (*Anrechnung von
  Teilergebnissen*), and it names which examinations permit this and which do not — relevant if the product
  ever reports a partial written result (S3 PDF pp. 34–36 / printed pp. 34–36 and p. 39). **The specific
  entries for this examination were not transcribed**, because the pilot reports no official result.
- Test versions exist in several languages (S2 PDF pp. 28–29 / printed pp. 26–27).

---

## 7. Separate gates — explicitly not satisfied here

| Gate | Status | Why |
|---|---|---|
| **Exam-fidelity / educational approval** | **Not satisfied** | Requires a qualified human expert plus a recheck of the applicable edition at implementation/release time (E-01; IMPLEMENTATION_PLAN.md decision 8). |
| **Native-language explanations** | **Not satisfied** | No explanation-language content was produced or reviewed here. Native review is C-06. |
| **Audio content and reuse rights** | **Not satisfied** | The listening audio exists in the official bundle, but public availability is not permission to copy. Reproduction/adaptation requires the publisher's written consent (S2 PDF p. 4 / printed p. 2). Any script, voice recording or reuse needs separate rights clearance and qualified listener review (C-04). |
| **App-ready implementation claims** | **Not satisfied** | This register is source extraction only. It does not authorise scoring, marking or content changes; keys and full exam texts are deliberately not reproduced. |

---

## 8. Unresolved edges

IDs are stable and match `unresolved[].id` in the companion JSON. An entry described as *partly closed*
carries verified new evidence but still lacks the specific confirmation it needs; nothing here is marked
resolved without a source page.

| ID | Status | Unresolved | Detail |
|---|---|---|---|
| U1 | **Partly closed** | Binding regulations located; no separate B1 test specification found | The general **telc Prüfungsregularien are now retrieved and verified** as **S3** („gültig ab 15.04.2025", doc `P01-9994-P00-150010`) and state that they are valid for all telc examinations, that exam-specific organisational guidelines *and the current model tests* must additionally be observed, and that every rule therein is binding. **No separately published test specification / `Prüfungsordnung` specific to the classic Zertifikat Deutsch B1 was located**, so the written-format rules above still rest on the model test (S2) plus S1. Whether S2 in its 2020 edition is the current model test is **not confirmed** (see U2). |
| U2 | **Partly closed** | Current edition of the classic B1 model test unconfirmed; a newer *scaled* exam verified | S2 remains the latest classic-B1 model test located (13. Auflage 2020, §2). However **S4 records a different, newer scaled examination `telc Deutsch A2·B1`** whose model test was published 28.02.2023 with first exams in 2023 (§2.1) — the same series whose test book carries four writing criteria at bands A–F. Whether the classic single-level B1 model test has been superseded *for a given learner* is a product decision this register does not make. S3 itself requires the **current version** to be used, so this must be rechecked before implementation. |
| U3 | **Unresolved — absence confirmed in S3** | No objective penalty rule in the retrieved official sources | Neither S2's instructions for the objective parts nor **S3** contains a penalty, deduction or guessing provision for this examination. S3 covers examination conduct, entitlement, results, re-marking and repeat rules rather than per-item scoring. Reporting this as *unresolved* is deliberate: **the absence of a rule in the documents read is not a rule that no penalty applies**, and it is not inferred from silence. Only correct/incorrect per item is assumed, which remains **unconfirmed**. |
| U4 | Unresolved | Distractor / no-match semantics for Sprachbausteine Teil 1 and Leseverstehen Teil 2 | The no-match (`x`) rule is stated only for Leseverstehen Teil 3, and single-use only for the matching parts (LV Teil 1, LV Teil 3, SB Teil 2). What the learner should do when no option fits in SB Teil 1 or LV Teil 2 is **not addressed** in any source read. |
| U5 | Unresolved | Part-level timing split inside the 90-minute block | S1/S2 state 90 minutes shared by Leseverstehen and Sprachbausteine with no break. **No sub-allocation** between the two subtests is printed. |
| U6 | Unresolved | Hörverstehen timing detail | S1 says „ca. 30" minutes; the model test does not break that 30 minutes into per-part durations beyond the announced reading pauses. |
| U7 | **Partly closed** | Grade-band `.5` endpoints and rounding | Bands as printed: 270–300, 240–269.5, 210–239.5, 180–209.5, 0–179.5. Every point-bearing element verified above is integral, so a `.5` total is arithmetically unreachable and the endpoints act as strict upper limits — a **derived observation, not a sourced rule**. S2 prints no rounding rule and S3 contains no rounding or half-point provision. How or whether fractional totals occur is **not explained by any source read** and is not speculated further. |
| U8 | Partly closed | Differences from DTZ / B1 Schule / other variants | Still out of scope for a systematic comparison, but §2.1 now distinguishes the classic B1 from the **scaled `telc Deutsch A2·B1`** using S4 evidence. No DTZ or B1-Schule comparison is asserted. |

**Numbering note.** Earlier drafts of this register listed a ninth item U9 (*speaking subtest details*) while
the companion JSON carried eight unresolved entries, so the two documents disagreed. The speaking/`M10`
details were never an open question — they are recorded in §6 as context for excluding oral results — and that
duplicate has been removed. Both documents now carry **U1–U8 with the same meanings**.

---

## 9. What this register deliberately does not contain

No exam texts, no answer keys, no audio transcripts, no audio files, and no reproduction of the model
test's items. Rules are paraphrased; the few quotations included are short and are used to pin an exact
rule. Downloaded official material was kept in an ignored local directory (`.qa/user03-20260930-a/`) and
is not committed; see the execution's RESULT for the retained hashes.
