# REDESIGN-01 slice F — five-language copy audit

Status: **audit done and machine-checked; the wording of uk/ar/tr still needs Ron's native reviewers.**

## What was checked, and how

Two dictionaries carry every interface string:

| File | Shape | Entries per locale |
| --- | --- | --- |
| `public/assets/i18n/shell-messages.js` | one object per locale | 438 keys × de/en/uk/ar/tr |
| `public/assets/i18n/practice-messages.js` | one row per key, five values in order | 303 rows × 5 |

The audit was run as code, not by eye, and the result is:

- **Key sets are identical in all five locales, both files.** Zero missing keys, zero extra keys.
- **Every practice row carries exactly five values.** Zero rows with the wrong shape.
- **Placeholder shapes agree.** A key whose German string has `{count}` has `{count}` in all five, so no
  locale can render a literal `{count}` to a learner.
- **One untranslated string was found and fixed.** `form` read `Form {form}` in Turkish, which is the English
  word: it now reads `Formular {form}`, matching the German column. This was the only uk/ar/tr entry whose
  text was identical to English while containing Latin letters.

  > **CORRECTION (5 October 2026).** That "fix" was wrong and has been reverted. `form` **is** the Turkish
  > word; translating it to the German `Formular` broke correct copy. The rule that produced it — "identical
  > to English while containing Latin letters means untranslated" — is not sound: for a word that exists in
  > both languages, identity with English is evidence of nothing. The audit's structural checks remain
  > useful; that inference did not. See `work/implementation/REDESIGN-01-COPY-REVIEW-DISPOSITION.md`.
- `tools/shell-locale-check.mjs` (24 checks) and `tools/practice-locale-check.mjs` (18 checks) both pass, and
  they are what hold this state: the first fails if the five shell dictionaries drift apart, the second
  asserts the locale hooks and the practice catalogue.

## What the audit does NOT establish, and must not be read as

1. **It does not make the uk/ar/tr copy reviewed.** Every check here is structural — the same keys, the same
   placeholders, no Latin-only duplicate. A string can satisfy all of that and still be wrong, rude or
   misleading. `AGENTS.md` is explicit: qualified human review remains necessary, and the machine-written
   strings added by this slice are marked for review below.
2. **It says nothing about the German or English wording** beyond internal consistency.
3. **Exam-language content is deliberately out of scope.** German task text, passages, statements and the
   exam's own directions are authored content and are never translated by the interface-language setting;
   `AGENTS.md` and `docs/contracts/PILOT-I18N-INTERFACE.md` require that, and the Arabic RTL islands keep the
   German fields explicitly `lang="de" dir="ltr"`.

## Strings added by REDESIGN-01 that need native review

| Key | File | German (source) | Note |
| --- | --- | --- | --- |
| `m388` | shell | richtige Antwort: | the label on the revealed answer |
| `m389` | shell | Weiter üben | the orange primary action, taken from Ron's own words |
| `m390` | shell | {answered} von {total} beantwortet | the run navigator |
| `m391` | shell | {correct} von {total} richtig | the part result |
| `m392` | shell | Dieser Abschnitt ist abgeschlossen | the part-result heading |
| `partResult` | practice | Teil {part}: {correct} von {total} richtig | the mock result's per-part line |

The uk/ar/tr values for these six are machine-written. They are not "reviewed copy" and must not be labelled
as such; Ron's native reviewers decide them.

## Deliberately not changed

- **Impressum and Datenschutz** stay blocked until the operator entity exists. No copy was invented for them.
- **The FAQ line about personalized explanations.** The landing graphic proposal flags a possible
  inconsistency between "personalisierte mehrsprachige Erklärungen sind noch nicht freigeschaltet" and a
  sample that shows a fixed curated explanation. That is a product-copy decision for Ron, recorded in
  `work/implementation/REDESIGN-01-LANDING-GRAPHIC.md` §12.2, not something to quietly reword here.

## The factual claims, checked across all five languages

The landing page makes claims about time, money and what stays free. Those were checked mechanically, because
a claim that survives in one language and drifts in another is the kind of defect no structural audit sees.

| Key | Carries | Agrees in all five? |
| --- | --- | --- |
| `description`, `ogDescription` | free until 14 January 2027, credit packs after | yes |
| `pilot`, `createDescription` | free until 14 January 2027 | yes |
| `listeningDescription`, `faqListeningAnswer` | listening belongs to the credit packs | yes |
| `faqFreeAnswer` | free until 14 January 2027 · no payment details needed · credit packs after · the free test that remains · writing-feedback limit · conditions on page and in app | yes |

One flag was raised by the check and then **withdrawn after reading the string**: the Arabic
`faqFreeAnswer` did not match a naive "payment details" pattern, but it does carry the claim as
`بيانات دفع` — different word order, same meaning. That is recorded because the check's limits matter as much
as its findings: a regex over five languages produces false positives, and the answer to one is to read the
text, not to reword it.

What this does **not** establish: that the claims are the right business decision, or that the wording reads
well. It establishes only that the five languages say the same thing.
