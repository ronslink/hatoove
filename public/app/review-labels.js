import { getLocale } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';
/** Display only the server's review facts; labels never grant access. */
export function contentReviewLabel(value = {}, locale = getLocale()) {
  const key = value.review_withdrawn || value.review_status === 'withdrawn' ? 'reviewWithdrawn'
    : value.review_status === 'rejected' ? 'reviewRejected'
    : value.review_status === 'approved' && value.review_basis === 'named_decision' ? 'reviewApproved'
    : value.review_status === 'approved' && value.review_basis === 'legacy_unattributed' ? 'reviewLegacy'
    : ['unreviewed', 'generated', 'draft'].includes(value.review_status) ? 'reviewPending' : 'reviewUnknown';
  return pt(key, {}, locale);
}
export function reviewHistoryNotice(value = {}, locale = getLocale()) {
  return value.review_withdrawn ? pt('reviewHistory', {}, locale) : '';
}
