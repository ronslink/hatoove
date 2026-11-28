/**
 * Exact-SHA human review approvals for Goethe-Zertifikat B1 (24 subjects):
 *   - Listening (HV1–HV4 + 8 audio recordings), reading (LV1–LV5), writing tasks (A/B),
 *     writing rubric (writing.goethe-b1@v1), blueprint v2 and 3 forms — approved 28 Nov 2026.
 *
 * Recorded through the 0035 named-review ledger (`append_review_authority` / `append_content_review`).
 * Scoped strictly to the exact hashes below; any future edited version remains unreviewed until separately approved.
 */
import { createHash } from 'node:crypto';
import { recordReviewerAuthority, recordContentReview } from './content-review.mjs';

const EXAM_ID = 'goethe-zertifikat-b1';
const INSTRUCTION = 'Ron (product owner), 28 November 2026: reviewed and approved Goethe-Zertifikat B1 complete written package v2 (LV1-LV5 reading, HV1-HV4 listening and 8 audio recordings, writing tasks A/B, rubric writing.goethe-b1@v1, blueprint v2 and forms).';

export const GOETHE_B1_APPROVAL_META = Object.freeze({
  examId: EXAM_ID,
  reviewerId: 'ron-product-owner',
  reviewerName: 'Ron (product owner)',
  evidenceRef: 'instruction://ron-product-owner/2026-11-28/goethe-b1-complete-approved',
  evidenceSha256: createHash('sha256').update(INSTRUCTION, 'utf8').digest('hex'),
  rationale: INSTRUCTION,
  eventNamespace: 'goethe-b1-complete-approval/2026-11-28',
});

export const GOETHE_B1_APPROVED_SUBJECTS = Object.freeze([
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv1.01.audio@v1', version: '', sha256: '759d9e9ae34334481b5969b471104d7d22bf200efaa9dce9834067b8d552457e', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv1.02.audio@v1', version: '', sha256: '733302a85cc5017e9af39597c9858324e40f0753c508e1512eb64edc5e316d18', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv1.03.audio@v1', version: '', sha256: '55447534d3775b64f6c7b8965924a6ac7854d1f748bd7f455dd95a1a0f963639', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv1.04.audio@v1', version: '', sha256: '33bbb47e28a7c152b992b5579f3e8281848962f4e104e900d5e20b96851e90fb', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv1.05.audio@v1', version: '', sha256: 'ee4621a33180dd3d3cf1fe471f2a8e99da16aeee483d9c35b68b025fedfc8e0c', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv2.01.audio@v1', version: '', sha256: '4543cf402eb64ff41fd0c0ef9661fc1517df3b9e0124c99812dac572b83c6080', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv3.01.audio@v1', version: '', sha256: 'ffd2eddcd3ebb833a96d7bcdf64c1a43f91f8c4446e6f46412c3a61f5d76ab19', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv4.01.audio@v1', version: '', sha256: '88ae4f92794c60be972011d0a24349cd82b2aa4fafebf281d3726a3677459d8e', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.lv1.original01@v1', version: '', sha256: '0d30e82ce27c074118a49e0c379cc2b558b83e9ddb33e318cd97cb3887c0a1b6', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.lv2.original01@v1', version: '', sha256: '809a6c5fcad74204232904f197042698d46d23c14142f40007bd509fe1a3b09c', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.lv3.original01@v1', version: '', sha256: '289ea4c29da9d7d064b2510a85a1f091e2c3b1d419bd533b08d95573760f6f21', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.lv4.original01@v1', version: '', sha256: '791a60a1476b161d4d1b2483a586ce1fc71d6e8b4eacf13c1e772146364511a7', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.lv5.original01@v1', version: '', sha256: '08d06c9e82e8e57164b0569b32064ce2eebed1b7219ef6fc9b4a2d15c79ba35b', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv1.original01@v1', version: '', sha256: '382331732e791a681789277fea29070801a10431a705b6478f7f1ad202593a8e', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv2.original01@v1', version: '', sha256: '66934d8099477f9d65be7a73a33250416245ebf65da988957a2cde3353d2b9e4', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv3.original01@v1', version: '', sha256: '23e3ad806f5788778d92952ea70a2a5c67eb7a5531a519a53a57f786af967a64', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.hv4.original01@v1', version: '', sha256: 'cfe7e58661a7dab5f2a54a72287995d586447ec24c2b1f037acafa424636153d', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.writing.original01.a@v1', version: '', sha256: 'c0dceb7fe59caae03978bd6374a3159e3d4a42c840298a8774ed8820cd8ebbe5', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'goethe-zertifikat-b1.writing.original01.b@v1', version: '', sha256: '32bebce377f951f039c8bb3c403faeadad1214de2810e3dba41481b0851ffa7a', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'writing.goethe-b1@v1', version: '', sha256: 'a28c3b736ca680ff8a983055356ab719182c06d1ba6d1f095e0bc63bf5c6cdf0', category: 'educational', language: '' }),
  Object.freeze({ kind: 'blueprint', id: 'goethe-zertifikat-b1', version: 'v2', sha256: '05eb4179cbcd015fd56e1e9bf4a5cea7d43da56cc2b9d4736879803998c8d703', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'goethe-zertifikat-b1.complete.original01', version: 'v1', sha256: 'ea88499cd6cef94bd3713ad6094818c5dd8c1a0d13f7562175898f9015ff1c40', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'goethe-zertifikat-b1.listening.practice', version: 'v1', sha256: 'd29ea1ecef6042c9d24953a9edadca7b7bfd2fd059ab4f6fe5e901d5ffb20081', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'goethe-zertifikat-b1.listening.mock', version: 'v1', sha256: '047e80057a7baf8bbf47448512f30c85a2f9980699d4085289ce5e5344946755', category: 'exam_format', language: '' }),
]);

