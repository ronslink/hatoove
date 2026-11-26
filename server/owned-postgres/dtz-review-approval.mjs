/**
 * Exact-SHA human review approvals for DTZ A2–B1:
 *   1. Listening (HV1–HV4 + 16 recordings) and reading (LV1–LV5) — 25 content subjects, approved 26 Nov 2026.
 *   2. Writing tasks (A/B), writing rubric, blueprint v4 and 3 forms — 7 subjects, approved 26 Nov 2026.
 *
 * Recorded through the 0035 named-review ledger (`append_review_authority` / `append_content_review`).
 * Scoped strictly to the exact hashes below; any future edited version remains unreviewed until separately approved.
 */
import { createHash } from 'node:crypto';
import { recordReviewerAuthority, recordContentReview } from './content-review.mjs';

const EXAM_ID = 'dtz-a2-b1';
const INSTRUCTION_LR = 'Ron (product owner), 26 November 2026: reviewed and approved DTZ A2-B1 listening (HV1-HV4 and 16 audio recordings) and reading (LV1-LV5). DTZ writing, rubric, blueprint and forms remain unreviewed.';
const INSTRUCTION_WF = 'Ron (product owner), 26 November 2026: reviewed and approved DTZ A2-B1 writing tasks (A/B), writing rubric (writing.dtz-a2-b1@v1), blueprint v4 and forms (complete written mock, listening practice and listening mock).';

export const DTZ_APPROVAL_META = Object.freeze({
  examId: EXAM_ID,
  reviewerId: 'ron-product-owner',
  reviewerName: 'Ron (product owner)',
  evidenceRef: 'instruction://ron-product-owner/2026-11-26/dtz-listening-reading-approved',
  evidenceSha256: createHash('sha256').update(INSTRUCTION_LR, 'utf8').digest('hex'),
  rationale: INSTRUCTION_LR,
  eventNamespace: 'dtz-listening-reading-approval/2026-11-26',
});

export const DTZ_WRITING_FORMAT_APPROVAL_META = Object.freeze({
  examId: EXAM_ID,
  reviewerId: 'ron-product-owner',
  reviewerName: 'Ron (product owner)',
  evidenceRef: 'instruction://ron-product-owner/2026-11-26/dtz-writing-format-approved',
  evidenceSha256: createHash('sha256').update(INSTRUCTION_WF, 'utf8').digest('hex'),
  rationale: INSTRUCTION_WF,
  eventNamespace: 'dtz-writing-format-approval/2026-11-26',
});

