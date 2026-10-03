# EXAM-S5B: complete written mock contracts

Execution EXAM-S5B-20261003-A, after reviewed S5A source d95c49d. Internal engineering only: generated technical signals and unreviewed content cannot become an approved or publicly available full mock. S4 and payments remain unmerged behind the hosted CI account block.

## Assigned writing

New optional form `writingTask:{section:'writing',taskId,taskVersion}` is mutually exclusive with `writingChoices`. It is supported for telc's `extended_writing` part only. Existing DTZ choice payloads remain byte-identical. Exact task and rubric versions, language and exam are validated; known `writing.telc-b1@v1` is reused without relabelling criteria or importing a conflicting rubric.

Migration0031 adds `mock_writing.binding_kind` (`choice` default, or `assigned`) and permits null choice_group_id/selected_option_id only for assigned bindings. The SQL trigger proves the pinned form's exact assigned task/version matches the same owner's attempt/preparation/exam/rubric. Start creates one assigned attempt and empty draft in the same transaction before the start receipt; replay/concurrency returns the same attachment. No choice request can replace an assignment.

Public bundle adds `writingTask:{section,task}`; run DTO adds `writing_task:{section,task}`. Attachment DTO adds `binding_kind`; assigned choice fields are null. Client renders assigned prompt/editor directly, with no A/B chooser. Index adds `writing_task_count` (0 or1), existing `writing_choice_count` unchanged. Finalisation handles either kind and preserves empty/unassessed/exhausted states and exact submitted text. It never implies a /45 or whole-exam pass result.

Worker task/attachment lookup must be independent of built-in rubric recognition: all package-attached writing resolves the exact full task and checks pinned release/rights before grading and inside assessment/debit commit. Seeded historical telc behavior stays compatible. No external provider is called by this implementation.

## Ordered server timing

New complete form: `scope:'complete_supported_written',mode:'timed',attemptMode:'mock',timingPolicy:'ordered-fixed-v1'`. Its blueprint has strictly validated ordered `timeGroups:[{id,seconds,sections}]`; each section names its group via `timeGroup`. One immutable cumulative schedule starts with run creation. No pause, reset, clock extension or early group advance API is added. The interface explicitly explains that groups change automatically at fixed times.

Target schedules and coverage are fixed:

| Exam | Ordered groups | Required objective families/counts | Writing |
| --- | --- | --- | --- |
| telc-deutsch-b1 | LV+SB5400s, HV1800s, writing1800s | LV1/2/3=5/5/10; SB1/2=10/10; HV1/2/3=5/10/5 | one assigned prompt |
| dtz-a2-b1 | HV1500s, LV2700s, writing1800s | HV1/2/3/4=4/5/8/3; LV1/2/3/4/5=5/5/6/3/6 | existing one A/B group |

Existing section forms retain their current single-deadline behavior. Public complete-form acceptance cannot be achieved by a shortened blueprint, repeated family, different section identity/order, weakened playback or missing writing/media/rubric reference. Complete objective results contain60/45 raw items respectively and remain separate from writing feedback. The engine rejects unsupported complete formats.

Migration0032 creates owner-protected immutable `mock_run_time_group(owner_id,run_id,ordinal,group_id,sections,starts_at,deadline_at)` with FK to exact owned run, uniqueness(run_id,ordinal) and(run_id,group_id), FORCE RLS and explicit deletion/export coverage. The pinned blueprint creates all rows inside run start. No request accepts timestamps or a timing policy. SQL independently validates inserted schedule against pinned form/blueprint and created_at. Whole-run deadline equals the last group deadline.

Run DTO `timing:{policy:'ordered-fixed-v1',active_group_id:string|null,groups:[{id,sections,starts_at,deadline_at}]}` or null for legacy section runs. The current group is derived using server_now, never stored in browser state. `member.section` is included to map questions to groups. Content may be read for the saved run under existing rights rules; only the active group's responses can change. Past/future questions are visibly read-only. Writing is writable/choosable only in its group. Finalisation is available at any point as an explicit irreversible finish and after expiry using acknowledged work.

API and restricted SQL independently enforce active-group changes. A submitted full response snapshot must retain closed/future answers exactly; adding/changing/removing by omission outside active group is rejected with `mock_group_inactive`. Cursor movement is read-only navigation and may remain available. Group-gated writing draft/choice and media GET/HEAD/playback events return the same409 error. At listening group close, audio halts and terminal refusal releases navigation without pretending unsaved progress was confirmed. An in-flight delivered blob cannot be revoked remotely; client clock stops it and subsequent server calls refuse. Finalisation may close a listening row implicitly by making the run finalised; no new allowance is granted.

Client derives active group from server offset/windows, refreshes run state at boundaries, and switches the active workspace to the next group while retaining explicit copies of unsaved objective/text changes if a boundary races a save. Never silently discard local work. Preserve all existing session/preparation/route/receipt fences. Full mock labels differ from section practice; no complete preparation or pass claim. Both themes, desktop/mobile, keyboard and expiry/recovery evidence are required.

## Ownership and checks

Package writer: server/package-contract.mjs, owned-postgres/package-importer.mjs, packages.mjs, new exam-s5b-package checks. Backend writer: migrations0031/0032, mock-contract.mjs, owned-postgres/mock-runs.mjs, mock-writing.mjs, playback.mjs, adapter.mjs, new exam-s5b-backend checks. Client writer: public/app/mock.js, listening.js, writing.js, app.js, app.css and new exam-s5b-client checks. Coordinator: worker.mjs + focused worker checks, synthetic composed full fixtures, migration manifest/classifier, CI/OpenAPI/browser harness and records. Coordinate contract changes before writing overlapping paths. Separate author branches/worktrees and independent review remain mandatory.

Required negatives: concurrent/retried assigned starts produce one draft; wrong task/exam/version/rubric blocked; unchanged schedules across refresh/device/clock; edits/removals outside active window refused in API/SQL; media and draft bypasses refused; group-end playback retains allowance;60/45 complete result items; writing empty/exhausted/failure/withdrawal preserve text and refund reservation; forward migration preserves old runs and immutable content bytes; export/delete cover schedules. Tests use synthetic disposable PostgreSQL and source-only Compose. Shortened timing is test-only, produced through explicit fixture seams without weakening target format validators.

S6 shared current-release eligibility, DTZ discovery/direct start/payment gating and human content/device gates remain follow-on work. Default runtime stays telc-only; no production activation or publication is authorized.