export function deterministicGoetheB1EventUuid(key, namespace = GOETHE_B1_APPROVAL_META.eventNamespace) {
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
 * Idempotently record Ron's 28 November 2026 exact-SHA approvals for Goethe-Zertifikat B1
 * on a migration-role pool. Never approves mismatched hashes and never overwrites a later decision.
 */
export async function applyGoetheB1ApprovedReviews(pool, options = {}) {
  const client = await pool.connect();
  let begun = false;
  let approved = 0;
  let skipped = 0;
  const meta = GOETHE_B1_APPROVAL_META;
  try {
    await client.query('BEGIN');
    begun = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7352))', [EXAM_ID]);

    const authorities = new Map();
    for (const scope of [
      { category: 'educational', language: '' },
      { category: 'audio', language: 'de' },
      { category: 'exam_format', language: '' },
    ]) {
      const head = (await client.query(
        `SELECT authority_id, action FROM content_review_authority
          WHERE reviewer_id = $1 AND exam_id = $2 AND category = $3 AND language = $4
          ORDER BY revision DESC LIMIT 1`,
        [meta.reviewerId, EXAM_ID, scope.category, scope.language]
      )).rows[0];
      if (head?.action === 'grant') {
        authorities.set(`${scope.category}:${scope.language}`, head.authority_id);
      } else {
        const receipt = await recordReviewerAuthority(client, {
          eventId: deterministicGoetheB1EventUuid(`authority/${scope.category}/${scope.language}`, meta.eventNamespace),
          reviewerId: meta.reviewerId,
          reviewerName: meta.reviewerName,
          examId: EXAM_ID,
          category: scope.category,
          language: scope.language,
          action: 'grant',
          expectedAuthorityId: head?.authority_id ?? null,
          evidenceRef: meta.evidenceRef,
          evidenceSha256: meta.evidenceSha256,
          rationale: meta.rationale,
        });
        authorities.set(`${scope.category}:${scope.language}`, receipt.authorityId);
      }
    }

    for (const item of GOETHE_B1_APPROVED_SUBJECTS) {
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
        eventId: deterministicGoetheB1EventUuid(`decision/${item.kind}/${item.id}/${item.version}/${item.sha256}`, meta.eventNamespace),
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

    await client.query('COMMIT');
    return { approved, skipped, total: GOETHE_B1_APPROVED_SUBJECTS.length };
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