export const DTZ_APPROVED_SUBJECTS = Object.freeze([
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv1.01.audio@v1', version: '', sha256: '76bf6e684d8900a1a281869a7bce9a6ee56be96e4a2d1638bc815f05b3831e4a', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv1.02.audio@v1', version: '', sha256: '26a606785394e1f4724fda2fc8a9f1cae58ce3823b6936b276c81a35f99a9e8d', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv1.03.audio@v1', version: '', sha256: '340e3e71051a1e723728bd13cd72de5aecfdd18c4859965238c1cb41717de0ef', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv1.04.audio@v1', version: '', sha256: '094408a0ccf0c24ffab290160688d463a74afbc7524b42f082fcbfef11972699', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv1.original01@v1', version: '', sha256: 'b4998f92df948c9c39e5c0afc199650732680c9aa974cc772627f3957a22a319', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv2.01.audio@v1', version: '', sha256: 'ec8e520e7fde708fe4427e60f9659c3ad7d8d14dd0b3be0ba73a189bd9fda5b9', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv2.02.audio@v1', version: '', sha256: '5442a9ff9a5e3ea3f752211dae9e3924caa3ee291abfbd1eb70636e54e2ea95c', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv2.03.audio@v1', version: '', sha256: '0c42f6cc05bbe627c9700955a24d7caceb9cf49ab95a21e0e4d8744153b26df5', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv2.04.audio@v1', version: '', sha256: 'bca4a445421508ff8a9a0626c22dd31e1cd6be942175b64630ecee9eab0997a5', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv2.05.audio@v1', version: '', sha256: '6093bcfab1a81c5c4acac0d4c26fa29690e5873bdee741533f0654b7eff66a5f', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv2.original01@v1', version: '', sha256: 'f2d1dd39ba1023e667047abc052c4a4f2d43817a42b490c1709950212257f5b2', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv3.01.audio@v1', version: '', sha256: '2450ed2d0199330c60e61e9074427598f42e67990b991adbd3a40b6a9b52b950', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv3.02.audio@v1', version: '', sha256: '831e7813c4a7d9ff4d19da5c1e396f28a4dd8387c1e620154e7f4af844265b34', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv3.03.audio@v1', version: '', sha256: '7439b3085499f3eba09a44da88f6c292ab3702a85c728dffde75360e088f7d8e', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv3.04.audio@v1', version: '', sha256: '7cf46e73824c02841c485e8f019d00d7cd585ec0015d8119a02caf058fbab089', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv3.original01@v1', version: '', sha256: 'a90339f5ab2e9a940aeaa1766f596235d2987268fe30156b663d2183306e71b0', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv4.01.audio@v1', version: '', sha256: '1534443f68e611bc916baf4da068bd424bc70fb7234568b77330ed289b0589df', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv4.02.audio@v1', version: '', sha256: '65d770cdcc5f494326615eb80b07d4506f757d1d782465a7d0afe8694ac3d21d', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv4.03.audio@v1', version: '', sha256: 'a04b337bd873183deb3f5bcd809e49a6f7e51792942fcfe1dc0d9285c8f79123', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.hv4.original01@v1', version: '', sha256: 'c1551b1250c83e2c6c7fac8b3cccab2bcc9d4b6251da44099b23ac35c705ea7e', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.lv1.original01@v1', version: '', sha256: '0e0fe88ec08d05ea3ec5dbf7389261af10668e79e111a9c7c88da97b650ec950', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.lv2.original01@v1', version: '', sha256: 'f1c0eb82873bd89c701e40b45a27b92114d05c44a63ce85754aa66a74014f86f', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.lv3.original01@v1', version: '', sha256: 'cecc310e157360119ba1697bd38811a17c87fa078c38f516adc916e1afbf0477', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.lv4.original01@v1', version: '', sha256: 'f486da75913cdb21dbd1c96dfad9a911f85a6de92f5cd407c41ee9d3072e2e94', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.lv5.original01@v1', version: '', sha256: 'c746f903ae85513e2dfb7c7344fbe27274cdd7234149cd92ef18d05d19fc61c6', category: 'educational', language: '' }),
]);

export const DTZ_APPROVED_WRITING_FORMAT_SUBJECTS = Object.freeze([
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.writing.original01.a@v1', version: '', sha256: '7cdef3657a70ea0644d8ce04510a5a43b8892fa399eee9732291263722f6c46b', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'dtz-a2-b1.writing.original01.b@v1', version: '', sha256: 'eaade6186637cc8affd053bf0864360c8e8802660ead64e63ab26121852f4fa0', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'writing.dtz-a2-b1@v1', version: '', sha256: '632120a4b03f6c2d207c5b00e0d8505266de3c7ec20df7193750871414c8eaaa', category: 'educational', language: '' }),
  Object.freeze({ kind: 'blueprint', id: 'dtz-a2-b1', version: 'v4', sha256: 'ccf6c5a16ade38e778d82f6f027446835e0808649b70bb38c11b32cdd9222bd6', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'dtz-a2-b1.complete.original01', version: 'v1', sha256: 'f29263a033b145decbb536fce60a98cb55f5f8e91459271809a48e5586f6e39c', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'dtz-a2-b1.listening.practice', version: 'v1', sha256: '50cff414a83395d5f36e547e5ef5e905ea2deaaff5db08e558cea10294cb8f47', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'dtz-a2-b1.listening.mock', version: 'v1', sha256: 'abbcec30d2d1e7919626ba66471e4f2118746b5624df068f22c516592bcad1fa', category: 'exam_format', language: '' }),
]);

