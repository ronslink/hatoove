
    -- REVIEW-OWNER-APPROVAL-01 — the product owner's blanket approval of everything currently
    -- unreviewed, recorded through the 0035 named-review state machine.
    --
    -- WHAT WAS INSTRUCTED, AND BY WHOM. Ron (the product owner) instructed on 5 October 2026:
    -- "the catalogue rows should all be marked as reviewed if they haven't been yet", and confirmed
    -- the scope as EVERYTHING CURRENTLY UNREVIEWED with the reviewer of record being Ron, product
    -- owner. This file is that instruction, in the form the schema can hold.
    --
    -- THIS IS AN OWNER BLANKET APPROVAL, NOT A REVIEW. Nothing here says a named native speaker, a
    -- subject-matter expert or an agent read the strings. The rationale on every recorded decision
    -- says so in as many words, because a `content_review_decision` row is a permanent public fact
    -- about who decided what. There is no per-string evidence behind these decisions and none is
    -- claimed: the evidence artifact is the instruction itself, pinned by the sha256 of its own text.
    --
    -- WHY THE DECISIONS ARE DERIVED HERE RATHER THAN TYPED OUT. `resolve_review_subject()` is the
    -- only authority on a subject's identity (exam, subject kind, subject id, version, sha256,
    -- category, language) and on whether the subject exists at all. A hand-written VALUES list would
    -- be a second, silently-drifting copy of facts the database already owns, and a content hash
    -- typed by hand is exactly the mistake 0035 exists to prevent. So this migration asks the
    -- database for each subject and feeds the answer straight back into `append_content_review()`.
    -- Consequence worth stating: re-running it on a database with different content approves THAT
    -- content. It is an approval of "everything unreviewed at the moment it is applied", which is
    -- what was instructed.
    --
    -- ADDITIVE AND IDEMPOTENT. Every event id is a deterministic function of the subject identity,
    -- so a second apply replays the same events; the 0035 insert triggers recognise a replayed event,
    -- compare it to the stored row and return without inserting. No existing decision is superseded,
    -- no `reject`/`withdraw` is written, no row is deleted, and no immutable column is touched. The
    -- only UPDATEs are the two review columns 0042 created for exactly this purpose.
    --
    -- NOT TOUCHED, DELIBERATELY: `content_review_baseline` (immutable, trigger-guarded, and a record
    -- of what the 0035 import found — not a place to write a new decision), `content_version`
    -- (immutable: 0006 refuses the UPDATE), and `content_rights`. `reviewed_content_version` is a
    -- view, so the projection moves because the decisions exist, not because anything was rewritten.
    --
    -- HONEST LIMITS, so the next reader does not have to guess:
    --   * the machine-translated uk/ar/tr rows in `guide_translation` / `noun_translation` become
    --     `approved` on the owner's instruction, NOT because anyone checked them against the German.
    --     That is what removes the client's "Prüfung ausstehend" marker, and it is a product decision
    --     with a real consequence: a learner will no longer be told the text is unverified.
    --   * `content_review_baseline` carries NO row for a `blueprint` or a `form` subject in this
    --     database, so both project `unreviewed`/`basis=none` rather than the `approved`/legacy status
    --     0035's INSERT would have given them had the tables been populated when it ran. They are in
    --     scope here because `form_review_allowed(exam, form, version, true)` reads them and refuses
    --     the whole form while either is not a named approval.
    --   * a content subject that does not resolve at all cannot be approved, because there is no
    --     identity to approve. Rather than skip it quietly, the block raises
    --     `review_subject_unavailable` and the whole migration fails, so an unresolvable row is a
    --     decision for a human and never a silent hole.

    DO $review_owner_approval$
    DECLARE
      -- The product owner, and the instruction this file implements. `v_instruction` is the evidence
      -- artifact: its sha256 is what every recorded decision points at. The `v_` prefix keeps every
      -- one of these out of the way of the identically named columns the review tables carry.
      v_reviewer_id    constant text := 'ron-product-owner';
      v_reviewer_name  constant text := 'Ron (product owner)';
      v_instruction    constant text := 'Ron (product owner), 5 October 2026: "the catalogue rows should all be marked as reviewed if they haven''t been yet" — scope confirmed as everything currently unreviewed, reviewer of record Ron, product owner. Owner blanket approval, not a native-speaker or agent review of any individual string.';
      v_evidence_ref   constant text := 'instruction://ron-product-owner/2026-10-05/catalogue-rows-marked-reviewed';
      -- Exactly the same text that is recorded as `rationale` on every authority and every decision.
      -- One constant, so the two can never drift into telling two different stories.
      v_rationale      constant text := 'Owner blanket approval under Ron''s instruction of 5 October 2026 ("the catalogue rows should all be marked as reviewed if they haven''t been yet"). No per-string native-speaker review and no agent review of these strings is claimed or implied.';
      -- The moment the instruction was given, recorded in UTC (23:59:59 on 5 October 2026 in Berlin).
      v_instructed_at  constant timestamptz := timestamptz '2026-10-05 21:59:59+00';
      v_evidence_sha   constant text := encode(sha256(convert_to(v_instruction, 'UTF8')), 'hex');
      -- The approval event's own id namespace. Changing this string re-approves everything under new
      -- event ids; leaving it alone is what makes a second apply a no-op.
      v_event_ns       constant text := 'review-owner-approval-01/2026-10-05';
      a                record;
      d                record;
      head             record;
      json             jsonb;
      decided_count    integer := 0;
      granted_scopes   integer := 0;
    BEGIN
      IF length(v_evidence_sha) <> 64 THEN
        RAISE EXCEPTION 'review_owner_approval_evidence_sha_invalid' USING ERRCODE = '22023';
      END IF;

      -- 1. THE AUTHORITY GRANTS. One per (exam, category, language) triple that at least one subject
      --    actually needs — enumerated from `resolve_review_subject()`, never assumed. The 0035
      --    authority trigger enforces the language rule ('' for educational/exam_format, the exam
      --    language for audio), so a triple the schema would refuse cannot reach it from here.
      --
      --    `expectedAuthorityId` is NULL for every grant because 0035 seeds no authority at all.
      --    On a re-apply the event id already exists, the rebuilt payload still says NULL, and the
      --    trigger returns the stored row unchanged — which is the idempotence this file claims.
      FOR a IN
        SELECT DISTINCT ON (res.category, res.language)
               res.exam_id, res.category, res.language,
               md5(v_event_ns || '/authority/' || res.exam_id || '/' || res.category || '/' || res.language) AS key
          FROM (
            SELECT 'content'::text AS kind, NULL::text AS exam_id, c.content_version_id AS subject_id, ''::text AS version
              FROM content_version c
            UNION ALL
            SELECT 'blueprint', b.exam_id, b.exam_id, b.version FROM exam_blueprint b
            UNION ALL
            SELECT 'form', f.exam_id, f.form_id, f.version FROM exam_form f
          ) s
          CROSS JOIN LATERAL resolve_review_subject(s.kind, s.exam_id, s.subject_id, s.version) res
         ORDER BY res.category, res.language, res.exam_id
      LOOP
        json := jsonb_build_object(
          'eventId',              (substr(a.key,1,8)||'-'||substr(a.key,9,4)||'-'||substr(a.key,13,4)||'-'||substr(a.key,17,4)||'-'||substr(a.key,21,12))::uuid,
          'reviewerId',           v_reviewer_id,
          'reviewerName',         v_reviewer_name,
          'examId',               a.exam_id,
          'category',             a.category,
          'language',             a.language,
          'action',               'grant',
          'expectedAuthorityId',  NULL,
          'evidenceRef',          v_evidence_ref,
          'evidenceSha256',       v_evidence_sha,
          'rationale',            v_rationale);
        SELECT * INTO head FROM append_review_authority(json);
        granted_scopes := granted_scopes + 1;
      END LOOP;

      -- 2. THE DECISIONS. Every subject that currently projects `unreviewed` or `unavailable` gets an
      --    `approve`, with the subject identity and the required scope taken from the database. A
      --    subject already projecting `approved` is skipped: re-approving it would append a second,
      --    pointless revision. A subject projecting `rejected`/`withdrawn` is skipped too — this file
      --    must never overwrite an existing negative decision, and `form_review_allowed` will keep
      --    refusing it, which is the correct outcome.
      FOR d IN
        WITH subject AS (
          SELECT 'content'::text AS kind, NULL::text AS exam_id, c.content_version_id AS subject_id, ''::text AS version
            FROM content_version c
          UNION ALL
          SELECT 'blueprint', b.exam_id, b.exam_id, b.version FROM exam_blueprint b
          UNION ALL
          SELECT 'form', f.exam_id, f.form_id, f.version FROM exam_form f
        ), resolved AS (
          SELECT s.kind, s.subject_id, s.version,
                 (SELECT p.exam_id FROM resolve_review_subject(s.kind, s.exam_id, s.subject_id, s.version) p) AS exam_id,
                 (SELECT p.subject_sha256 FROM resolve_review_subject(s.kind, s.exam_id, s.subject_id, s.version) p) AS subject_sha256,
                 (SELECT p.category FROM resolve_review_subject(s.kind, s.exam_id, s.subject_id, s.version) p) AS category,
                 (SELECT p.language FROM resolve_review_subject(s.kind, s.exam_id, s.subject_id, s.version) p) AS language
            FROM subject s
        )
        SELECT v.kind, v.subject_id, v.version, v.exam_id, v.subject_sha256, v.category, v.language,
               (SELECT p.review_status FROM project_content_review(v.kind, v.exam_id, v.subject_id, v.version) p) AS review_status,
               md5(v_event_ns || '/decision/' || v.kind || '/' || v.subject_id || '/' || v.version || '/'
                   || v.subject_sha256 || '/' || v.category || '/' || v.language) AS key
          FROM resolved v
      LOOP
        IF d.exam_id IS NULL OR d.subject_sha256 IS NULL THEN
          -- An unresolvable subject has no identity to approve. Fail rather than silently leave a hole.
          RAISE EXCEPTION 'review_subject_unavailable: % % %', d.kind, d.subject_id, d.version USING ERRCODE = '23514';
        END IF;
        CONTINUE WHEN d.review_status NOT IN ('unreviewed', 'unavailable');

        SELECT * INTO head FROM content_review_decision
         WHERE exam_id = d.exam_id AND subject_kind = d.kind AND subject_id = d.subject_id
           AND subject_version = d.version AND subject_sha256 = d.subject_sha256
           AND category = d.category AND language = d.language
         ORDER BY revision DESC LIMIT 1;

        json := jsonb_build_object(
          'eventId',              (substr(d.key,1,8)||'-'||substr(d.key,9,4)||'-'||substr(d.key,13,4)||'-'||substr(d.key,17,4)||'-'||substr(d.key,21,12))::uuid,
          'subject',              jsonb_build_object('kind', d.kind, 'examId', d.exam_id, 'subjectId', d.subject_id,
                                                     'version', d.version, 'sha256', d.subject_sha256),
          'category',             d.category,
          'language',             d.language,
          'authorityId',          (SELECT auth.authority_id FROM content_review_authority auth
                                    WHERE auth.reviewer_id = v_reviewer_id AND auth.exam_id = d.exam_id
                                      AND auth.category = d.category AND auth.language = d.language
                                    ORDER BY auth.revision DESC LIMIT 1),
          'expectedDecisionId',   head.decision_id,
          'decision',             'approve',
          'evidenceRef',          v_evidence_ref,
          'evidenceSha256',       v_evidence_sha,
          'rationale',            v_rationale);
        IF json->>'authorityId' IS NULL THEN
          RAISE EXCEPTION 'review_authority_unavailable: % %', d.exam_id, d.category USING ERRCODE = '23514';
        END IF;
        SELECT * INTO head FROM append_content_review(json);
        decided_count := decided_count + 1;
      END LOOP;

      -- 3. THE TWO TRANSLATION TABLES. 0042 created them with their own status column, deliberately
      --    outside the 0035 state machine, and its CHECK requires an `approved` row to carry BOTH a
      --    reviewer and a `reviewed_at`. They are set together, from the same constants as above.
      --    `reviewed_at` is the instruction time rather than `now()`: the decision was made on
      --    5 October 2026, and a re-apply must not rewrite a recorded review time. Rows that are
      --    already `approved` (by this file on an earlier apply, or by anyone else) are left alone.
      UPDATE guide_translation
         SET review_status = 'approved', reviewer = v_reviewer_name, reviewed_at = v_instructed_at
       WHERE review_status = 'machine_unreviewed';
      UPDATE noun_translation
         SET review_status = 'approved', reviewer = v_reviewer_name, reviewed_at = v_instructed_at
       WHERE review_status = 'machine_unreviewed';

      -- 4. THE PROJECTION IS LEFT CORRECT, OR THE MIGRATION FAILS. The state machine is the record;
      --    the projection is what the runtime reads, so the two are re-checked here before the
      --    transaction is allowed to commit.
      IF EXISTS (SELECT 1 FROM content_version c CROSS JOIN LATERAL effective_content_review(c.content_version_id) p
                  WHERE p.review_status <> 'approved' OR p.blocked) THEN
        RAISE EXCEPTION 'review_owner_approval_incomplete: content_version projection' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM exam_blueprint b CROSS JOIN LATERAL effective_format_review(b.exam_id,'blueprint',b.exam_id,b.version) p
                  WHERE p.review_status <> 'approved' OR p.blocked) THEN
        RAISE EXCEPTION 'review_owner_approval_incomplete: exam_blueprint projection' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM exam_form f CROSS JOIN LATERAL effective_format_review(f.exam_id,'form',f.form_id,f.version) p
                  WHERE p.review_status <> 'approved' OR p.blocked) THEN
        RAISE EXCEPTION 'review_owner_approval_incomplete: exam_form projection' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM guide_translation t WHERE t.review_status <> 'approved' OR t.reviewer IS NULL OR t.reviewed_at IS NULL) THEN
        RAISE EXCEPTION 'review_owner_approval_incomplete: guide_translation' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM noun_translation t WHERE t.review_status <> 'approved' OR t.reviewer IS NULL OR t.reviewed_at IS NULL) THEN
        RAISE EXCEPTION 'review_owner_approval_incomplete: noun_translation' USING ERRCODE = '23514';
      END IF;

      RAISE NOTICE 'review owner approval: % decision(s) recorded, % authority scope(s) held, evidence sha256 %',
        decided_count, granted_scopes, v_evidence_sha;
    END
    $review_owner_approval$;
