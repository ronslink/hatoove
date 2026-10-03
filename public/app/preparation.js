/** In-memory presentation decisions only. The server owns preparations and availability. */
export function preparationChoices(exams, preparations) {
  return [
    ...preparations.map(preparation => ({ id: preparation.id, isNew: false,
      label: (preparation.exam || preparation.exam_id) + (preparation.state === 'archived' ? ' · Archiv ansehen' : ' · Fortsetzen') })),
    ...exams.filter(exam => !preparations.some(preparation => preparation.exam_id === exam.exam_id && preparation.state === 'active'))
      .map(exam => ({ id: 'new:' + exam.exam_id, isNew: true, label: (exam.exam || exam.exam_id) + ' · Beginnen' })),
  ];
}

export function initialPreparation(exams, preparations) {
  // Provisioning a default preparation is not a learner's choice between offered exams.
  // Explicit preparation/run URLs are resolved by the shell before this first-entry decision.
  if (exams.length > 1) return { kind: 'choose' };
  const active = preparations.filter(preparation => preparation.state === 'active');
  if (active.length === 1) return { kind: 'select', preparation: active[0] };
  if (preparations.length === 1) return { kind: 'select', preparation: preparations[0] };
  if (preparations.length === 0 && exams.length === 1) return { kind: 'create', examId: exams[0].exam_id };
  return { kind: 'choose' };
}
