# Claude feedback on the multi-exam plan

Execution **EXAM-ARCH-CLAUDE-20261002-B**, 2 October 2026. Ron requested feedback and recommendations from Claude on [the architecture proposal](MULTI-EXAM-ARCHITECTURE-20261002.md), draft [PR100](https://github.com/ronslink/hatoove/pull/100).

**Adopted afterwards — EXAM-ADOPT-20261002-A:** Ron said, "we are only delivering mock exams as part of a preparation effort not a true exam lets adopt the recommendations from claude". The linked plan now incorporates the recommendations with the recorded coordinator qualifications below, and the pilot/master plans, D9 and tracking records agree. This memo preserves what Claude actually reviewed; it is not a claim that Claude reviewed the later adoption diff. The coordinator added the minimal saved mock-form/run contract to fulfil Ron's clarified product intent.

**Ron's subsequent decisions override the earlier defaults below:** "no we will release dtz fully , listening playback in practice once and exam mode once . Credit is for one exam only". Internal vertical development remains; DTZ releases with all supported written sections together. Each DTZ recording plays once per attempt in either mode. Credits are exam-package-specific, not an account-wide pool. Claude did not review these later user decisions.

## Provenance and scope

The actual installed Claude Code CLI 2.1.286 reported model **claude-opus-5-5**. It successfully completed one plan-only review with all tools disabled; no repository source, databases or external sites were available to it. Input was the proposal at commit `7a7caa06acc6ed9b9e08e80504af19de42de2056`, SHA-256 `1316b4b4da6a24f04d1706484922ca1776f591531edb644731034cad7c250c26`. Claude explicitly acknowledged those limits. Its code references therefore refer to findings supplied in the proposal, not an independent code audit.

This is a curated account of Claude's recommendations and the coordinator's response, not a raw provider log. The original proposal was unchanged when this review was recorded; the later adoption updates it explicitly. Neither the review nor adoption implements features, grants educational approval or changes the running pilot's content policy.

## Claude's verdict

> Approve the direction. Revise the sequence and trim the abstraction.

Claude supports one application, one PostgreSQL schema and the account/preparation/package distinction. It particularly supports exact version binding, per-tab context, draft preservation, separate DTZ rubric contracts and the existing scope limits. Its main criticism is that the original EXAM-01–06 sequence separates layers too much and could postpone a working learner journey until too late.

## Recommendations and coordinator assessment

| Claude recommendation | Coordinator response |
|---|---|
| Fix version handling, bootstrap ordering and criterion-specific validation before adding DTZ; make content serving approved-only by default. | **Separate the hardening work and qualify the policy suggestion.** Exact versions, correct bootstrap ordering and per-criterion validation are sound early work. Their present impact differs: do not describe every future-package limitation as a demonstrated failure today. The pilot deliberately serves labelled unreviewed generated material; a blanket policy change could empty it. Introduce explicit preview versus reviewed-release gates before DTZ exposure rather than silently changing the agreed pilot. |
| Bind a preparation to `exam_id`; resolve the released blueprint for each new attempt, which pins its exact versions. | **Adopt the simplification in the next contract draft.** Avoid an obligatory blueprint-upgrade lifecycle on every preparation. Preserve a deliberate rule for incompatible official format changes or variants, so a learner booked for an older format is not silently moved. Old attempts and historical results never change. |
| Deliver telc as a preparation first, then DTZ reading, writing and listening as vertical slices. | **Adopt.** Prove ownership, date migration, routes, history, export/delete and per-tab isolation with telc first. Exercise upgrade preservation with synthetic historical fixtures before any live migration. Add visible Start/Continue actions as part of the learner journey, not just a new database abstraction. |
| Defer the synthetic third band-scale exam and generalise from two real packages. | **Partly adopt.** Defer building or releasing a third package. Retain a tiny non-German/alternative-scale contract fixture: two German exams alone cannot demonstrate the language independence Ron requested. This should be a small negative test, not another product stream. |
| Use one explicit package-release manifest instead of multiple overlapping release/version/targeting systems. | **Adopt a smaller initial release contract.** One release identifies the exam, blueprint, exact content membership, section states and publisher/hash/time. Preserve separate rights/review decisions. An `internal` state still needs a server-enforced audience/environment rule; it must not become a client-only preview flag. Avoid a generic rollout platform. |
| Skip the chooser when only one exam is available; auto-save on switching and show recovery choices only if saving fails. | **Adopt with clear exam visibility.** A real two-exam choice must be explicit; a one-option onboarding screen adds little. Always show the exam name. Auto-save and switch only after acknowledgement; conflicts, offline or uncertain responses preserve text and context. Do not delete saved drafts. Keep adding another available preparation discoverable even when only one is currently enrolled. |
| Define private answer-key/transcript storage; consider separate private or encrypted sources. | **Clarify the publishing boundary without adding unnecessary infrastructure.** The repository is private, and authoring source is distinct from browser-served content. Separate public payload and private key/transcript inputs in the importer and test deployment/DTO exclusion. A new encrypted store is not established as necessary by this review. |
| Count and classify actual old records before building elaborate legacy mapping machinery. | **Adopt the proportional approach.** Use the simplest audited telc backfill where identity is provable. Keep an explicit safe outcome for ambiguous bindings; never guess or drop records. Build a special mapping path only if the inventory requires it. |

## Claude's proposed revised order (now adopted as EXAM-S0–S6)

1. **Hardening:** exact objective versions, version-specific evidence, bootstrap/context ordering and assessment-scale validation. Specify release visibility separately from the current internal content policy.
2. **Telc preparation journey:** preparation/date model, safe legacy classification, verified-session bootstrap, explicit routes/API context, Start/Continue, history and account-wide export/delete. First validate in disposable fixtures.
3. **Minimal package/release contract and importer:** extract the telc blueprint, validate DTZ fixtures and a small language-independence check. Start original DTZ content authoring and qualified review once schemas are stable.
4. **DTZ reading vertical slice:** small reviewed content set, mixed-question/grouped-stimulus rendering, exact version marking, exam chooser/switcher, save/recovery and history. Internal until its release acceptance passes.
5. **DTZ writing:** exact selected prompt, four-criterion policy, preserved drafts/submissions/revisions, and clearly limited feedback. Live grading stays behind the existing evaluation/privacy/cost gates.
6. **DTZ listening:** version-aware media access, reviewed fixed recordings, playback policy and recovery. Complete real-device/audio and cross-exam acceptance before the corresponding release.

Responsive, keyboard, accessibility and applicable real-device checks belong to each learner-facing slice, not a final cleanup phase. Listening audio and qualified review remain independent dependencies; they do not block internal reading/writing engineering, but all are mandatory before the complete DTZ learner release Ron selected. No schedule estimate is asserted from this review.

## Product choices and adopted defaults

- **Complete DTZ release:** Ron rejected a partial learner offer. Reading/writing increments remain internal; all supported written sections, including reviewed fixed listening, release together after full acceptance.
- **Listening playback:** Ron chose one play per DTZ recording per attempt in both practice and mock-exam mode. Persist the allowance across interruption/return without introducing proctoring or claiming DRM.
- **Exam-specific credit:** Ron rejected shared credit. Bind allowances/usage to the selected exam package; no pooling, transfer or refill on switching or creating preparations. Preserve existing balances during the exam-scoping migration. Offer pricing/quantities remain separate from this binding rule.

These are release/experience choices. Ordinary module boundaries, SQL date storage, pagination and the importer design do not need another permission round.

## What remains unchanged

No new application, framework or microservices. No account per exam. No automatic conversion between rubrics or reassessment after changing explanation language. No speaking/STT, whole-exam pass predictions, production deployment or live-provider activation. Original content needs qualified educational review and rights evidence; an AI review cannot supply either. Preserve historical migrations, learner records and immutable submissions.

The adopted plan now replaces the horizontal sequence, simplifies preparation/release bindings and adds saved mock runs with exact versions and deferred feedback in timed mode. The next slice is EXAM-S0 hardening, under its own bounded assignment. No implementation lease or completed browser change follows from this review memo alone.
