/**
 * THE ONE SERVER-OWNED CONTENT POLICY (EXAM-S0).
 *
 * `B1PREP_CONTENT_MODE` decides which review statuses a deployment may offer for NEW use:
 *   * `public` (the default when unset): approved content only. The legacy `B1PREP_SERVE_REVIEW` flag can
 *     narrow nothing further and can never widen it — a public deployment does not serve unreviewed content
 *     because an older variable asked for it;
 *   * `internal-preview`: explicitly retains the generated/unreviewed pilot policy (and its provisional
 *     labels, which travel on every row as `review_status`). `B1PREP_SERVE_REVIEW=approved` still narrows;
 *   * anything else FAILS CLOSED: no review status is servable, so a typo serves nothing rather than
 *     everything.
 *
 * Rights are unchanged in both modes. Unknown provenance can never be opted in.
 *
 * Only the environment decides. Adapter options and request parameters may narrow a result; they are never
 * an input here, so they cannot widen what the deployment serves.
 */
export const CONTENT_MODES = Object.freeze(['public', 'internal-preview']);

/** @returns {'public'|'internal-preview'|null} null for an unknown mode, which the policy fails closed on. */
export function contentMode(env = process.env) {
  const raw = env.B1PREP_CONTENT_MODE;
  if (raw === undefined || String(raw).trim() === '') return 'public';
  const value = String(raw).trim();
  return CONTENT_MODES.includes(value) ? value : null;
}

export function contentPolicy(env = process.env) {
  const known = new Set(['generated', 'licensed', 'commissioned']);
  const configured = env.B1PREP_SERVE_RIGHTS === undefined ? 'generated' : String(env.B1PREP_SERVE_RIGHTS);
  const mode = contentMode(env);
  const narrowed = String(env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved';
  let review;
  if (mode === null) review = [];
  else if (mode === 'public' || narrowed) review = ['approved'];
  else review = ['approved', 'unreviewed'];
  return {
    mode: mode ?? 'invalid',
    review,
    rights: mode === null ? [] : [...new Set(configured.split(/[,+\s]+/).filter((value) => known.has(value)))],
  };
}

/**
 * The review statuses a caller may query: the deployment's, optionally narrowed to `approved`. Any other
 * `serveReview` value is ignored rather than honoured, so an option cannot widen the policy.
 */
export function servableReview(serveReview, policy = contentPolicy()) {
  return serveReview === 'approved' ? policy.review.filter((status) => status === 'approved') : [...policy.review];
}

export function contentIsServable(row, policy = contentPolicy()) {
  return Boolean(row && policy.review.includes(row.review_status) && policy.rights.includes(row.rights_status));
}
