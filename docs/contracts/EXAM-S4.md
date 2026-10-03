# EXAM-S4 internal DTZ writing contract

Execution **EXAM-S4-20261003-A**, [issue 113](https://github.com/ronslink/hatoove/issues/113), base `40702692`. This slice adds internal writing practice to the saved-run contract. Default catalogue and startup imports remain telc-only. Complete DTZ release remains gated by S5/S6 and human acceptance.

## Versioned package

`content/exams/dtz-a2-b1/writing-manifest.json` is blueprint/release v3, with `state: internal`. Import the unchanged S3 reading manifest first, then this manifest. It contains two original writing tasks and one distinct DTZ rubric; it reuses the five exact S3 objective members without changing them.

| Form | Sections | Scope |
| --- | --- | --- |
| `dtz-a2-b1.writing.original01@v1` | SA | Untimed writing-only section practice |
| `dtz-a2-b1.reading-writing.internal01@v1` | LV, SA | Untimed partial reading and writing practice |

Both forms have one `writingChoices` group, `SA1`, with options A and B pointing to exact task IDs and versions. A concerns a damaged transport pass; B concerns helping a neighbour. Both have four neutral content points. No form claims `complete_supported_written`; all tasks and rubrics remain generated/unreviewed. An import cannot grant itself educational approval.

## DTZ rubric and assessment policy

The [source verification](../exam/DTZ-WRITING-SOURCES.md) records the official reference and its limits. The rubric is `writing.dtz-a2-b1@v1`, policy `dtz-writing-practice-v1`, feedback kind `dtz-writing-bands`. Its criterion keys are `dtz_aufgabe`, `dtz_kommunikation`, `dtz_korrektheit` and `dtz_wortschatz`.

Each criterion has its own descriptors and labels for `B1_PLUS`, `B1`, `A2_PLUS`, `A2`, `A1`, `ZERO`, mapping to 5, 4, 3, 2, 1, 0. The learner sees per-criterion positions, with no total, pass prediction or whole-exam result. No fixed minimum word count or universal formal-address rule is introduced. The no-meaningful-connection rule is part of the DTZ policy; the synthetic grader does not claim to detect it.

The real worker receives the immutable full prompt, selected option, rubric and policy. Unknown policies and invalid criterion scales fail before accepting feedback. The default worker catalogue refuses internal DTZ; fixtures enable it explicitly on the server. Simulation is clearly labelled and uses fixed example positions, not text length or error counts as proficiency evidence. No live provider is activated by S4.

## Immutable selection and saved writing

`POST /api/v1/mock-runs/:id/writing-choice` accepts exactly `{expectedRevision, eventId, choiceGroupId, optionId}`. The server resolves the choice from the pinned form, creates an attempt and draft atomically, increments the run revision and returns the full run DTO. A receipt makes an identical retry idempotent. A different body under the same event conflicts. An acknowledged A/B choice cannot be replaced.

The run DTO adds:

```text
writing_choices: [{id, section, options: [{id, task}]}]
writing: null | {
  choice_group_id, selected_option_id, attempt_id, draft_revision,
  submission_id, assessment_state, failure_code
}
```

`task` uses the existing writing task DTO. Assessment state is `not_started`, `pending`, `assessed`, `failed` or `unassessed`. Objective members/results remain separate; a writing-only result is null and never renders 0/0.

The initial attempt has `mock_run_id`; history reopens that run. Revision attempts retain the task/rubric/exam and `parent_submission_id`, have no direct `mock_run_id`, and never replace the run's frozen attachment. Recursive origin lookup retains the originating release's rights restrictions through every revision generation. Direct standalone submission or deletion of an attached active-run attempt is refused; the run owns finalisation.

## Finalisation and credit

After writing selection, finalisation requires `explanationLanguage` (`de/en/uk/ar/tr`) and `expectedWritingRevision`. The client flushes writing and objective work, then sends the acknowledged revisions. It also sends its language preference for an unselected writing form, though the server does not require it without an attachment. The server atomically freezes submission, objective snapshot, reservation and job using the shared owner/run lock order.

An unselected or empty writing part may finish unassessed. Selected empty text still gets an immutable submission, with `empty_submission` and no job/reservation. Exhausted selected-exam credit also preserves the submission, with `allowance_exhausted`, and leaves completed objective results intact. Neither case spends another exam's allowance.

Successful feedback debits the selected exam once. Thrown or malformed grading refunds its reservation and keeps the original submission and objective results. Retry keeps the same immutable submission. Existing standalone telc behavior remains unchanged.

## Ownership, publication and client recovery

Discovery, direct IDs, rubric reads, mutations, worker calls/results and export obey server catalogue, release and rights controls. Owned text/history survive withheld content. Ordinary withdrawal permits eligible pinned resume; an explicit rights block hides protected prompts/rubrics/feedback and prevents grading, including descendants whose task is reused in a later release. Account deletion removes the attachment and owned writing data, fences concurrent writers and prevents late worker resurrection.

The existing writing controller supports attached mode. The client shows both full German prompts before selection, then identifies the bound task. Switching waits for both saves; offline failures and stale-tab conflicts retain the local text and original exam context. Completed runs retain original text, pending/failed/unassessed states, retry and revision controls. Rubric labels and bands come from the bound DTO. No automatic content-point ticks or total is added.

## Acceptance boundary

Offline and PostgreSQL fixtures cover exact imports, cross-exam references, immutable choices, unequal criterion scales, grader input, races, idempotence, credit exhaustion, failure/refund, ancestry rights, history/export and deletion. Browser evidence covers desktop and 390/320 px layouts, both themes, keyboard focus, failed saves and independent documents. Source-only fixtures use synthetic accounts, isolated ports and no repository `.env` or live provider. Learner ports 4300/55440 and existing data volumes are excluded.

Rendered Chromium evidence does not replace physical iPhone/Android acceptance. Qualified educational, translation, rights, security/privacy/provider/legal and product approvals remain separate.
