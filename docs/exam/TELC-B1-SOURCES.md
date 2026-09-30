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

**Edition / date (S2):** „13. Auflage 2020 · © 2020 by telc gGmbH, Frankfurt am Main · Printed in Germany" (S2, PDF p. 4 = printed p. 2).
Bibliographic identifiers recorded on that page: Testheft ISBN 978-3-933908-02-5, order no. 5061-B00-010301;
Audio-CD ISBN 978-3-933908-93-3, order no. 5061-CD0-010101.

**Page-index convention (important).** S2's PDF page numbers run **exactly two ahead** of its printed
page numbers: PDF page *N* = printed page *N* − 2 (e.g. the test-format table is PDF p. 7 = printed p. 5;
`Punkte und Gewichtung` is PDF p. 41 = printed p. 39). The PDF's own table of contents (PDF p. 6 = printed p. 4)
lists printed page numbers. **Rule citations below give both**, in the form `S2 PDF p. 7 / printed p. 5`.

**Reuse rights (separate gate).** S2 carries an explicit copyright notice: „Diese Publikation und ihre Teile
sind urheberrechtlich geschützt. Jede Verwendung in anderen als den gesetzlich zugelassenen Fällen bedarf
deshalb der schriftlichen Einwilligung des Herausgebers." (S2, PDF p. 4 / printed p. 2). The material is
**publicly downloadable, which is not permission to copy** exercise texts, answer keys or audio into the
product. This register therefore paraphrases rules and does not reproduce passages, keys or audio.

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

| ID | Unresolved | Detail |
|---|---|---|
| U1 | **Official test specification / Prüfungsordnung not read** | Only the exam page (S1) and the practice test (S2) were consulted. The binding exam regulations and the official test specification (`Prüfungsordnung`, linked from S1's footer as „AGB und Prüfungsregularien") were **not retrieved**, so every rule above is sourced from the practice test and the public exam page. Whether those two are fully current and authoritative for the live examination is **not verified**. |
| U2 | **Version currency** | Edition retrieved is „13. Auflage 2020". A newer edition may exist. `PILOT_BUILD_PLAN.md` itself instructs: „Recheck versions before implementation and release." |
| U3 | **Objective answer rules for multiple choice** | The model test's printed instructions for the MCQ parts do not state a penalty for wrong answers or a guessing policy. **Not verified** whether marks are deducted for incorrect answers. Only correct/incorrect per item is assumed, which is **not** confirmed by the sources read. |
| U4 | **Distractor / no-match semantics for Sprachbausteine Teil 1 and Leseverstehen Teil 2** | The no-match (`x`) rule is stated only for Leseverstehen Teil 3, and single-use is stated only for the matching parts (LV Teil 1, LV Teil 3, SB Teil 2). What the learner should do when no option fits in Sprachbausteine Teil 1 or Leseverstehen Teil 2 is **not addressed** in the pages read. |
| U5 | **Part-level timing split inside the 90-minute block** | S1/S2 state 90 minutes shared by Leseverstehen and Sprachbausteine with no break. **No sub-allocation** between the two subtests is given. |
| U6 | **Hörverstehen timing detail** | S1 says „ca. 30" minutes; the model test's own pages do not break that 30 minutes into per-part durations beyond the announced reading pauses. |
| U7 | **Grade-band boundary exactness** | Bands as printed: 270–300, 240–269.5, 210–239.5, 180–209.5, 0–179.5. The `.5` endpoints imply half-point totals; how the written aggregate produces fractional totals is not explained on the page read (the written subtests are integer-valued; the oral criteria are integers). Treated as printed, **not** interpreted. |
| U8 | **Differences from DTZ / telc Deutsch B1 Schule and other variants** | Explicitly out of scope for the sources read. No comparison is asserted. |
| U9 | **Speaking subtest details** | S1 gives approx. 15 minutes and typically 2 participants with 20 minutes preparation; the oral criteria (four, not three) and M10 rating sheet appear in S2. These are recorded only to justify excluding oral results from written claims, and are **not** developed into a blueprint, since speaking is out of pilot scope. |

---

## 9. What this register deliberately does not contain

No exam texts, no answer keys, no audio transcripts, no audio files, and no reproduction of the model
test's items. Rules are paraphrased; the few quotations included are short and are used to pin an exact
rule. Downloaded official material was kept in an ignored local directory (`.qa/user03-20260930-a/`) and
is not committed; see the execution's RESULT for the retained hashes.
