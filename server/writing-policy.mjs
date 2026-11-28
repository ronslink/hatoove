/** Versioned writing policy registry. Imported rubrics cannot introduce executable policy. */
export const DTZ_POLICY = 'dtz-writing-practice-v1';
export const DTZ_KIND = 'dtz-writing-bands';
export const DTZ_KEYS = Object.freeze(['dtz_aufgabe','dtz_kommunikation','dtz_korrektheit','dtz_wortschatz']);
export const DTZ_BANDS = Object.freeze({B1_PLUS:5,B1:4,A2_PLUS:3,A2:2,A1:1,ZERO:0});
export const DTZ_INSTRUCTIONS = 'Assess each criterion against its own bound descriptors. No total or overall level. No minimum word count or universal formal address rule. Text with no meaningful relation to the selected prompt receives ZERO in all four criteria.';

export const GOETHE_B1_POLICY = 'goethe-b1-writing-practice-v1';
export const GOETHE_B1_KIND = 'goethe-b1-writing-bands';
export const GOETHE_B1_KEYS = Object.freeze(['goethe_erfuellung','goethe_kohaerenz','goethe_wortschatz','goethe_strukturen']);
export const GOETHE_B1_BANDS = Object.freeze({A:4,B:3,C:2,D:1,E:0});
export const GOETHE_B1_INSTRUCTIONS = 'Assess each criterion against its own bound Goethe-Zertifikat B1 descriptors (A to E). No total score or pass/fail prediction. Text with no meaningful relation to the selected prompt receives E in all four criteria.';

export function supportedWritingPolicy(rubric, examId) {
  if (rubric?.policy === DTZ_POLICY && examId === 'dtz-a2-b1' && rubric.feedback_kind === DTZ_KIND) {
    return Array.isArray(rubric.criteria) && rubric.criteria.length === 4
      && DTZ_KEYS.every(key => rubric.criteria.some(c => c.key === key));
  }
  if (rubric?.policy === GOETHE_B1_POLICY && examId === 'goethe-zertifikat-b1' && rubric.feedback_kind === GOETHE_B1_KIND) {
    return Array.isArray(rubric.criteria) && rubric.criteria.length === 4
      && GOETHE_B1_KEYS.every(key => rubric.criteria.some(c => c.key === key));
  }
  return false;
}