export function deterministicEventUuid(key, namespace = DTZ_APPROVAL_META.eventNamespace) {
  const hex = createHash('sha256').update(`${namespace}/${key}`, 'utf8').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function storedSubjectSha(client, item) {
  if (item.kind === 'content') {
    const row = (await client.query(
      `SELECT content_sha256 AS sha256 FROM content_version WHERE content_version_id = $1 AND exam_id = $2`,
      [item.id, EXAM_ID]
    )).rows[0];
    return row?.sha256 ?? null;
  }
  if (item.kind === 'blueprint') {
    const row = (await client.query(
      `SELECT sha256 FROM exam_blueprint WHERE exam_id = $1 AND version = $2`,
      [EXAM_ID, item.version]
    )).rows[0];
    return row?.sha256 ?? null;
  }
  if (item.kind === 'form') {
    const row = (await client.query(
      `SELECT sha256 FROM exam_form WHERE exam_id = $1 AND form_id = $2 AND version = $3`,
      [EXAM_ID, item.id, item.version]
    )).rows[0];
    return row?.sha256 ?? null;
  }
  return null;
}

/**
 * Idempotently record Ron's 26 November 2026 exact-SHA approvals for DTZ listening, reading,
 * writing, rubric, blueprint v4 and forms on a migration-role pool. Never approves mismatched
 * hashes and never overwrites a later human decision.
 */
export async function applyDtzApprovedReviews(pool, options = {}) {
  const client = await pool.connect();
  let begun = false;
  let approved = 0;
  let skipped = 0;
  const batches = [
    { meta: DTZ_APPROVAL_META, subjects: DTZ_APPROVED_SUBJECTS },
    { meta: DTZ_WRITING_FORMAT_APPROVAL_META, subjects: DTZ_APPROVED_WRITING_FORMAT_SUBJECTS },
  ];
  try {
    await client.query('BEGIN');
    begun = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7351))', [EXAM_ID]);

    const authorities = new Map();
    for (const scope of [
      { category: 'educational', language: '', meta: DTZ_APPROVAL_META },
      { category: 'audio', language: 'de', meta: DTZ_APPROVAL_META },
      { category: 'exam_format', language: '', meta: DTZ_WRITING_FORMAT_APPROVAL_META },
    ]) {
      const head = (await client.query(
        `SELECT authority_id, action FROM content_review_authority
          WHERE reviewer_id = $1 AND exam_id = $2 AND category = $3 AND language = $4
          ORDER BY revision DESC LIMIT 1`,
        [scope.meta.reviewerId, EXAM_ID, scope.category, scope.language]
      )).rows[0];
      if (head?.action === 'grant') {
        authorities.set(`${scope.category}:${scope.language}`, head.authority_id);
      } else {
        const receipt = await recordReviewerAuthority(client, {
          eventId: deterministicEventUuid(`authority/${scope.category}/${scope.language}`, scope.meta.eventNamespace),
          reviewerId: scope.meta.reviewerId,
          reviewerName: scope.meta.reviewerName,
          examId: EXAM_ID,
          category: scope.category,
          language: scope.language,
          action: 'grant',
          expectedAuthorityId: head?.authority_id ?? null,
          evidenceRef: scope.meta.evidenceRef,
          evidenceSha256: scope.meta.evidenceSha256,
          rationale: scope.meta.rationale,
        });
        authorities.set(`${scope.category}:${scope.language}`, receipt.authorityId);
      }
    }

    for (const { meta, subjects } of batches) {
      for (const item of subjects) {
        const actualSha = await storedSubjectSha(client, item);
        if (!actualSha || actualSha !== item.sha256) {
          skipped += 1;
          continue;
        }
        const existing = (await client.query(
          `SELECT decision_id FROM content_review_decision
            WHERE exam_id = $1 AND subject_kind = $2 AND subject_id = $3 AND subject_version = $4
              AND subject_sha256 = $5 AND category = $6 AND language = $7
            ORDER BY revision DESC LIMIT 1`,
          [EXAM_ID, item.kind, item.id, item.version, item.sha256, item.category, item.language]
        )).rows[0];
        if (existing) {
          skipped += 1;
          continue;
        }
        const authorityId = authorities.get(`${item.category}:${item.language}`);
        await recordContentReview(client, {
          eventId: deterministicEventUuid(`decision/${item.kind}/${item.id}/${item.version}/${item.sha256}`, meta.eventNamespace),
          subject: { kind: item.kind, examId: EXAM_ID, subjectId: item.id, version: item.version, sha256: item.sha256 },
          category: item.category,
          language: item.language,
          authorityId,
          expectedDecisionId: null,
          decision: 'approve',
          packetSha256: null,
          evidenceRef: meta.evidenceRef,
          evidenceSha256: meta.evidenceSha256,
          rationale: meta.rationale,
        }, options);
        approved += 1;
      }
    }

    await client.query('COMMIT');
    return { approved, skipped, total: DTZ_APPROVED_SUBJECTS.length + DTZ_APPROVED_WRITING_FORMAT_SUBJECTS.length };
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
