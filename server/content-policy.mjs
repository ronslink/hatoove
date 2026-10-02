/** Deployment policy for new content. Unknown provenance can never be opted in. */
export function contentPolicy(env = process.env) {
  const known = new Set(['generated', 'licensed', 'commissioned']);
  const configured = env.B1PREP_SERVE_RIGHTS === undefined ? 'generated' : String(env.B1PREP_SERVE_RIGHTS);
  return {
    review: String(env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
      ? ['approved'] : ['approved', 'unreviewed'],
    rights: [...new Set(configured.split(/[,+\s]+/).filter((value) => known.has(value)))],
  };
}

export function contentIsServable(row, policy = contentPolicy()) {
  return Boolean(row && policy.review.includes(row.review_status) && policy.rights.includes(row.rights_status));
}
