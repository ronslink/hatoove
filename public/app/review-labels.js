/** Display only the server's review facts; labels never grant access. */
export function contentReviewLabel(value = {}) {
  if (value.review_withdrawn || value.review_status === 'withdrawn') return 'Fachliche Freigabe zurückgezogen';
  if (value.review_status === 'rejected') return 'Fachliche Prüfung: abgelehnt';
  if (value.review_status === 'approved' && value.review_basis === 'named_decision') return 'Fachlich freigegeben';
  if (value.review_status === 'approved' && value.review_basis === 'legacy_unattributed') return 'Altbestand: Freigabe ohne zugeordnete Fachprüfung';
  if (['unreviewed', 'generated', 'draft'].includes(value.review_status)) return 'Fachliche Prüfung ausstehend';
  return 'Prüfstatus nicht angegeben';
}

export function reviewHistoryNotice(value = {}) {
  return value.review_withdrawn ? 'Die fachliche Freigabe dieser Inhalte wurde zurückgezogen. Dein gespeichertes Ergebnis bleibt unverändert. Weitere Bearbeitung ist gesperrt.' : '';
}
