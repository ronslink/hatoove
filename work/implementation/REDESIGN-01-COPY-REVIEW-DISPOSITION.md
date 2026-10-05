# REDESIGN-01 — disposition of the uk/ar/tr interface copy review (5 Oct 2026)

The review covered every interface string on `codex/redesign-01-studio-look` @ `d2f9501` in six catalogues.
It states plainly that it is **an AI language review, not the native-reviewer sign-off `AGENTS.md` requires**.
This document records what was done with each finding, so nothing in it is lost and nothing is silently
"fixed" by an agent that cannot judge the language.

## What was verified independently before acting

The review's claims were checked against the files rather than taken on trust. A scan of all six catalogues,
parsing both shapes (`key: [de,en,uk,ar,tr]` and the per-language blocks), reports **741 five-language rows**
and found the same three script-level defects the review did, now at zero:

| Defect | Where | Verified |
| --- | --- | --- |
| Arabic question mark in a Ukrainian string (`؟` U+061F) | `public.faqListening` uk | yes, and fixed |
| Arabic-Indic digits `٢٠٠٠` | `shell.m359` ar | yes, and fixed to `2000` |
| German word left in a Turkish string (`Formular`) | `practice.form` tr | yes, and fixed |

**The `practice.form` defect was caused by this branch's own copy audit** and the review is right about that.
The audit flagged "a uk/ar/tr entry identical to English while containing Latin letters" and I changed Turkish
`Form {form}` → `Formular {form}`. `form` **is** the Turkish word, and the value was already correct. The audit
rule was wrong: identity with English is not evidence of a missing translation, and for a word that exists in
both languages it is evidence of nothing at all. The rule is fixed here by not applying it to a word that is
Turkish; the audit document now carries that correction.

## A. Errors — all fixed

| Key | Lang | Now reads |
| --- | --- | --- |
| `practice.form` | tr | `Form {form}` (restored) |
| `public.faqListening` | uk | `Як працює аудіювання?` |
| `shell.m129` + `m130` | tr | `Bu bölüm için şu anda içerik yok.` |
| `shell.m122` + `m123` | tr | `Bu durum, sunucudaki cevap kayıtlarınızı yansıtır.` |
| `shell.m374` | uk | `Де ви ввійшли. Якщо завершити сеанс, вихід відбудеться лише на тому пристрої.` |
| `shell.m372` | ar | `يؤدي الحذف إلى إزالة سجلاتك نهائيًا. لا يمكن التراجع عن ذلك.` |
| `shell.m359` | ar | `حتى 2000 حرف` |

The two Turkish fragment pairs were verified by **reassembling them**, which is the only way to see the defect
the review describes: `m129`+`m130` previously produced "Content is missing for the following section:
currently." and `m122`+`m123` produced a sentence with no verb.

## C. The six REDESIGN-01 strings — count forms aligned

The review is right that German uses "von" in all three count strings while uk and ar had switched to a slash
for two of them but not for `partResult`. They now use one form per language:

| Key | uk | ar |
| --- | --- | --- |
| `m390` | `Відповіді: {answered} з {total}` | `تمت الإجابة عن {answered} من {total}` |
| `m391` | `Правильно: {correct} з {total}` | `{correct} من {total} صحيحة` |
| `partResult` | `Частина {part}: правильно {correct} з {total}` | unchanged |

`m388` tr (`doğru cevap:`) is **not** changed here — that is the terminology decision in B, below.

## B. Terminology consistency — needs the native reviewers, not an agent

These are the review's own judgement calls about which word a language should standardise on. An agent cannot
decide them, and the review itself says they are "not wrong in isolation". They are listed here as **their**
agenda, with the review's recommendation intact:

| Concept | Lang | Recommend | Why it matters |
| --- | --- | --- | --- |
| Guthaben / credit packs | uk | `пакети кредитів`/`кредити` (not `пакети занять`) | "lesson packages" misdescribes the product |
| | tr | `kredi`/`krediler` (not `haklar`) | "entitlements" is legal vocabulary |
| Answer | tr | `yanıt` everywhere | **most urgent**: `m388` "doğru cevap:" and `practice.correctAnswer` "Doğru yanıt:" can appear side by side on the REDESIGN-01 screens |
| Run | uk | `спроба` | `проходження` vs `спроба` split between shell and practice |
| Run | ar | `محاولة` | `تدريب` vs `محاولة` split |
| Pilot | ar | `التجربة المحلية` in `m151` | one key still says `الاختبار المحلي` |
| Blocked | ar | `مقفل` or `غير متاح حاليًا` | `محظور` reads as "prohibited/banned", punitive for a learner |
| Scoring band | tr | `Düzey` (not `Bant`) | tape/band |
| Rubric | uk | `критерії оцінювання` (not `рубрика`) | "рубрика" is a column or heading |
| `shell.m318` | uk | `Ваш прогрес` (not `Ваш результат`) | "result" implies the score the product avoids |

But the review also lists per-key replacements, not just per-word ones — `مقفل`, `Düzey`, `Частина {part}`
phrasing, `Якщо завершити…`, `arabic m390/m391`, `public.review`, `public.grammarOpen`, `public.toolError`,
`public.faqWriting`, `practice.discardConfirm`/`notDiscarded`/`ui25`, `practice.rubricNotice`/
`rubricNoticeTelc`, `practice.partPosition`, `practice.answerCount`, `practice.revise`/`shell.m171`,
`auth.delivery`, `shell.m050`/`since`, `practice.reviewLegacy`, `public.checklist0-4`, `public.faqForgot`,
`practice.ui12`. Those are three languages × many keys of wording that a fluent speaker must confirm. Applying
them by agent would be exactly the mistake that produced `Formular`.

## D. Plurals — a real code change, not a copy change

`core.js` interpolates `{count}` with no plural selection, so Ukrainian and Arabic strings are wrong for some
numbers ("1 днів", "3 днів" should be "1 день", "3 дні"). Turkish is unaffected (no plural after a numeral).
Two ways out, both real work:

1. **Proper:** add plural forms to the catalogue and select with `Intl.PluralRules(locale)` in `core.js`. This
   touches the i18n core, every count key in three languages, and needs its own checks.
2. **Cheap:** reword the count strings so no agreement is needed — label-first phrasing such as
   `Днів до іспиту: {count}` or `الأيام المتبقية: {count}`.

This is **not** done here. It belongs in its own slice with its own reviewer, because the proper fix changes a
shared module and the cheap fix changes copy in three languages.

## E/F. Wording notes and the German source

Recorded, not acted on. Two of them are worth the user's attention because they are **product** decisions
rather than translation:

- `public.*` mixes German **du** with **Sie** in the sample block. uk/tr hide this (they use Ви / siz), so it is
  a German-source inconsistency, not a translation defect.
- The shell still says "Pass" in six keys (`m016`, `m218`, `m234`, `m244`, `m355`, `passFor`) while the pricing
  is a free pilot window followed by credit packs. The review flags that as possibly out of date — that is a
  product decision before it is a translation one.

## What this means for the pull request

The fixed items are mechanical: wrong script, broken grammar, a sentence with no verb, a tautology, a
regression this branch caused, and one inconsistent count form. They are committed with the checks re-run.

**The uk/ar/tr copy still needs its native sign-off.** Nothing here changes that, and section B is the list
those reviewers should work from.
