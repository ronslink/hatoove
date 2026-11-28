/**
 * Exact-SHA human review approvals for telc Deutsch B2 (26 subjects):
 *   - Listening (HV1–HV3 + 11 audio recordings), reading & language elements (LV1–LV3, SB1–SB2),
 *     writing tasks (A/B), rubric (writing.telc-b2@v1), blueprint v2 and 3 forms — approved 28 Nov 2026.
 *
 * Recorded through the 0035 named-review ledger (`append_review_authority` / `append_content_review`).
 * Scoped strictly to the exact hashes below; any future edited version remains unreviewed until separately approved.
 */
import { createHash } from 'node:crypto';
import { recordReviewerAuthority, recordContentReview } from './content-review.mjs';

const EXAM_ID = 'telc-deutsch-b2';
const INSTRUCTION = 'Ron (product owner), 28 November 2026: reviewed and approved telc Deutsch B2 complete written package v2 (LV1-LV3, SB1-SB2, HV1-HV3 and 11 audio recordings, writing tasks A/B, rubric writing.telc-b2@v1, blueprint v2 and forms).';

export const TELC_B2_APPROVAL_META = Object.freeze({
  examId: EXAM_ID,
  reviewerId: 'ron-product-owner',
  reviewerName: 'Ron (product owner)',
  evidenceRef: 'instruction://ron-product-owner/2026-11-28/telc-b2-complete-approved',
  evidenceSha256: createHash('sha256').update(INSTRUCTION, 'utf8').digest('hex'),
  rationale: INSTRUCTION,
  eventNamespace: 'telc-b2-complete-approval/2026-11-28',
});

export const TELC_B2_APPROVED_SUBJECTS = Object.freeze([
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv1.01.audio@v1', version: '', sha256: '2de4affad8e5ae3b4ca3473f01dd2c3b4da1a9768ee0eb86df10af188553d886', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv1.02.audio@v1', version: '', sha256: 'e7e988f59270213017283b66ec8d2408b168f3cd925ecff4cb2e0257c7b4095d', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv1.03.audio@v1', version: '', sha256: 'e47400b1c3a9c97ba58023efd3461af611184a0100c4e63a6d1c6e764e114c2b', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv1.04.audio@v1', version: '', sha256: 'e139b260f90370fbe375e2f2f5e9a51f92eb2dce647d47ca576b6117b11650fc', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv1.05.audio@v1', version: '', sha256: '220abaa33dbd997539b9b008fdad1fb772309cb9fbe8e72a629131854eaff2e9', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv2.01.audio@v1', version: '', sha256: '5821e4c53e00cbc5dcd8931eececff2e092578aef70272d4a9e855ee8d6d8a24', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv3.01.audio@v1', version: '', sha256: '73f675f1f7f3637e5eab9ae40291a7553c33c937ca4d9f95f0629d07dd0133fc', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv3.02.audio@v1', version: '', sha256: 'd74a52a5395791e457b247a706fac88d062f202beb2d025d8412581f6e202aa4', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv3.03.audio@v1', version: '', sha256: '430920b1e59ef2ab79569162e65aceaa9e131e74b07218e63a46134466253544', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv3.04.audio@v1', version: '', sha256: '61239802a788c794634891b716d229668067c3d9e46756db3ea6dd0f52857677', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv3.05.audio@v1', version: '', sha256: '5af4e50f4c198dc9b5ad90165df7db0315475ba5881f1f291c5f26c985e6fc3a', category: 'audio', language: 'de' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.lv1.original01@v1', version: '', sha256: '9df218d01d94aeebc4368c63c94e5e96acef13594a68f7af46f51b71e061be73', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.lv2.original01@v1', version: '', sha256: '65e9d557e28e58ea37aad65e870bc2ac1fcc78063b7a4387584835729cd16f61', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.lv3.original01@v1', version: '', sha256: '04c86f329b15259a5d9ac014b3291fe07f7afc773c04597cb7d1ab4b8709be4f', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.sb1.original01@v1', version: '', sha256: '4d22faf58310bc5a61b173d512720a0a788b6906891788a141bc0173b329fc70', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.sb2.original01@v1', version: '', sha256: '4b92537c433c262ea4dd8b4f3110536166091b992917db5466e651a0ad986ebf', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv1.original01@v1', version: '', sha256: 'e781ad456e7d044d8bfd4d38bbce9a9b5c8ea9c6e05ceb9a6ac8b448465f2bc7', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv2.original01@v1', version: '', sha256: '7e808974e594d309d4e056f40663942e9d08fd2fd9daefbb83cb45ba16351b70', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.hv3.original01@v1', version: '', sha256: 'a4a32a50adab0b66437c5d0a05ff8d87d3929f62f4ecc54206aaf651fb998fbd', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.writing.original01.a@v1', version: '', sha256: '12c01c5fbfcf87c2ffe1547cbc9f31ff25f1218cb45c7e09a52067b5caa5fe6a', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'telc-deutsch-b2.writing.original01.b@v1', version: '', sha256: 'ac83bfd66375e03a82f56bb8b9cf0cd38da17130e2a8d575bbb70548186dba4c', category: 'educational', language: '' }),
  Object.freeze({ kind: 'content', id: 'writing.telc-b2@v1', version: '', sha256: '29f9026de9019df77eb9a8bfc0a6b5fc0f4e9d582fab2a9721fa93c8f8a6beeb', category: 'educational', language: '' }),
  Object.freeze({ kind: 'blueprint', id: 'telc-deutsch-b2', version: 'v2', sha256: '34b4f0a925e075a84c67bd95188550ec532ed504edbdbf7d19b7b20e8e8aabd6', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'telc-deutsch-b2.complete.original01', version: 'v1', sha256: '3ce218983ace740967c94893f2d5198cd13e112d76f53290141765c070101f31', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'telc-deutsch-b2.listening.practice', version: 'v1', sha256: '572cfbcc298603ee5ac8af90f772f99f6544e2ccb3ac0ddd91a82217850444a8', category: 'exam_format', language: '' }),
  Object.freeze({ kind: 'form', id: 'telc-deutsch-b2.listening.mock', version: 'v1', sha256: 'b92d5daf253b0dc75b38e76ba18a8f32903fd8fdc2857c39d67f9aa91b6b6854', category: 'exam_format', language: '' }),
]);

export function deterministicTelcB2EventUuid(key, namespace = TELC_B2_APPROVAL_META.eventNamespace) {
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

export async function applyTelcB2ApprovedReviews(pool, options = {}) {
  const client = await pool.connect();
  let begun = false;
  let approved = 0;
  let skipped = 0;
  const meta = TELC_B2_APPROVAL_META;
  try {
    await client.query('BEGIN');
    begun = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7353))', [EXAM_ID]);

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
          eventId: deterministicTelcB2EventUuid(`authority/${scope.category}/${scope.language}`, meta.eventNamespace),
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

    for (const item of TELC_B2_APPROVED_SUBJECTS) {
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
        eventId: deterministicTelcB2EventUuid(`decision/${item.kind}/${item.id}/${item.version}/${item.sha256}`, meta.eventNamespace),
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
    return { approved, skipped, total: TELC_B2_APPROVED_SUBJECTS.length };
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
